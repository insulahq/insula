/**
 * Production wiring for `platform-ops self-upgrade` (ADR-045 W11.5).
 *
 * `realSelfUpgradeOps` binds the pure orchestrator (upgrade.ts) to real I/O: the
 * platform-version ConfigMap (cluster-up), the GitHub Releases API (cluster-down
 * fallback), GitHub release-asset downloads (host-allowlisted, size-capped), the
 * pinned host cosign key (/etc/platform/cosign.pub), the W11 verifier (pure Node
 * crypto), and an atomic same-dir-temp + rename binary replacement.
 *
 * Every heavy import is dynamic so the lean subcommands (version/cluster/shell)
 * never pull the k8s graph, and so a self-upgrade run on a bare host degrades
 * gracefully when the cluster is down.
 */

import { readFileSync, writeFileSync, renameSync, rmSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { verifyCosignSignature } from '../../../modules/platform-updates/poller/verify.js';
import { parseVersion } from '../../../modules/platform-updates/poller/semver.js';
import type { SelfUpgradeOps } from '../deps.js';
import { runSelfUpgrade } from './upgrade.js';
import type { SelfUpgradeDeps } from './types.js';

const DEFAULT_REPO = 'insulahq/insula';
const DEFAULT_BIN = '/usr/local/bin/platform-ops';
const DEFAULT_PUBKEY = '/etc/platform/cosign.pub';
const GITHUB_API = 'https://api.github.com';
// Release assets must come from GitHub (SSRF guard on the download URL).
const ASSET_HOST_ALLOWLIST = ['github.com', 'objects.githubusercontent.com'];
const RELEASE_FETCH_TIMEOUT_MS = 15_000;
// The binary download is large; give it a generous timeout + a hard size cap so
// a hostile/oversize asset can't exhaust memory.
const DOWNLOAD_TIMEOUT_MS = 180_000;
const MAX_BINARY_BYTES = 300 * 1024 * 1024; // 300 MiB

const VALID_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// GitHub redirects the github.com download URL to a pre-signed objects.*. URL.
const MAX_REDIRECTS = 5;

function resolveRepo(env: NodeJS.ProcessEnv): string {
  // PLATFORM_OPS_REPO is the self-upgrade-specific override (matches the
  // bootstrap install phase's env name); PLATFORM_RELEASES_REPO is the shared
  // name the in-cluster poller uses — honoured as a fallback so a fork only
  // needs to set one. Either way the value is strictly validated below.
  const requested = (env.PLATFORM_OPS_REPO ?? env.PLATFORM_RELEASES_REPO ?? DEFAULT_REPO).trim();
  return VALID_REPO_RE.test(requested) ? requested : DEFAULT_REPO;
}

function archToken(): string {
  switch (process.arch) {
    case 'x64': return 'amd64';
    case 'arm64': return 'arm64';
    default: return process.arch; // unknown → download 404s → download-failed
  }
}

/** The version compiled into the binary. `buildVersion` is resolved by the
 * caller from the LITERAL `process.env.PLATFORM_OPS_VERSION` (esbuild --define
 * only substitutes that exact expression — reading it via an aliased `env`
 * binding would NOT be replaced, so it must be threaded in). Falls back to the
 * host's /etc/platform/VERSION, then 'unknown'. */
function currentVersion(buildVersion: string): string {
  const baked = buildVersion.trim();
  if (baked) return baked;
  try {
    const f = readFileSync('/etc/platform/VERSION', 'utf8').trim();
    if (f) return f;
  } catch { /* fall through */ }
  return 'unknown';
}

function isAllowedHost(rawUrl: string): boolean {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return ASSET_HOST_ALLOWLIST.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

function githubHeaders(env: NodeJS.ProcessEnv, accept: string, withAuth = true): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'User-Agent': 'insula-platform-ops',
    // Pin the REST API version (matches the in-cluster poller) so a binary that
    // lives on a host for months isn't broken by a future GitHub API default.
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = env.GITHUB_TOKEN?.trim();
  // Only attach the token on the FIRST (github.com) hop — never on a cross-origin
  // redirect target (objects.githubusercontent.com is a pre-signed URL that needs
  // no auth; forwarding the bearer would leak it).
  if (token && withAuth) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function readRunningVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { createK8sClients } = await import('../../../modules/k8s-provisioner/k8s-client.js');
    const kubeconfig = env.KUBECONFIG?.trim() || '/etc/rancher/k3s/k3s.yaml';
    const k8s = existsSync(kubeconfig) ? createK8sClients(kubeconfig) : createK8sClients();
    const cm = (await k8s.core.readNamespacedConfigMap({
      name: 'platform-version',
      namespace: 'platform',
    } as unknown as Parameters<typeof k8s.core.readNamespacedConfigMap>[0])) as { data?: Record<string, string> };
    const v = cm.data?.['version']?.trim().replace(/^v/, '');
    return v ?? null;
  } catch {
    return null; // cluster unreachable / no kubeconfig → caller falls back to Releases
  }
}

async function fetchLatestReleaseVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  const repo = resolveRepo(env);
  try {
    const resp = await fetch(`${GITHUB_API}/repos/${repo}/releases/latest`, {
      signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
      headers: githubHeaders(env, 'application/vnd.github+json'),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { tag_name?: string };
    const tag = (data.tag_name ?? '').trim().replace(/^v/, '');
    return parseVersion(tag) ? tag : null;
  } catch {
    return null;
  }
}

function downloadBaseFor(env: NodeJS.ProcessEnv, version: string): string {
  const repo = resolveRepo(env);
  return `https://github.com/${repo}/releases/download/v${version}`;
}

async function streamCapped(resp: Response): Promise<Buffer | null> {
  // Pre-flight reject on a declared oversize; absent content-length (0) is fine —
  // the streaming cap below is the authoritative guard against an unbounded body.
  const declared = Number(resp.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BINARY_BYTES) return null;
  const reader = resp.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BINARY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Download a release asset, following redirects MANUALLY so the host allowlist
 * is re-checked on EVERY hop (Node's fetch would silently follow a redirect off
 * the allowlist). GitHub's github.com download URL 302s to a pre-signed
 * objects.githubusercontent.com URL — both are allowlisted; anything else is
 * refused. The auth token is dropped after the first hop (see githubHeaders).
 *
 * NOTE: deliberately a SEPARATE implementation from the W11 poller's fetchAsset
 * — the poller caps at 1 MiB (a tiny manifest); the binary needs 300 MiB. Keep
 * them apart; don't "dedupe" them into one cap.
 */
async function downloadAsset(
  env: NodeJS.ProcessEnv,
  version: string,
  arch: string,
  kind: 'bin' | 'sig',
): Promise<Buffer | null> {
  let url = `${downloadBaseFor(env, version)}/platform-ops-linux-${arch}${kind === 'sig' ? '.sig' : ''}`;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedHost(url)) return null;
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: 'manual',
        headers: githubHeaders(env, 'application/octet-stream', hop === 0),
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) return null;
        url = new URL(loc, url).toString(); // resolve relative redirects against the current URL
        continue;
      }
      if (!resp.ok) return null;
      return await streamCapped(resp);
    }
    return null; // too many redirects
  } catch {
    return null;
  }
}

function readPublicKey(env: NodeJS.ProcessEnv): string | null {
  // Single, read-purpose env (NOT PLATFORM_OPS_COSIGN_PUB_DST, which is the
  // bootstrap WRITE-destination — conflating them would let a stray write-path
  // override silently redirect the trust anchor).
  const path = (env.PLATFORM_OPS_COSIGN_PUB ?? DEFAULT_PUBKEY).trim();
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Resolve the binary to replace: explicit override → the running SEA binary →
 * the conventional install path. An override must be an absolute path whose name
 * contains 'platform-ops' so a hostile PLATFORM_OPS_BIN can't redirect the
 * (verified) write over an unrelated root binary like /bin/sh. Never returns
 * `node` (a `node dist/...` dev run would otherwise clobber the interpreter). */
function resolveTargetBinary(env: NodeJS.ProcessEnv): string {
  const override = env.PLATFORM_OPS_BIN?.trim();
  if (override) {
    if (override.startsWith('/') && basename(override).includes('platform-ops')) return override;
    process.stderr.write(`[warn] ignoring unsafe PLATFORM_OPS_BIN='${override}' — using ${DEFAULT_BIN}\n`);
    return DEFAULT_BIN;
  }
  const exec = process.execPath;
  if (exec && basename(exec).includes('platform-ops')) return exec;
  return DEFAULT_BIN;
}

async function atomicReplace(env: NodeJS.ProcessEnv, binary: Buffer): Promise<boolean> {
  const target = resolveTargetBinary(env);
  const dir = dirname(target);
  const tmp = join(dir, `.platform-ops.new.${process.pid}`);
  try {
    // Same-dir temp so the rename is atomic (same filesystem). 0o755 = executable.
    writeFileSync(tmp, binary, { mode: 0o755 });
    // fsync the staged file so a crash can't leave a torn binary.
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    // Rename over the live binary — the running process keeps its old inode.
    renameSync(tmp, target);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
    return false;
  }
}

export function realSelfUpgradeDeps(env: NodeJS.ProcessEnv, buildVersion: string): SelfUpgradeDeps {
  return {
    currentVersion: () => currentVersion(buildVersion),
    arch: archToken,
    readRunningVersion: () => readRunningVersion(env),
    fetchLatestReleaseVersion: () => fetchLatestReleaseVersion(env),
    downloadAsset: (version, arch, kind) => downloadAsset(env, version, arch, kind),
    readPublicKey: () => readPublicKey(env),
    verify: (binary, sigB64, pubPem) => verifyCosignSignature(binary, sigB64, pubPem),
    atomicReplace: (binary) => atomicReplace(env, binary),
    log: (level, msg) => process.stderr.write(`[${level}] ${msg}\n`),
  };
}

export function realSelfUpgradeOps(env: NodeJS.ProcessEnv, buildVersion: string): SelfUpgradeOps {
  return { run: (opts) => runSelfUpgrade(opts, realSelfUpgradeDeps(env, buildVersion)) };
}
