/**
 * Renders the admin panel's node-join procedure: shell steps the operator
 * pastes ON THE NEW NODE as root (plus, for a server, one read on an existing
 * server). Pure string building — every cluster fact is resolved by the
 * caller (bootstrap-command.ts) and passed in.
 *
 * The CLI install reproduces the documented procedure
 * (documentation/docs/getting-started/install.md, "Verify the download") and
 * the node-side self-upgrade (scripts/lib/bootstrap-phases.sh
 * platform_ops_fetch / platform_ops_verify_blob):
 *   asset   https://github.com/<repo>/releases/download/v<tag>/insula-linux-<arch>
 *   verify  openssl dgst -sha256 -verify cosign.pub -signature <der> <asset>
 * with two deliberate tightenings:
 *   - the release is the CLUSTER'S version, never `latest` — bootstrap pins
 *     k3s per release, so a newer CLI would install a different k3s;
 *   - the trust anchor is the key the cluster already pins (baked into the
 *     platform-api image from platform/cosign.pub) written inline, so GitHub
 *     alone cannot swap both the binary and the key that verifies it.
 */

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
  readonly release: JoinRelease;
  /** PEM of the cluster's release key, or null to fetch it from the release tag. */
  readonly releaseKeyPem: string | null;
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

function downloadStep(release: JoinRelease, releaseKeyPem: string | null): Omit<BootstrapStep, 'id'> {
  const base = `https://github.com/${release.repo}/releases/download/v${release.tag}`;
  const anchor = releaseKeyPem
    ? `printf '%s\\n' ${releaseKeyPem.trim().split(/\r?\n/).map(shellQuote).join(' ')} > cosign.pub`
    : `curl -fsSL --proto-redir =https -o cosign.pub "https://raw.githubusercontent.com/${release.repo}/v${release.tag}/platform/cosign.pub"`;
  return {
    title: `Download the insula CLI ${release.tag} (this cluster's release) and its signature`,
    runOn: 'new-node',
    command: [
      'INSULA_ARCH="$(uname -m)"; case "$INSULA_ARCH" in x86_64) INSULA_ARCH=amd64 ;; aarch64) INSULA_ARCH=arm64 ;; esac',
      `curl -fsSL --proto-redir =https -o insula "${base}/insula-linux-\${INSULA_ARCH}"`,
      `curl -fsSL --proto-redir =https -o insula.sig "${base}/insula-linux-\${INSULA_ARCH}.sig"`,
      anchor,
    ].join('\n'),
    note: releaseKeyPem
      ? 'cosign.pub is the release key this cluster already trusts, written inline — not fetched from GitHub. Needs curl + openssl on the node.'
      : 'This platform-api has no pinned release key, so cosign.pub is fetched from the release tag. Compare it with /etc/platform/cosign.pub on an existing server first.',
  };
}

const VERIFY_INSTALL_COMMAND = [
  'if base64 -d insula.sig > insula.sig.der && openssl dgst -sha256 -verify cosign.pub -signature insula.sig.der insula; then',
  '  install -m 0755 insula /usr/local/bin/insula',
  '  rm -f insula insula.sig insula.sig.der cosign.pub',
  'else',
  "  echo 'Signature verification FAILED: not installing. Delete the download and stop.' >&2; false",
  'fi',
].join('\n');

/**
 * Defence in depth for values that reach the script outside single quotes
 * (comment lines, the role word). Today they are DNS-1123 names, CRD-pattern
 * IPs and a CRD enum — safe only because a schema in another file says so.
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

function joinStep(input: JoinScriptInput): Omit<BootstrapStep, 'id'> {
  const tokenArg = input.token.kind === 'bootstrap' ? shellQuote(input.token.value) : '"$INSULA_JOIN_TOKEN"';
  const flags = [
    'insula bootstrap',
    '--join-as', joinRole(input.role),
    '--server', shellQuote(input.serverIp),
    '--token', tokenArg,
    ...input.extraFlags.flatMap(([flag, value]) => [flag, shellQuote(value)]),
    ...(input.dualStack ? ['--dual-stack'] : []),
  ].join(' ');
  const lines: string[] = [];
  if (input.privateUnderlay) {
    lines.push(
      "# This cluster's servers are pinned to a private network (bootstrapped with",
      '# --cluster-network-cidr; their InternalIP differs from their ExternalIP). The',
      '# cluster does not record that CIDR: append the SAME --cluster-network-cidr <cidr>',
      '# to the insula bootstrap line below before running it.',
    );
  }
  if (input.token.kind === 'node-token') {
    lines.push("read -rsp 'Paste the server join token from step 1, then press Enter: ' INSULA_JOIN_TOKEN; echo");
  }
  lines.push(flags);
  return {
    title: `Join the cluster as a ${input.role}`,
    runOn: 'new-node',
    command: lines.join('\n'),
    note:
      input.token.kind === 'bootstrap'
        ? `The embedded join token works for this worker only until ${input.token.expiresAt}, and is revoked as soon as this pre-enrolment is removed.`
        : 'Prompts for the token from step 1 — the input is hidden and stays out of shell history.',
  };
}

/** Render the ordered steps + the one-paste script. Pure. */
export function renderJoin(input: JoinScriptInput): RenderedJoin {
  const steps: BootstrapStep[] = [];
  if (input.token.kind === 'node-token') {
    steps.push({
      id: 'server-token',
      title: `Read the server join token on an existing server (${input.serverIp})`,
      runOn: 'existing-server',
      command: `cat ${SERVER_TOKEN_PATH}`,
      note:
        "As root. It prints one line, K10…::server:…. That is the cluster's root credential — paste it only " +
        'into the prompt of the join step, never into chat, tickets or a file.',
    });
  }
  steps.push({ id: 'download', ...downloadStep(input.release, input.releaseKeyPem) });
  steps.push({
    id: 'verify-install',
    title: "Verify the signature against the cluster's release key, then install",
    runOn: 'new-node',
    command: VERIFY_INSTALL_COMMAND,
    note: 'openssl must print "Verified OK". Anything else means the download is not what was released: delete it and stop.',
  });
  steps.push({ id: 'join', ...joinStep(input) });

  const script = [
    `# Join '${commentSafe(input.cppName)}' (${commentSafe(input.nodeIp)}) to the cluster as a ${joinRole(input.role)}.`,
    '# Paste into a root bash shell (sudo -i) on the NEW node. Its pre-enrolment must exist first.',
    '# Stops at the first failure — an unverified binary is never installed or run.',
    '(',
    'set -eu',
    "[ \"$(id -u)\" -eq 0 ] || { echo 'Run this as root (sudo -i), then paste it again.' >&2; exit 1; }",
    'INSULA_TMP="$(mktemp -d)"; trap \'rm -rf "$INSULA_TMP"\' EXIT; cd "$INSULA_TMP"',
    ...steps.flatMap((s, i) =>
      s.runOn === 'new-node' ? ['', `# Step ${i + 1}/${steps.length} — ${s.title}`, s.command] : [],
    ),
    ')',
  ].join('\n');

  const join = steps[steps.length - 1];
  return { steps, script, bootstrapCommand: join ? join.command : '' };
}
