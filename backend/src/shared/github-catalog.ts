import { mkdtemp, rm, readdir, readFile, access, rename, lstat, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { ApiError } from './errors.js';
import { guardedFetch, SsrfBlockedError, type InternalAccessPolicy } from './ssrf-guard.js';

const execFileAsync = promisify(execFile);

// ─── Repo Source ────────────────────────────────────────────────────────────

export interface RepoSource {
  readonly type: 'github' | 'http';
  readonly owner?: string;
  readonly repo?: string;
  readonly baseUrl?: string;
}

/** GitHub only when the host is github.com; any other URL is an HTTP catalog. */
export function parseRepoUrl(url: string): RepoSource {
  let parsed: URL | null = null;
  try { parsed = new URL(url); } catch { /* an HTTP source; the fetch refuses it */ }
  const host = parsed?.hostname.toLowerCase();
  const match = (host === 'github.com' || host === 'www.github.com') ? parsed!.pathname.match(/^\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/) : null;
  if (match) {
    return { type: 'github', owner: match[1], repo: match[2] };
  }
  return { type: 'http', baseUrl: url.replace(/\/$/, '') };
}

/** A URL fit for an error message: no credentials, query or fragment. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(an unparseable URL)';
  }
}

export function buildCatalogFileUrl(source: RepoSource, branch: string, path: string): string {
  if (source.type === 'github') {
    return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${branch}/${path}`;
  }
  return `${source.baseUrl}/${path}`;
}

// ─── JSON Fetch (for non-tarball fallback) ──────────────────────────────────

/** The largest catalog.json or manifest a sync reads. */
export const CATALOG_JSON_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Fetch one JSON file of a catalog. The address an admin typed is fetched on a
 * timer, so it goes through the SSRF guard: no internal destination unless
 * `policy` opens the private ranges (never loopback, metadata or the cluster's
 * own networks), checked on the address the socket connects to, and no
 * redirect followed.
 */
export async function fetchJson<T>(url: string, authToken?: string | null, policy: InternalAccessPolicy = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'insula/1.0' };
  if (authToken) {
    headers['Authorization'] = `token ${authToken}`;
  }
  const shown = redactUrl(url);
  let res: Awaited<ReturnType<typeof guardedFetch>>;
  try {
    res = await guardedFetch(url, { headers, timeoutMs: 15_000, maxBytes: CATALOG_JSON_MAX_BYTES, policy });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      throw new ApiError(
        'CATALOG_URL_REFUSED',
        `Refused to fetch ${shown}: it points at an internal address. A catalog on your own network needs "Allow repositories on private networks" on the Repositories page; loopback, cloud metadata and the cluster's own networks are never fetched.`,
        400,
      );
    }
    throw new ApiError('CATALOG_FETCH_ERROR', `Failed to fetch ${shown}: ${(err as Error).message.slice(0, 200)}`, 502);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ApiError('CATALOG_FETCH_ERROR', `Failed to fetch ${shown}: the server answered with a redirect (${res.status}${res.location ? ` to ${redactUrl(res.location)}` : ''}), which is not followed — use the final address as the repository URL.`, 502);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError('CATALOG_FETCH_ERROR', `Failed to fetch ${shown}: ${res.status}`, 502);
  }
  if (res.truncated) {
    throw new ApiError('CATALOG_FETCH_ERROR', `Failed to fetch ${shown}: larger than ${CATALOG_JSON_MAX_BYTES / (1024 * 1024)} MB`, 502);
  }
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new ApiError('CATALOG_FETCH_ERROR', `Failed to fetch ${shown}: not valid JSON`, 502);
  }
}

// ─── Tarball checks ─────────────────────────────────────────────────────────

/** The largest repository tarball a sync downloads. */
export const CATALOG_TARBALL_MAX_BYTES = 100 * 1024 * 1024;
/** The most a repository tarball may unpack to, and the most entries it may hold. */
export const CATALOG_TARBALL_MAX_EXTRACTED_BYTES = 300 * 1024 * 1024;
export const CATALOG_TARBALL_MAX_ENTRIES = 50_000;

/** Tar entry types a catalog may hold: files, directories, and the headers that describe them. */
const PLAIN_TAR_TYPES = new Set(['0', '\0', '7', '5', 'g', 'x', 'L']);

/**
 * Read a .tar.gz's headers before anything is extracted: refuse a link, a
 * device or any other special entry (so tar never writes through one), and
 * stop once the archive unpacks past `maxBytes` or holds more than
 * `maxEntries` entries (a gzip bomb fills the pod's tmpfs, which is its RAM).
 * The format is read here, not tar's listing, which differs between GNU tar
 * and the busybox tar of the API image.
 */
export async function inspectTarball(
  path: string,
  maxBytes: number = CATALOG_TARBALL_MAX_EXTRACTED_BYTES,
  maxEntries: number = CATALOG_TARBALL_MAX_ENTRIES,
): Promise<void> {
  const stream = createReadStream(path).pipe(createGunzip());
  let pending: Buffer = Buffer.alloc(0);
  let skip = 0;
  let seen = 0;
  let entries = 0;
  let ended = false;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      seen += chunk.length;
      if (seen > maxBytes) {
        throw new ApiError('INVALID_CATALOG', `The repository archive unpacks to more than ${maxBytes / (1024 * 1024)} MB`, 400);
      }
      if (ended) continue;
      let buf: Buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let off = 0;
      while (!ended) {
        if (skip > 0) {
          const n = Math.min(skip, buf.length - off);
          skip -= n;
          off += n;
          if (skip > 0) break;
        }
        if (buf.length - off < 512) break;
        const header = buf.subarray(off, off + 512);
        off += 512;
        if (header.every((b) => b === 0)) { ended = true; break; }
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const type = String.fromCharCode(header[156]!);
        if (!PLAIN_TAR_TYPES.has(type)) {
          throw new ApiError('INVALID_CATALOG', `The repository archive holds a link or special file (${name.slice(0, 120)}); a catalog may hold only plain files.`, 400);
        }
        if (header[124]! & 0x80) {
          throw new ApiError('INVALID_CATALOG', `The repository archive holds a file too large for a catalog (${name.slice(0, 120)})`, 400);
        }
        const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
        if (!Number.isFinite(size) || size < 0) {
          throw new ApiError('INVALID_CATALOG', 'The repository archive is not a valid tar file', 400);
        }
        entries += 1;
        if (entries > maxEntries) {
          throw new ApiError('INVALID_CATALOG', `The repository archive holds more than ${maxEntries} entries`, 400);
        }
        skip = Math.ceil(size / 512) * 512;
      }
      pending = buf.subarray(off);
      buf = Buffer.alloc(0);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError('INVALID_CATALOG', `The repository archive could not be read: ${(err as Error).message.slice(0, 120)}`, 400);
  } finally {
    stream.destroy();
  }
}

/**
 * A catalog is read from the extracted files, so the tree may hold only plain
 * files and directories: a symlink could make a manifest read a file of the
 * API's own pod (and a JSON parse error would quote it into the repository's
 * last error).
 */
export async function assertPlainTree(root: string): Promise<void> {
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const st = await lstat(full);
      if (st.isDirectory()) await walk(full);
      else if (!st.isFile()) {
        throw new ApiError('INVALID_CATALOG', `The repository archive holds a link or special file (${relative(root, full)}); a catalog may hold only plain files.`, 400);
      }
    }
  };
  await walk(root);
}

/** Read a response body into memory, refusing one past `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new ApiError('CATALOG_FETCH_ERROR', `The repository archive is larger than ${maxBytes / (1024 * 1024)} MB`, 502);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ApiError('CATALOG_FETCH_ERROR', `The repository archive is larger than ${maxBytes / (1024 * 1024)} MB`, 502);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// ─── Tarball Download & Extract ─────────────────────────────────────────────

/**
 * Downloads the repo as a tarball and extracts to a local directory.
 * Returns the path to the extracted catalog root.
 *
 * GitHub tarballs contain a single top-level directory like `owner-repo-sha/`.
 * We flatten this so the returned path contains the catalog files directly.
 */
export async function downloadCatalogRepo(
  source: RepoSource,
  branch: string,
  authToken?: string | null,
): Promise<string> {
  let tarballUrl: string;

  if (source.type === 'github') {
    // GitHub API tarball endpoint — single request, no rate limiting on raw files
    tarballUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/tarball/${branch}`;
  } else {
    // For HTTP sources, there's no standard tarball. Fall back to per-file fetch.
    throw new ApiError(
      'TARBALL_NOT_SUPPORTED',
      'Tarball download is only supported for GitHub repositories. HTTP sources use per-file fetch.',
      400,
    );
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'insula/1.0',
  };
  if (authToken) {
    headers['Authorization'] = `token ${authToken}`;
  }

  // Download tarball
  const response = await fetch(tarballUrl, {
    headers,
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new ApiError(
      'CATALOG_FETCH_ERROR',
      `Failed to download tarball from ${tarballUrl}: ${response.status} ${response.statusText}`,
      502,
    );
  }

  // Create temp directory for extraction
  const tempBase = join(tmpdir(), 'catalog-sync-');
  const tempDir = await mkdtemp(tempBase);

  try {
    // Write tarball to temp file and extract
    const tarballPath = join(tempDir, 'repo.tar.gz');
    await writeFile(tarballPath, await readCapped(response, CATALOG_TARBALL_MAX_BYTES));

    // Its headers first (no link, no special file, bounded size), then extract
    // without the archive's owners and modes, then check the tree again.
    await inspectTarball(tarballPath);
    await execFileAsync('tar', ['xzf', tarballPath, '-C', tempDir, '--no-same-owner', '--no-same-permissions']);

    // Remove tarball
    await rm(tarballPath);
    await assertPlainTree(tempDir);

    // GitHub tarballs have a top-level dir like `owner-repo-sha/`
    // Find it and move contents up (or just return the nested path)
    const entries = await readdir(tempDir);
    const subdirs = entries.filter(e => !e.startsWith('.'));

    if (subdirs.length === 1) {
      // Single top-level directory — this is the GitHub pattern
      const nestedDir = join(tempDir, subdirs[0]);
      // Check if catalog.json exists inside
      try {
        await access(join(nestedDir, 'catalog.json'));
        return nestedDir;
      } catch {
        // catalog.json not in nested dir, check temp root
      }
    }

    // Check if catalog.json is at the root level
    try {
      await access(join(tempDir, 'catalog.json'));
      return tempDir;
    } catch {
      throw new ApiError(
        'INVALID_CATALOG',
        'Downloaded tarball does not contain a catalog.json',
        400,
      );
    }
  } catch (err) {
    // Clean up on error
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ─── Local File Helpers ─────────────────────────────────────────────────────

export async function readLocalJson<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content) as T;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist the extracted catalog to a stable cache directory.
 * Replaces the previous cache if it exists.
 */
export async function persistCatalogCache(
  extractedPath: string,
  repoId: string,
): Promise<string> {
  const cacheDir = join(tmpdir(), `catalog-cache-${repoId}`);
  // Remove old cache
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  // Move extracted to cache location
  await rename(extractedPath, cacheDir);
  // A GitHub tarball is extracted one level down (`catalog-sync-*/owner-repo-sha`):
  // the emptied extraction directory goes too, or every sync leaves one behind.
  const parent = dirname(extractedPath);
  if (dirname(parent) === tmpdir() && basename(parent).startsWith('catalog-sync-')) {
    await rmdir(parent).catch(() => {});
  }
  return cacheDir;
}
