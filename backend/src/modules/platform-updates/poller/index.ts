/**
 * Production wiring for the version-poller (W11). `realPollDeps` binds the pure
 * orchestrator (poll.ts) to real I/O: the GitHub Releases REST API, asset
 * downloads, the pinned public key on disk, and the platform_settings table.
 */

import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { platformSettings } from '../../../db/schema.js';
import type { Database } from '../../../db/index.js';
import { pollAvailableVersion, type PollDeps } from './poll.js';
import type { GithubRelease, PollResult, ReleaseAsset } from './types.js';

export { pollAvailableVersion } from './poll.js';
export type { PollDeps } from './poll.js';
export type { PollResult, PollStatus, GithubRelease, ReleaseAsset, ReleaseManifest } from './types.js';
export { SETTING_KEYS } from './types.js';

const DEFAULT_REPO = 'insulahq/insula';
// owner/repo, each segment GitHub's allowed charset — refuse anything else so a
// misconfigured PLATFORM_RELEASES_REPO can't inject path traversal or extra URL
// segments into the GitHub API request.
const VALID_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// The trust anchor is baked into the backend image from platform/cosign.pub.
const DEFAULT_PUBKEY_PATH = '/app/platform/cosign.pub';
const GITHUB_API = 'https://api.github.com';
// Release assets MUST come from GitHub. The asset URLs are taken from the API
// response (attacker-influenceable if the API channel is MITM'd), so pin the
// host: a `browser_download_url` pointing at an internal address (SSRF) is
// refused. fetch() follows the github.com → pre-signed CDN redirect; GitHub
// migrated that CDN from objects.* to release-assets.githubusercontent.com
// (2025), so allow both — without release-assets.* every asset fetch fails.
const ASSET_HOST_ALLOWLIST = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
];
const FETCH_TIMEOUT_MS = 15_000;
// The signed manifest is a few hundred bytes; cap downloads hard so a malicious
// release can't make the poller pull a huge "asset" into memory.
const MAX_ASSET_BYTES = 1024 * 1024; // 1 MiB

export function isAllowedAssetHost(rawUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return ASSET_HOST_ALLOWLIST.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

interface GithubReleaseApi {
  readonly tag_name?: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  readonly assets?: ReadonlyArray<{ readonly name?: string; readonly browser_download_url?: string }>;
}

function githubHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'insula-version-poller',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Optional token only raises the rate limit — public repos need no auth.
  const token = env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function normalizeRelease(r: GithubReleaseApi): GithubRelease | null {
  if (typeof r.tag_name !== 'string' || r.tag_name.length === 0) return null;
  const assets: ReleaseAsset[] = (r.assets ?? [])
    .filter((a): a is { name: string; browser_download_url: string } =>
      typeof a.name === 'string' && typeof a.browser_download_url === 'string')
    .map((a) => ({ name: a.name, url: a.browser_download_url }));
  return {
    tagName: r.tag_name,
    draft: r.draft === true,
    prerelease: r.prerelease === true,
    assets,
  };
}

async function fetchReleases(env: NodeJS.ProcessEnv): Promise<readonly GithubRelease[] | null> {
  const requested = (env.PLATFORM_RELEASES_REPO ?? DEFAULT_REPO).trim();
  const repo = VALID_REPO_RE.test(requested) ? requested : DEFAULT_REPO;
  const url = `${GITHUB_API}/repos/${repo}/releases?per_page=30`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: githubHeaders(env),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as GithubReleaseApi[];
    if (!Array.isArray(data)) return null;
    return data.map(normalizeRelease).filter((r): r is GithubRelease => r !== null);
  } catch {
    return null;
  }
}

async function fetchAsset(env: NodeJS.ProcessEnv, url: string): Promise<Buffer | null> {
  // SSRF guard: only GitHub-hosted assets, never an attacker-supplied internal URL.
  if (!isAllowedAssetHost(url)) return null;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Release assets need a different Accept; the token (if any) still helps rate limits.
      headers: { 'User-Agent': 'insula-version-poller', Accept: 'application/octet-stream', ...(env.GITHUB_TOKEN?.trim() ? { Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}` } : {}) },
    });
    if (!resp.ok) return null;
    // Early reject on a declared oversize, then stream with a running cap so a
    // missing/forged content-length can't make us buffer an unbounded body.
    const declared = Number(resp.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) return null;
    const reader = resp.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_ASSET_BYTES) {
          await reader.cancel().catch(() => undefined);
          return null;
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db.insert(platformSettings).values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

/** Read the pinned public key from disk. Throws if unreadable — the caller MUST
 * treat that as fatal (no key ⇒ nothing can be verified ⇒ never run). */
export function readPinnedPublicKey(env: NodeJS.ProcessEnv): string {
  const path = (env.PLATFORM_COSIGN_PUB_PATH ?? DEFAULT_PUBKEY_PATH).trim();
  return readFileSync(path, 'utf8');
}

export interface RealPollDepsOptions {
  readonly db: Database;
  readonly env: NodeJS.ProcessEnv;
  readonly publicKeyPem: string;
  readonly log: (level: 'info' | 'warn', msg: string) => void;
}

export function realPollDeps(opts: RealPollDepsOptions): PollDeps {
  return {
    getSetting: (k) => getSetting(opts.db, k),
    setSetting: (k, v) => setSetting(opts.db, k, v),
    fetchReleases: () => fetchReleases(opts.env),
    fetchAsset: (url) => fetchAsset(opts.env, url),
    publicKeyPem: opts.publicKeyPem,
    now: () => new Date(),
    log: opts.log,
  };
}

/** Convenience: build real deps + run one poll. */
export async function runVersionPoll(opts: RealPollDepsOptions): Promise<PollResult> {
  return pollAvailableVersion(realPollDeps(opts));
}
