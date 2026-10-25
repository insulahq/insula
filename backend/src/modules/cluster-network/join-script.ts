/**
 * Renders the admin panel's node-join procedure: ONE line the operator runs on
 * the NEW node as root (plus, for a server, one read of the token on an
 * existing server). Pure string building — every cluster fact is resolved by the
 * caller (bootstrap-command.ts) and passed in.
 *
 * The line fetches scripts/join-node.sh from GitHub at the commit or tag this
 * platform-api was built from, checks it against the SHA-256 of the copy baked
 * into this image, and only then runs it. The script downloads the insula CLI of
 * the CLUSTER'S release (never `latest` — bootstrap pins k3s per release),
 * verifies its signature against the release key written into the script — the
 * key this cluster pins, platform/cosign.pub — installs it and runs
 * `insula bootstrap --join-as …`. So GitHub alone can swap neither the script
 * nor the binary: the hash comes from the cluster, and it covers the key.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BootstrapStep } from '@insula/api-contracts';
import { ApiError } from '../../shared/errors.js';
import { parseVersion } from '../platform-updates/poller/semver.js';
import { releaseTagFor } from '../../cli/platform-ops/self-upgrade/release-tag.js';

const DEFAULT_RELEASES_REPO = 'insulahq/insula';
/** GitHub owner (alnum + hyphen) / repo (never `.` or `..` — it lands in a URL path). */
const VALID_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
/** Same default + override the in-cluster version poller uses. */
const DEFAULT_COSIGN_PUB_PATH = '/app/platform/cosign.pub';
/** scripts/join-node.sh as baked into the platform-api image (Dockerfile). */
const DEFAULT_JOIN_NODE_SCRIPT_PATH = '/app/scripts/join-node.sh';
/** A git sha suffix on a DEV build stamp — release-tag.ts's rule. */
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const PEM_PUBLIC_KEY_RE =
  /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,76}\r?\n)+-----END PUBLIC KEY-----\s*$/;
const SERVER_TOKEN_PATH = '/var/lib/rancher/k3s/server/node-token';

export interface JoinRelease {
  /** The running platform version (PLATFORM_VERSION), e.g. 2026.10.2. */
  readonly version: string;
  /** The release tag that publishes the CLI for it, without the `v`. */
  readonly tag: string;
  /** owner/repo hosting the release assets. */
  readonly repo: string;
}

/**
 * Resolve which signed CLI release a joining node must install: the one the
 * cluster runs. A DEV build stamp (`2026.10.2-<sha>`) maps to its release tag
 * exactly as the node self-upgrade does. No guessing: an unknown version is
 * an operator-facing error, not a silent `latest`.
 */
export function resolveJoinRelease(env: NodeJS.ProcessEnv = process.env): JoinRelease {
  const version = (env.PLATFORM_VERSION ?? '').trim().replace(/^v/, '');
  if (!parseVersion(version)) {
    throw new ApiError(
      'PLATFORM_VERSION_UNKNOWN',
      `The platform-api does not know which release this cluster runs (PLATFORM_VERSION="${version || 'unset'}"), so it cannot pin the CLI a joining node must install.`,
      503,
      {
        operatorError: {
          code: 'PLATFORM_VERSION_UNKNOWN',
          title: 'Cluster version unknown',
          detail:
            'A joining node must install the insula CLI of the release the cluster runs — bootstrap pins k3s per ' +
            'release, so another version would install a different k3s. The platform-api has no valid ' +
            'PLATFORM_VERSION (normally injected from the platform-version ConfigMap).',
          remediation: [
            'Run `insula version` on an existing server and follow the multi-node guide with that exact release.',
            'Check that the platform-version ConfigMap exists and platform-api picked it up.',
          ],
          retryable: false,
        },
      },
    );
  }
  const requested = (env.PLATFORM_RELEASES_REPO ?? env.PLATFORM_OPS_REPO ?? DEFAULT_RELEASES_REPO).trim();
  const repo = VALID_REPO_RE.test(requested) ? requested : DEFAULT_RELEASES_REPO;
  return { version, tag: releaseTagFor(version), repo };
}

/** The release-signing public key the cluster pins, or null when it is not
 *  readable here (local dev). Shape-checked: it is embedded in shell. */
export function loadPinnedReleaseKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = (env.PLATFORM_COSIGN_PUB_PATH ?? DEFAULT_COSIGN_PUB_PATH).trim();
  try {
    const pem = readFileSync(path, 'utf8');
    return PEM_PUBLIC_KEY_RE.test(pem) ? pem : null;
  } catch {
    return null;
  }
}

/** scripts/join-node.sh, fetched by the join line and pinned by its hash. */
export interface JoinNodeScript {
  /** Raw GitHub URL at the commit or tag this platform-api was built from. */
  readonly url: string;
  readonly sha256: string;
}

/**
 * The git ref whose scripts/join-node.sh is byte-identical to this image's
 * copy: a DEV build stamp (`2026.10.2-<sha>`) names the commit it was built
 * from; anything else is a release, built from the tree its tag carries.
 */
export function joinNodeScriptRef(version: string): string {
  const parsed = parseVersion(version);
  const only = parsed?.prerelease.length === 1 ? (parsed.prerelease[0] ?? '') : '';
  return GIT_SHA_RE.test(only) ? only : `v${version}`;
}

function joinScriptUnavailable(detail: string): ApiError {
  return new ApiError('JOIN_SCRIPT_UNAVAILABLE', `The platform-api cannot vouch for the join script: ${detail}`, 503, {
    operatorError: {
      code: 'JOIN_SCRIPT_UNAVAILABLE',
      title: 'Join script unavailable',
      detail:
        'The join command pins scripts/join-node.sh by the SHA-256 of the copy in the platform-api image, so it ' +
        `cannot be rendered without that copy. ${detail}`,
      remediation: [
        'Check that the running platform-api image is a complete build (it carries /app/scripts/join-node.sh).',
        'Or join by hand: docs/operations/MULTI_NODE_RUNBOOK.md, "Add servers" / "Add a worker".',
      ],
      retryable: false,
    },
  });
}

/** join-node.sh's one `RELEASE_KEY='…'` assignment — the key it verifies with. */
const RELEASE_KEY_ASSIGNMENT_RE = /^RELEASE_KEY='([^']*)'$/gm;

/**
 * Hash this image's join-node.sh and refuse it unless the key it verifies the
 * CLI with is exactly the release key the cluster pins: a script checking
 * against any other key must never be handed out.
 */
export function loadJoinNodeScript(release: JoinRelease, env: NodeJS.ProcessEnv = process.env): JoinNodeScript {
  const path = (env.JOIN_NODE_SCRIPT_PATH ?? DEFAULT_JOIN_NODE_SCRIPT_PATH).trim();
  let body: Buffer;
  try {
    body = readFileSync(path);
  } catch {
    throw joinScriptUnavailable(`${path} is not readable.`);
  }
  const pinned = loadPinnedReleaseKey(env);
  if (!pinned) throw joinScriptUnavailable('the release key this cluster pins is not readable here.');
  const keys = [...body.toString('utf8').matchAll(RELEASE_KEY_ASSIGNMENT_RE)].map((m) => (m[1] ?? '').trim());
  if (keys.length !== 1 || keys[0] !== pinned.trim()) {
    throw joinScriptUnavailable(`${path} does not verify with the release key this cluster pins.`);
  }
  return {
    url: `https://raw.githubusercontent.com/${release.repo}/${joinNodeScriptRef(release.version)}/scripts/join-node.sh`,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

/** Single-quote a value for shell embedding. Refuses a single quote inside
 *  — defence in depth; every caller passes a validated IP/CIDR/token. */
export function shellQuote(s: string): string {
  if (s.includes("'")) {
    throw new ApiError(
      'BOOTSTRAP_COMMAND_UNQUOTABLE',
      'Refusing to embed a value containing a single quote into a shell command',
      400,
    );
  }
  return `'${s}'`;
}

export type JoinTokenInput =
  | { readonly kind: 'bootstrap'; readonly value: string; readonly expiresAt: string }
  | { readonly kind: 'node-token' };

export interface JoinScriptInput {
  readonly cppName: string;
  readonly nodeIp: string;
  readonly role: 'server' | 'worker';
  /** IPv4 InternalIP of an existing server (bootstrap.sh's --server is IPv4-only). */
  readonly serverIp: string;
  /** That server's node name, for the operator. */
  readonly serverName?: string;
  readonly release: JoinRelease;
  readonly joinScript: JoinNodeScript;
  readonly token: JoinTokenInput;
  readonly dualStack: boolean;
  /** Extra node-scoped flags as [flag, value] (e.g. a custom --pod-cidr-v6). */
  readonly extraFlags: ReadonlyArray<readonly [string, string]>;
  /** The cluster's servers are pinned to a private underlay
   *  (--cluster-network-cidr), whose CIDR the cluster does not record. */
  readonly privateUnderlay: boolean;
}

export interface RenderedJoin {
  readonly steps: BootstrapStep[];
  readonly script: string;
  readonly bootstrapCommand: string;
}

/**
 * Defence in depth for a value shown outside single quotes (the release tag in
 * a note). Today it is a validated CalVer — safe only because another file says
 * so.
 * Never let a newline or shell metacharacter through regardless of source.
 */
function commentSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9.:_-]/g, '?');
}
function joinRole(role: string): 'server' | 'worker' {
  if (role !== 'server' && role !== 'worker') {
    throw new Error(`refusing to render a join for role ${JSON.stringify(role)}`);
  }
  return role;
}

/** insula bootstrap's join flags, as join-node.sh passes them on. */
function bootstrapFlags(input: JoinScriptInput): string[] {
  return [
    '--join-as', joinRole(input.role),
    '--server', shellQuote(input.serverIp),
    ...input.extraFlags.flatMap(([flag, value]) => [flag, shellQuote(value)]),
    ...(input.dualStack ? ['--dual-stack'] : []),
  ];
}

const HEX64_RE = /^[0-9a-f]{64}$/;

function joinLine(input: JoinScriptInput): string {
  if (!HEX64_RE.test(input.joinScript.sha256)) throw new Error('refusing to render a join with a malformed script hash');
  const tokenArgs = input.token.kind === 'bootstrap' ? ['--token', shellQuote(input.token.value)] : [];
  const repoArgs = input.release.repo === DEFAULT_RELEASES_REPO ? [] : ['--repo', shellQuote(input.release.repo)];
  return [
    `curl -fsSL --proto '=https' --proto-redir '=https' -o join-node.sh ${shellQuote(input.joinScript.url)}`,
    `&& echo '${input.joinScript.sha256}  join-node.sh' | sha256sum -c -`,
    `&& bash join-node.sh --release ${shellQuote(input.release.tag)}`,
    ...repoArgs,
    ...bootstrapFlags(input),
    ...tokenArgs,
  ].join(' ');
}

/** Render the steps + the one line to run on the new node. Pure. */
export function renderJoin(input: JoinScriptInput): RenderedJoin {
  const steps: BootstrapStep[] = [];
  if (input.token.kind === 'node-token') {
    steps.push({
      id: 'server-token',
      title: `Read the server join token on any existing server, e.g. ${input.serverName ? `${input.serverName} (${input.serverIp})` : input.serverIp}`,
      runOn: 'existing-server',
      command: `cat ${SERVER_TOKEN_PATH}`,
      note:
        "As root. Every server holds the same token. It prints one line, K10…::server:…. That is the cluster's root " +
        'credential — paste it only into the prompt of the join step, never into chat, tickets or a file. ' +
        'The join checks it before installing anything.',
    });
  }
  const line = joinLine(input);
  const tokenNote =
    input.token.kind === 'bootstrap'
      ? `The embedded join token works for this worker only until ${input.token.expiresAt}, and is revoked as soon as this pre-enrolment is removed.`
      : 'It asks for the token from step 1 — the input is hidden and stays out of shell history.';
  steps.push({
    id: 'join',
    title: `Join the cluster as a ${joinRole(input.role)}`,
    runOn: 'new-node',
    command: line,
    note:
      'sha256sum must print "join-node.sh: OK": the script is checked against this cluster\'s own copy before it runs. ' +
      `It then downloads the insula CLI ${commentSafe(input.release.tag)}, installs it only if its signature matches the ` +
      `cluster's release key, and joins. ${tokenNote}` +
      (input.privateUnderlay ? ' Append the same --cluster-network-cidr <cidr> the existing servers use to the end of the line.' : ''),
  });
  const token = input.token.kind === 'bootstrap' ? shellQuote(input.token.value) : '<token>';
  return {
    steps,
    script: line,
    bootstrapCommand: ['insula bootstrap', ...bootstrapFlags(input), '--token', token].join(' '),
  };
}
