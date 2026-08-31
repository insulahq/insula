// File Manager Sidecar — Minimal REST API for PVC file operations
// Runs inside client K8s namespace, mounted PVC at /data
// Auth: every non-/health request requires the per-tenant derived secret in
// the X-Platform-Internal header (see isAuthenticated). Defense-in-depth on top
// of the NetworkPolicy that scopes :8111 to platform-api.

import { createServer } from 'node:http';
import * as fs from 'node:fs';
import { readdir, stat, readFile, writeFile, mkdir, rm, rename, cp, chown as fsChown, realpath } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { join, resolve, basename, extname, dirname, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { open as fsOpen } from 'node:fs/promises';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { createTrash, FALLBACK_RETENTION_DAYS } from './trash.mjs';

const execFileAsync = promisify(execFile);

// Node's execFile buffers the child's stdout in memory and KILLS the child when
// it exceeds `maxBuffer` — which defaults to 1 MiB. The rejection says only
// "stdout maxBuffer length exceeded", and the work is left half-done.
//
// Observed in production 2026-08-30: extracting a 14,191-entry archive
// (Perfex CRM, 56 MB) failed every time. `unzip -o` prints one line per member,
// which for that archive is 1,513,063 bytes of stdout — 44% over the cap. The
// archive was valid, the disk had room, and the extract itself takes 5 seconds;
// the only thing wrong was that nobody was reading unzip's chatter.
//
// Two defences, because either alone leaves a hole:
//   1. `-q` on zip/unzip so the output is never produced. Fixes the two tools
//      that are per-file chatty. tar is already quiet without -v.
//   2. This maxBuffer, for every tool. A future tool, a `git clone` writing
//      progress to stderr (also capped), or a warning storm from unzip on a
//      damaged archive would all hit the same wall. 32 MiB is far above any
//      legitimate output and still bounded.
const TOOL_MAX_BUFFER = 32 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 120_000;

/**
 * Run an external tool with limits that suit "this produces files, not output".
 * Use this instead of execFileAsync for anything whose output length scales
 * with the number of files it touches.
 */
function runTool(file, args, opts = {}) {
  return execFileAsync(file, args, {
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: TOOL_MAX_BUFFER,
    ...opts,
  });
}

/**
 * Turn a child-process rejection into something an operator can act on.
 * Never includes the command line or filesystem paths — this string is
 * relayed verbatim to the tenant panel.
 */
// An archive of ANY size must extract. That rules out both of execFile's
// built-in limits, not just the buffer:
//
//   maxBuffer — execFile accumulates the whole of stdout in memory. Even at
//     32 MiB that is a ceiling proportional to the FILE COUNT, and it buys
//     nothing, because we do not want the output as a blob. spawn + a line
//     reader consumes it as it arrives and holds one line at a time.
//
//   timeout — a fixed total duration is exactly the wrong shape. 120s is
//     generous for 14k files and far too short for 2 million. What actually
//     indicates a stuck process is SILENCE, so this is an IDLE timer: it
//     resets on every line the tool emits. A live extraction, however long,
//     never trips it; a wedged one still dies.
//
// The per-file chatter that caused the original bug is the progress feed here,
// so the tools are deliberately run in VERBOSE mode and never with -q.
const TOOL_IDLE_TIMEOUT_MS = 120_000;

/**
 * Spawn a tool and invoke onLine(line) for every line it writes to stdout or
 * stderr. Resolves when the process exits 0, rejects otherwise. Never buffers
 * more than a single line, so memory is independent of archive size.
 */
function runToolStreaming(file, args, { cwd, env, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let idle;
    let settled = false;
    let stderrTail = '';

    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        const e = new Error(`${file} produced no output for ${TOOL_IDLE_TIMEOUT_MS / 1000}s`);
        e.idleTimeout = true;
        reject(e);
      }, TOOL_IDLE_TIMEOUT_MS);
    };

    const readLines = (stream, isErr) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        bump();
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          // Keep only the last few stderr lines for the error message; never
          // the whole stream, or we reintroduce unbounded buffering.
          if (isErr) stderrTail = line.slice(0, 300);
          if (onLine) { try { onLine(line, isErr); } catch { /* progress must never kill the job */ } }
        }
        // A pathological tool emitting one enormous line must not grow forever.
        if (buf.length > 1 << 20) buf = buf.slice(-4096);
      });
    };

    readLines(child.stdout, false);
    readLines(child.stderr, true);
    bump();

    child.on('error', err => {
      if (settled) return;
      settled = true; clearTimeout(idle); reject(err);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(idle);
      if (code === 0) return resolve();
      const e = new Error(stderrTail || `${file} exited ${code}`);
      e.code = code;
      reject(e);
    });
  });
}

/**
 * Total member count of a zip, read straight from the End of Central Directory
 * record — no subprocess, no full scan, a couple of reads regardless of size.
 * Returns null when it cannot be determined (Zip64 without the locator, huge
 * trailing comment, damaged file); callers then report indeterminate progress
 * rather than a wrong percentage.
 */
async function zipEntryCount(path) {
  let fh;
  try {
    fh = await fsOpen(path, 'r');
    const { size } = await fh.stat();
    // EOCD is 22 bytes plus an optional comment of up to 65535.
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) return null;

    const count = tail.readUInt16LE(eocd + 10);
    if (count !== 0xffff) return count;

    // Zip64: the real count lives in the Zip64 EOCD, found via its locator
    // immediately before the EOCD we just located.
    const locOff = eocd - 20;
    if (locOff < 0 || tail.readUInt32LE(locOff) !== 0x07064b50) return null;
    const z64Off = Number(tail.readBigUInt64LE(locOff + 8));
    const z64 = Buffer.alloc(56);
    await fh.read(z64, 0, 56, z64Off);
    if (z64.readUInt32LE(0) !== 0x06064b50) return null;
    return Number(z64.readBigUInt64LE(32));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Emit at most one progress line per tick, so 2M files do not mean 2M writes. */
function makeProgressEmitter(res, { total, intervalMs = 250 } = {}) {
  let done = 0;
  let last = 0;
  let lastName = '';
  const write = force => {
    const now = Date.now();
    if (!force && now - last < intervalMs) return;
    last = now;
    if (res.writableEnded) return;
    res.write(JSON.stringify({
      type: 'progress',
      done,
      total: total ?? null,
      percent: total ? Math.min(100, Math.round((done / total) * 100)) : null,
      current: lastName,
    }) + '\n');
  };
  return {
    tick(name) { done++; if (name) lastName = name; write(false); },
    flush() { write(true); },
    get count() { return done; },
  };
}

function describeToolFailure(err, action) {
  const msg = String(err?.message ?? '');
  if (msg.includes('maxBuffer')) {
    return `Failed to ${action}: the tool produced more output than could be read. Please report this.`;
  }
  if (err?.idleTimeout) {
    return `Failed to ${action}: the tool stopped responding (no progress for ${TOOL_IDLE_TIMEOUT_MS / 1000}s).`;
  }
  if (err?.killed && (err?.signal === 'SIGTERM' || err?.signal === 'SIGKILL')) {
    return `Failed to ${action}: timed out after ${TOOL_TIMEOUT_MS / 1000}s.`;
  }
  if (typeof err?.code === 'number' && err.code !== 0) {
    // `action` carries the subject ("extract archive", "change permissions"),
    // so this branch stays subject-neutral. It used to say "the archive appears
    // to be damaged", which became "Failed to change permissions: the archive
    // appears to be damaged" once chmod started using this helper.
    //
    // It must NOT relay the tool's stderr: my first correction did, and the
    // message became "…cannot find /tmp/fm-extract-gXg3JS/broken.zip.ZIP",
    // disclosing an internal path to the tenant. This string is returned
    // verbatim to the panel — the exit code is the only detail safe to include.
    return `Failed to ${action} (exit ${err.code}). The target may be damaged, unreadable, or in an unexpected format.`;
  }
  if (err?.code === 'ENOSPC' || msg.includes('ENOSPC') || msg.includes('No space left')) {
    return `Failed to ${action}: not enough free space.`;
  }
  return `Failed to ${action}.`;
}

const PORT = 8111;

// Default ownership for files created by the file-manager (www-data, compatible with PHP apps)
const DEFAULT_UID = 33;
const DEFAULT_GID = 33;

// ─── UID/GID → Name Resolution ──────────────────────────────────────────────
const uidNameCache = new Map();
const gidNameCache = new Map();

async function loadPasswd() {
  try {
    const data = await readFile('/etc/passwd', 'utf8');
    for (const line of data.split('\n')) {
      const parts = line.split(':');
      if (parts.length >= 3) uidNameCache.set(parseInt(parts[2], 10), parts[0]);
    }
  } catch { /* no /etc/passwd */ }
}

async function loadGroup() {
  try {
    const data = await readFile('/etc/group', 'utf8');
    for (const line of data.split('\n')) {
      const parts = line.split(':');
      if (parts.length >= 3) gidNameCache.set(parseInt(parts[2], 10), parts[0]);
    }
  } catch { /* no /etc/group */ }
}

function resolveUidName(uid) { return uidNameCache.get(uid) ?? String(uid); }
function resolveGidName(gid) { return gidNameCache.get(gid) ?? String(gid); }

// Load at startup
await loadPasswd();
await loadGroup();
// Also add well-known names not in Alpine's /etc/passwd
if (!uidNameCache.has(33)) uidNameCache.set(33, 'www-data');
if (!gidNameCache.has(33)) gidNameCache.set(33, 'www-data');
if (!uidNameCache.has(999)) uidNameCache.set(999, 'mysql');
if (!gidNameCache.has(999)) gidNameCache.set(999, 'mysql');
if (!uidNameCache.has(70)) uidNameCache.set(70, 'postgres');
if (!gidNameCache.has(70)) gidNameCache.set(70, 'postgres');
// The PVC mount root. Overridable only for unit tests (FM_BASE); production
// always uses the hard-coded /data mount.
const BASE = process.env.FM_BASE || '/data';

const MIME_TYPES = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.php': 'text/x-php', '.py': 'text/x-python', '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/x-toml',
};
function getMimeType(filename) {
  const ext = extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ─── Hidden platform paths ───────────────────────────────────────────────────
// Files and directories that must never be visible through the file manager.
// The backend uses a separate internal path (X-Platform-Internal header) to
// read/write these. Everything under `.platform/` is platform-managed
// (sendmail submission credentials, scheduled-task queue files, etc.) — if a
// customer sees or modifies them they can break outbound mail or run
// unapproved cron jobs.
//
// Matching is by normalized, relative-to-BASE path. We match both the path
// itself ("foo/.platform") and any descendant ("foo/.platform/sendmail").
// Every file in the root "." that starts with `.platform` is also hidden so
// browsing `/` doesn't leak the folder.

// Hidden at ALL path levels (defense-in-depth for platform internals).
// The SFTP jail now lives in a separate emptyDir volume (/jail), so no
// platform artifacts exist on the PVC. This filter is kept as defense-
// in-depth in case a .platform/ dir is ever created on the PVC.
const HIDDEN_PREFIXES = ['.platform'];

// Hidden ONLY at the PVC root, not at every level. `/data/.trash` is the
// recycle bin (trash.mjs) and must be unreachable through the ordinary file
// operations: were it reachable, `rm`/`rename`/`copy`/`write` could desync a
// payload from its metadata, or delete the bin from inside itself. It gets its
// own /trash/* endpoints instead.
//
// Root-anchored rather than any-segment (the .platform rule) on purpose: a
// tenant may legitimately keep their own `wp-content/.trash` directory, and
// hiding it would silently disappear their data from the browser.
const ROOT_HIDDEN_PREFIXES = ['.trash'];

function relToBase(absPath) {
  // Strip BASE prefix to produce a relative POSIX-style path used by
  // the HIDDEN_PREFIXES check. Paths equal to BASE itself become '.'.
  if (absPath === BASE) return '.';
  return absPath.startsWith(BASE + '/') ? absPath.slice(BASE.length + 1) : absPath;
}

function isHidden(relPath) {
  // Normalize: strip trailing slashes, collapse any leading ./
  const norm = relPath.replace(/^\.\/+/, '').replace(/\/+$/, '');
  for (const prefix of HIDDEN_PREFIXES) {
    if (norm === prefix) return true;
    if (norm.startsWith(prefix + '/')) return true;
    // Also hide any path that contains the prefix as a path segment
    // (e.g. "nested/dir/.platform/foo"). Defense-in-depth so a customer
    // can't stash data under a nested .platform directory they create.
    if (norm.split('/').includes(prefix)) return true;
  }
  for (const prefix of ROOT_HIDDEN_PREFIXES) {
    if (norm === prefix) return true;
    if (norm.startsWith(prefix + '/')) return true;
  }
  return false;
}

// ─── Security: path traversal prevention ─────────────────────────────────────

function withinBase(p) {
  // A path is inside BASE only if it IS BASE or sits under "BASE/". The
  // naive `startsWith(BASE)` is wrong — it also matches sibling dirs whose
  // name merely begins with "data" (e.g. "/data-evil"), so "../data-evil/x"
  // would escape. (F3)
  return p === BASE || p.startsWith(BASE + '/');
}

// Resolve symlinks along `resolved` and confine the *real* target to BASE.
//
// `resolve()` is purely lexical, so it cannot see symlinks: a symlink planted
// inside the PVC (via SFTP, the tenant's app, or an extracted archive) that
// points outside /data would let the root file-manager read/write the host
// filesystem. We realpath the longest EXISTING ancestor of the path (the leaf
// may not exist yet for writes/mkdir), verify it stays inside BASE, then
// re-append the not-yet-existing trailing components. Any symlink that escapes
// BASE makes this return null. Symlinks that stay within BASE resolve normally.
async function confineRealpath(resolved) {
  const suffix = [];
  let cur = resolved;
  for (;;) {
    try {
      const real = await realpath(cur); // eslint-disable-line no-await-in-loop
      if (!withinBase(real)) return null; // a symlink escaped BASE
      return suffix.length ? join(real, ...suffix) : real;
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
      const parent = dirname(cur);
      if (parent === cur || cur.length <= BASE.length) return null; // walked to / or above BASE
      suffix.unshift(basename(cur));
      cur = parent;
    }
  }
}

async function safePath(userPath, opts = {}) {
  // Strip leading slash — user paths are relative to BASE
  const cleaned = (userPath || '.').replace(/^\/+/, '') || '.';
  const resolved = resolve(BASE, cleaned);
  if (!withinBase(resolved)) {
    return null; // Lexical traversal attempt (F3)
  }
  // Hidden-path enforcement. The platform-internal bypass header lets
  // the platform backend read/write these paths while keeping them
  // invisible to the customer's UI.
  if (!opts.allowHidden && isHidden(relToBase(resolved))) return null;

  // Symlink confinement (F2): the lexically-clean path may still traverse a
  // symlink out of BASE. Resolve real targets and re-check.
  const confined = await confineRealpath(resolved);
  if (confined === null) return null;
  // Re-check hidden on the REAL target so a symlink can't alias a .platform path.
  if (!opts.allowHidden && isHidden(relToBase(confined))) return null;
  return confined;
}

// ─── Recycle bin ─────────────────────────────────────────────────────────────
// Instantiated here because it needs BASE, safePath and confineRealpath. The
// factory shape avoids a circular import (this module has top-level await).
const trash = createTrash({
  BASE,
  safePath,
  confineRealpath,
  execFileAsync,
  defaultUid: DEFAULT_UID,
  defaultGid: DEFAULT_GID,
  log: (...a) => console.warn(...a),
});

// Shared-secret gate for the platform-internal bypass. The backend
// injects this secret via the file-manager Secret at pod creation
// time. If unset, we fail closed and never allow the bypass — this
// means a dev cluster without the secret simply cannot access
// hidden paths via the sidecar, forcing direct kubectl exec.
//
// Constant-time comparison prevents timing attacks against the
// secret value.
const PLATFORM_INTERNAL_SECRET = process.env.PLATFORM_INTERNAL_SECRET || '';
let warnedNoSecret = false;

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Authentication gate (2026-07-27). Every request to the sidecar MUST carry
// the per-tenant derived secret in `X-Platform-Internal`. platform-api sends
// it on every call (file-manager/service.ts). Previously the sidecar had NO
// request auth — its comment claimed "protected by NetworkPolicy", but the
// generated allow-platform-api policy opened :8111 to the whole pod CIDR, so
// any tenant container could read/write another tenant's PVC unauthenticated.
// The NetworkPolicy is now narrowed to platform-api only; this header check is
// defense-in-depth so a policy regression or a platform-api compromise is not
// an instant cross-tenant root-file breach.
function isAuthenticated(req) {
  if (!PLATFORM_INTERNAL_SECRET) return false;
  const provided = req.headers['x-platform-internal'];
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return constantTimeEquals(provided, PLATFORM_INTERNAL_SECRET);
}

// Hidden platform paths (.platform/*) are NEVER exposed over HTTP. The only
// caller that ever needed them (mail-submit's sendmail-cred writer) was removed
// 2026-07-27, so this now always denies — `.platform` stays filtered for every
// request. Kept as a named function so the ~16 safePath call sites are unchanged.
function isPlatformBypass(_req) {
  return false;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function getQuery(url) {
  const u = new URL(url, 'http://localhost');
  return Object.fromEntries(u.searchParams);
}

function getPath(url) {
  return new URL(url, 'http://localhost').pathname;
}

// Multipart /upload was removed 2026-04-20. The handler buffered the whole
// request body in memory, which OOM-killed the sidecar pod (128 Mi limit)
// on any upload bigger than ~80 MiB. The streaming /write-raw endpoint
// replaces it — it pipes the body straight to disk with no in-memory
// buffer. Any legacy caller hitting /upload now gets a 410 Gone from the
// platform-api front door; the sidecar never sees the request.
async function parseMultipart(_req) {
  throw new Error('Multipart /upload handler removed — stream to /write-raw instead');
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleLs(req, res) {
  const { path: p = '/', recursive } = getQuery(req.url);
  const bypass = isPlatformBypass(req);
  const full = await safePath(p, { allowHidden: bypass });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    const isRecursive = recursive === 'true' || recursive === '1';

    async function listDir(dirPath, prefix) {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const parentRel = relToBase(dirPath);
      const visibleEntries = bypass
        ? entries
        : entries.filter((e) => {
            const childRel = parentRel === '.' ? e.name : `${parentRel}/${e.name}`;
            return !isHidden(childRel);
          });
      const items = [];
      for (const e of visibleEntries) {
        const entryPath = join(dirPath, e.name);
        const relativeName = prefix ? `${prefix}/${e.name}` : e.name;
        try {
          const s = await stat(entryPath);
          items.push({
            name: relativeName,
            type: e.isDirectory() ? 'directory' : 'file',
            size: s.size,
            modifiedAt: s.mtime.toISOString(),
            permissions: (s.mode & 0o777).toString(8),
            uid: s.uid,
            gid: s.gid,
            owner: resolveUidName(s.uid),
            group: resolveGidName(s.gid),
          });
          if (isRecursive && e.isDirectory()) {
            const subItems = await listDir(entryPath, relativeName);
            items.push(...subItems);
          }
        } catch {
          items.push({ name: relativeName, type: e.isDirectory() ? 'directory' : 'file', size: 0, modifiedAt: null, permissions: '000', uid: 0, gid: 0, owner: 'root', group: 'root' });
        }
      }
      return items;
    }

    const items = await listDir(full, '');
    // Sort: directories first, then alphabetical
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    sendJson(res, 200, { path: p, entries: items });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Directory not found');
    if (err.code === 'ENOTDIR') return sendError(res, 400, 'Not a directory');
    console.error('[handleLs]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to list directory');
  }
}

async function handleRead(req, res) {
  const { path: p } = getQuery(req.url);
  if (!p) return sendError(res, 400, 'path required');
  const full = await safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'File not found');

  try {
    const s = await stat(full);
    if (s.isDirectory()) return sendError(res, 400, 'Cannot read a directory');
    if (s.size > 10 * 1024 * 1024) return sendError(res, 413, 'File too large for inline editing (>10MB)');

    const content = await readFile(full, 'utf-8');
    sendJson(res, 200, { path: p, content, size: s.size, modifiedAt: s.mtime.toISOString() });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'File not found');
    console.error('[handleRead]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to read file');
  }
}

async function handleDownload(req, res) {
  const { path: p } = getQuery(req.url);
  if (!p) return sendError(res, 400, 'path required');
  const full = await safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'File not found');

  try {
    const s = await stat(full);
    if (s.isDirectory()) return sendError(res, 400, 'Directory download not supported yet');

    const name = basename(full);
    const encoded = encodeURIComponent(name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const mimeType = getMimeType(name);
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
      'Content-Length': s.size,
    });
    const stream = createReadStream(full);
    await pipeline(stream, res);
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'File not found');
    console.error('[handleDownload]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to download file');
  }
}

async function handleMkdir(req, res) {
  const body = await readBody(req);
  const { path: p } = body;
  if (!p) return sendError(res, 400, 'path required');
  const full = await safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    await mkdir(full, { recursive: true });
    await fsChown(full, DEFAULT_UID, DEFAULT_GID).catch(() => {});
    sendJson(res, 201, { path: p, created: true });
  } catch (err) {
    console.error('[handleMkdir]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to create directory');
  }
}

function handleUpload(_req, res) {
  // Removed 2026-04-20. See parseMultipart comment above for the full
  // story — short version: in-memory buffering OOM-killed the 128 Mi pod.
  sendError(res, 410, 'Multipart /upload removed — stream to /write-raw instead');
}

async function handleWrite(req, res) {
  const body = await readBody(req);
  const { path: p, content } = body;
  if (!p) return sendError(res, 400, 'path required');
  if (content === undefined) return sendError(res, 400, 'content required');
  const full = await safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
    await fsChown(full, DEFAULT_UID, DEFAULT_GID).catch(() => {});
    const s = await stat(full);
    sendJson(res, 200, { path: p, size: s.size, modifiedAt: s.mtime.toISOString() });
  } catch (err) {
    console.error('[handleWrite]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to write file');
  }
}

async function handleRename(req, res) {
  const body = await readBody(req);
  const { oldPath, newPath } = body;
  if (!oldPath || !newPath) return sendError(res, 400, 'oldPath and newPath required');
  const bypass = isPlatformBypass(req);
  const fullOld = await safePath(oldPath, { allowHidden: bypass });
  const fullNew = await safePath(newPath, { allowHidden: bypass });
  if (!fullOld || !fullNew) return sendError(res, 404, 'Not found');

  try {
    await rename(fullOld, fullNew);
    sendJson(res, 200, { oldPath, newPath, renamed: true });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Source not found');
    console.error('[handleRename]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to rename');
  }
}

// Deletes route through the recycle bin unless the caller explicitly opts out
// with `permanent: true`.
//
// The default is LOAD-BEARING. An absent flag must mean "trash", so any caller
// that was never updated fails to the recoverable branch rather than silently
// hard-deleting a tenant's data. (Three callers reach here: the two file routes
// and the deployment delete-with-data path.) The sidecar's own internal rm()
// calls — aborted chunked uploads, fetch-url temp files — deliberately do NOT
// come through this handler; they are platform scratch, not user data.
async function handleRm(req, res) {
  const body = await readBody(req);
  const { path: p, permanent = false, actor = null, origin, deploymentName } = body;
  if (!p) return sendError(res, 400, 'path required');
  if (p === '/' || p === '.') return sendError(res, 403, 'Cannot delete root');
  const full = await safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');
  if (full === BASE) return sendError(res, 403, 'Cannot delete root');

  try {
    if (permanent === true) {
      await rm(full, { recursive: true });
      return sendJson(res, 200, { path: p, deleted: true, trashed: false });
    }
    const entry = await trash.moveToTrash(full, relToBase(full), { actor, origin, deploymentName });
    sendJson(res, 200, { path: p, deleted: true, trashed: true, trashEntry: entry });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Not found');
    if (err.code === 'ETRASHROOT' || err.code === 'ETRASHSELF') return sendError(res, 403, err.message);
    console.error('[handleDelete]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to delete');
  }
}

// ─── Recycle-bin endpoints ───────────────────────────────────────────────────

async function handleTrashList(_req, res) {
  try {
    const entries = await trash.listTrash();
    const usedBytes = await trash.trashUsageBytes();
    sendJson(res, 200, { entries, usedBytes, usedFormatted: formatBytes(usedBytes) });
  } catch (err) {
    console.error('[handleTrashList]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to list trash');
  }
}

async function handleTrashSummary(_req, res) {
  try {
    sendJson(res, 200, await trash.trashSummary());
  } catch (err) {
    console.error('[handleTrashSummary]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to summarise trash');
  }
}

async function handleTrashRestore(req, res) {
  const body = await readBody(req);
  const { id, overwrite = false, autoRename = false } = body;
  if (!id || typeof id !== 'string') return sendError(res, 400, 'id required');
  try {
    const result = await trash.restoreFromTrash(id, { overwrite: overwrite === true, autoRename: autoRename === true });
    if (result.status !== 200) {
      return sendJson(res, result.status, { error: result.error, ...(result.conflictPath ? { conflictPath: result.conflictPath } : {}) });
    }
    sendJson(res, 200, { id: result.id, restoredTo: result.restoredTo, renamed: result.renamed });
  } catch (err) {
    console.error('[handleTrashRestore]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to restore');
  }
}

// Retention is decided by the backend (platform_settings) and arrives as a
// parameter — never baked into this pod. See FALLBACK_RETENTION_DAYS.
async function handleTrashPurge(req, res) {
  const body = await readBody(req);
  const { ids = null, all = false } = body;
  const olderThanDays = body.olderThanDays === undefined || body.olderThanDays === null
    ? (ids || all ? null : FALLBACK_RETENTION_DAYS)
    : Number(body.olderThanDays);
  if (olderThanDays !== null && (!Number.isFinite(olderThanDays) || olderThanDays < 0)) {
    return sendError(res, 400, 'olderThanDays must be a non-negative number');
  }
  if (ids !== null && !Array.isArray(ids)) return sendError(res, 400, 'ids must be an array');
  try {
    const result = await trash.purgeTrash({ olderThanDays, ids, all: all === true });
    sendJson(res, 200, { ...result, bytesFreedFormatted: formatBytes(result.bytesFreed) });
  } catch (err) {
    console.error('[handleTrashPurge]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to purge trash');
  }
}

async function handleCopy(req, res) {
  const body = await readBody(req);
  const { sourcePath, destPath } = body;
  if (!sourcePath || !destPath) return sendError(res, 400, 'sourcePath and destPath required');
  const bypass = isPlatformBypass(req);
  const fullSrc = await safePath(sourcePath, { allowHidden: bypass });
  const fullDest = await safePath(destPath, { allowHidden: bypass });
  if (!fullSrc || !fullDest) return sendError(res, 404, 'Not found');

  try {
    // Ensure parent directory exists
    await mkdir(dirname(fullDest), { recursive: true });
    await cp(fullSrc, fullDest, { recursive: true });
    sendJson(res, 200, { sourcePath, destPath, copied: true });
  } catch (err) {
    if (err.code === 'ENOENT') return sendError(res, 404, 'Source not found');
    console.error('[handleCopy]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to copy');
  }
}

async function handleArchive(req, res) {
  const body = await readBody(req);
  const { paths, destPath, format = 'tar.gz' } = body;
  if (!paths || !Array.isArray(paths) || paths.length === 0) return sendError(res, 400, 'paths array required');
  if (!destPath) return sendError(res, 400, 'destPath required');

  const bypass = isPlatformBypass(req);
  const fullDest = await safePath(destPath, { allowHidden: bypass });
  if (!fullDest) return sendError(res, 404, 'Not found');

  // Validate all source paths. Archiving a hidden path would let a
  // customer exfiltrate it in compressed form, so hidden paths stay
  // invisible unless the platform backend is the caller.
  const safePaths = [];
  for (const p of paths) {
    const full = await safePath(p, { allowHidden: bypass });
    if (!full) return sendError(res, 404, `Not found: ${p}`);
    safePaths.push(full);
  }

  if (!['zip', 'tar.gz', 'tgz', 'tar'].includes(format)) {
    return sendError(res, 400, 'Unsupported format. Use: zip, tar.gz, tar');
  }

  // Streamed like /extract: creating an archive of a large tree has exactly
  // the same "runs for minutes, emits a line per file" shape.
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
  // Counting the source tree up front would mean walking it twice, so archive
  // progress is a running file count with no percentage. Honest beats a
  // percentage derived from a guess.
  const progress = makeProgressEmitter(res, { total: null });
  res.write(JSON.stringify({ type: 'start', total: null, destPath, format }) + '\n');

  try {
    await mkdir(dirname(fullDest), { recursive: true });
    const relPaths = safePaths.map(p => p.replace(BASE + '/', ''));

    if (format === 'zip') {
      // Verbose (no -q): "  adding: <path>" per file is the progress feed.
      await runToolStreaming('zip', ['-r', fullDest, ...relPaths], {
        cwd: BASE,
        onLine: line => {
          const m = /^\s*adding:\s+(.*?)(?:\s+\(.*\))?$/.exec(line);
          if (m) progress.tick(basename(m[1].trim()));
        },
      });
    } else {
      await runToolStreaming('tar', [format === 'tar' ? 'cvf' : 'czvf', fullDest, ...relPaths], {
        cwd: BASE,
        onLine: line => progress.tick(basename(line)),
      });
    }

    const s = await stat(fullDest);
    progress.flush();
    res.write(JSON.stringify({
      type: 'complete', path: destPath, size: s.size, format, files: progress.count,
    }) + '\n');
    res.end();
  } catch (err) {
    console.error('[handleArchive]', err.message);
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'error', message: describeToolFailure(err, 'create archive') }) + '\n');
      res.end();
    }
  }
}

async function handleExtract(req, res) {
  const body = await readBody(req);
  const { path: archivePath, destPath = '/' } = body;
  if (!archivePath) return sendError(res, 400, 'path required');

  const bypass = isPlatformBypass(req);
  const fullArchive = await safePath(archivePath, { allowHidden: bypass });
  const fullDest = await safePath(destPath, { allowHidden: bypass });
  if (!fullArchive || !fullDest) return sendError(res, 404, 'Not found');

  const lower = archivePath.toLowerCase();
  const isZip = lower.endsWith('.zip');
  const isTarGz = lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
  const isTar = lower.endsWith('.tar');
  if (!isZip && !isTarGz && !isTar) {
    return sendError(res, 400, 'Unsupported archive format. Supports: .zip, .tar.gz, .tgz, .tar');
  }

  // NDJSON progress, same shape as /fetch-url and /clone-site so the panel
  // reuses its existing reader. Headers go out BEFORE the work starts, which
  // is what lets a multi-minute extraction show something immediately.
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });
  const total = isZip ? await zipEntryCount(fullArchive) : null;
  const progress = makeProgressEmitter(res, { total });
  res.write(JSON.stringify({ type: 'start', total, path: archivePath, destPath }) + '\n');

  try {
    await mkdir(fullDest, { recursive: true });

    // Verbose on purpose: this chatter IS the progress feed. runToolStreaming
    // consumes it a line at a time, so its volume no longer bounds the job.
    if (isZip) {
      await runToolStreaming('unzip', ['-o', fullArchive, '-d', fullDest], {
        onLine: line => {
          // "  inflating: path", "   creating: path", "  extracting: path"
          const m = /^\s*(?:inflating|extracting|creating|linking):\s+(.*)$/.exec(line);
          if (m) progress.tick(basename(m[1].trim()));
        },
      });
    } else {
      // tar has no cheap member count, so progress is a running total with
      // no percentage. Verbose output goes to stdout for GNU tar and stderr
      // for some busybox builds, so tick on either rather than guessing.
      await runToolStreaming('tar', [isTarGz ? 'xzvf' : 'xvf', fullArchive, '-C', fullDest], {
        onLine: line => progress.tick(basename(line)),
      });
    }

    progress.flush();
    res.write(JSON.stringify({
      type: 'complete', path: archivePath, extractedTo: destPath, extracted: true, files: progress.count,
    }) + '\n');
    res.end();
  } catch (err) {
    console.error('[handleExtract]', err.message);
    // The stream is already open, so a 500 status can no longer be sent. Say
    // WHICH failure it was as a stream event instead. The old generic message
    // cost a production investigation: "Failed to extract archive" for a valid
    // archive, on a disk with room, that extracts in 5 seconds, told the
    // operator nothing — the real cause was only in the sidecar's stderr.
    const message = err.code === 'ENOENT'
      ? 'Archive not found'
      : describeToolFailure(err, 'extract archive');
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'error', message }) + '\n');
      res.end();
    }
  }
}

async function handleWriteRaw(req, res) {
  const { path: p, offset: offsetParam, total: totalParam } = getQuery(req.url);
  if (!p) return sendError(res, 400, 'path query parameter required');
  const full = await safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');

  // Chunked-upload mode: when ?offset=N is supplied, write the
  // request body at byte offset N without truncating the file.
  // Multiple parallel chunks can land concurrently — each gets its
  // own fd opened with O_CREAT|O_WRONLY (no O_TRUNC), and pwrite via
  // FileHandle.write(buf, …, position) is atomic per-chunk.
  // After all chunks land, the file is whole.
  const offsetN = offsetParam !== undefined ? Number.parseInt(offsetParam, 10) : -1;
  const chunked = Number.isFinite(offsetN) && offsetN >= 0;

  // `?total=` is the FINAL byte length of the whole upload. Without it, a
  // chunked write over an existing LARGER file leaves the old tail attached:
  // O_CREAT|O_WRONLY never shortens the file, so re-uploading a 5 MB archive
  // over a 10 MB one of the same name yields a 10 MB file — 5 MB of new data
  // followed by 5 MB of the previous file. A zip keeps its central directory
  // at the END, so the reader finds the OLD directory and the "new" archive
  // silently reads as the old one.
  //
  // Setting the length to exactly `total` is safe from any chunk in any order:
  // every legitimate write lands inside [0, total), so ftruncate can only ever
  // discard the stale tail, never in-flight data. Doing it on every chunk
  // (rather than only offset=0) is idempotent and needs no ordering guarantee
  // between parallel chunks.
  const totalN = totalParam !== undefined ? Number.parseInt(totalParam, 10) : -1;
  const hasTotal = Number.isFinite(totalN) && totalN >= 0;

  try {
    const dir = dirname(full);
    await mkdir(dir, { recursive: true });

    if (chunked) {
      // pwrite-style write at explicit offset. Don't truncate; don't
      // append-mode (positional writes are ignored when O_APPEND is
      // set on Linux).
      const fh = await fs.promises.open(full, fs.constants.O_CREAT | fs.constants.O_WRONLY);
      try {
        if (hasTotal) await fh.truncate(totalN).catch(() => {});
        let written = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          await fh.write(buf, 0, buf.length, offsetN + written);
          written += buf.length;
        }
        // Best-effort chown on the parent's first chunk only; subsequent
        // chunks see "already-owned" no-op.
        await fsChown(full, DEFAULT_UID, DEFAULT_GID).catch(() => {});
        sendJson(res, 200, { path: p, offset: offsetN, bytes: written });
      } finally {
        await fh.close().catch(() => {});
      }
      return;
    }

    // Default mode (no offset): full overwrite, truncate to 0 first.
    const ws = createWriteStream(full);

    // Only abort on actual errors — NOT on normal 'close' events.
    // The K8s service proxy closes the request after transferring all data,
    // which races with pipeline() flushing to disk.
    let pipelineDone = false;
    req.on('error', () => {
      if (!pipelineDone) {
        ws.destroy();
        rm(full, { force: true }).catch(() => {});
      }
    });

    await pipeline(req, ws);
    pipelineDone = true;
    await fsChown(full, DEFAULT_UID, DEFAULT_GID).catch(() => {});

    const s = await stat(full);
    sendJson(res, 200, { path: p, size: s.size, modifiedAt: s.mtime.toISOString() });
  } catch (err) {
    // ECONNRESET / aborted are routine when the operator clicks Cancel
    // in the upload modal or closes the tab — not worth a stack trace.
    // Only log truly unexpected errors. Still clean up the partial file.
    if (!chunked) rm(full, { force: true }).catch(() => {});
    if (err.code !== 'ECONNRESET' && err.message !== 'aborted') {
      console.error('[handleWriteRaw]', err.message);
    }
    if (!res.headersSent) sendError(res, 500, 'Failed to write file');
  }
}

async function handleGitClone(req, res) {
  const body = await readBody(req);
  const { url, destPath } = body;
  if (!url) return sendError(res, 400, 'url required');
  if (!destPath) return sendError(res, 400, 'destPath required');

  // Basic URL validation — only allow https protocol
  if (!/^https:\/\//i.test(url)) {
    return sendError(res, 400, 'Only https protocol URLs are allowed');
  }
  // SSRF: refuse git remotes that resolve to internal/metadata addresses.
  let gitHost;
  try { gitHost = new URL(url).hostname; } catch { return sendError(res, 400, 'Invalid URL'); }
  try {
    await assertPublicHostname(gitHost);
  } catch (err) {
    if (err.code === 'EBLOCKEDADDR') return sendError(res, 403, 'URL not allowed (internal/local address)');
    return sendError(res, 400, `Could not resolve host: ${gitHost}`);
  }

  const fullDest = await safePath(destPath, { allowHidden: isPlatformBypass(req) });
  if (!fullDest) return sendError(res, 404, 'Not found');

  try {
    await mkdir(dirname(fullDest), { recursive: true });
    // Same buffer class as the archive tools: git writes clone progress and
    // every "Cloning into…"/warning to stderr, which execFile caps at the same
    // 1 MiB. Progress is normally suppressed when stdout is not a TTY, so this
    // has not bitten — but a repo with thousands of LFS or checkout warnings
    // would fail with a message about buffers rather than about git.
    await runTool('git', ['clone', '--depth', '1', '--', url, fullDest], {
      timeout: 300_000, // 5 min for large repos
      // GIT_TERMINAL_PROMPT=0 blocks auth prompts; GIT_ALLOW_PROTOCOL=https
      // restricts git to the https transport (no ext::/file:: smuggling).
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https' },
    });
    sendJson(res, 201, { url, destPath, cloned: true });
  } catch (err) {
    console.error('[handleGitClone]', err.message);
    if (!res.headersSent) sendError(res, 500, describeToolFailure(err, 'clone repository'));
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Parse `df -B1 <path>` into { totalBytes, availableBytes }.
 *
 * busybox df WRAPS a long device name onto its own line and puts the numbers on
 * the next one, indented:
 *
 *   Filesystem           1-blocks       Used Available Use% Mounted on
 *   /dev/longhorn/pvc-00dd3bb7-3afb-4bc5-bf52-6f460be2af7a
 *                        2080374784  73768960 2006605824   4% /data
 *
 * Every Longhorn PVC device path is long enough to trigger that wrap, so the
 * old `dfLines[1].split(/\s+/)[1]` read the DEVICE NAME line, got `undefined`,
 * and `parseInt(undefined) || 0` silently reported **0 B total / 0 B available**
 * for every tenant. `du` still reported real usage, so the panel drew a quota
 * bar of "X used of 0 B".
 *
 * Parse from the END of the fields instead of the start: the last five columns
 * are always `1-blocks Used Available Use% MountedOn`, whether or not the device
 * name wrapped. Joining the lines first makes the wrap irrelevant.
 */
function parseDf(dfOut) {
  const lines = dfOut.trim().split('\n');
  // Drop the header, then join what remains — a wrapped device name and its
  // numbers become one logical row.
  const fields = lines.slice(1).join(' ').trim().split(/\s+/);
  // …<device> <total> <used> <avail> <use%> <mountpoint>
  const mountIdx = fields.length - 1;
  const totalBytes = parseInt(fields[mountIdx - 4], 10) || 0;
  const availableBytes = parseInt(fields[mountIdx - 2], 10) || 0;
  return { totalBytes, availableBytes };
}

async function handleDiskUsage(req, res) {
  try {
    // Use du for actual bytes used — runs as root so it can read all dirs
    // (database data owned by mysql/postgres user).
    const { stdout: duOut } = await execFileAsync('du', ['-sb', BASE], { timeout: 30_000 });
    const usedBytes = parseInt(duOut.split('\t')[0], 10) || 0;

    // df gives PVC capacity on real block storage (correct in production).
    // On local-path provisioner (local dev), it returns host FS size — acceptable trade-off.
    const { stdout: dfOut } = await execFileAsync('df', ['-B1', BASE], { timeout: 10_000 });
    const { totalBytes, availableBytes } = parseDf(dfOut);

    // The recycle bin has NO size cap by design — an automatic size-driven
    // purge would delete one tenant's files because another filled the bin.
    // Transparency is the control instead, so the trash share of `usedBytes`
    // is always reported (it is a SUBSET of it, not an addition).
    const trashBytes = await trash.trashUsageBytes();

    sendJson(res, 200, {
      usedBytes,
      totalBytes,
      availableBytes,
      trashBytes,
      usedFormatted: formatBytes(usedBytes),
      totalFormatted: formatBytes(totalBytes),
      availableFormatted: formatBytes(availableBytes),
      trashFormatted: formatBytes(trashBytes),
    });
  } catch (err) {
    console.error('[handleDiskUsage]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to get disk usage');
  }
}

async function handleFolderSize(req, res) {
  const { path: p } = getQuery(req.url);
  if (!p) return sendError(res, 400, 'path query parameter required');
  const full = await safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Not found');

  try {
    const s = await stat(full);
    if (!s.isDirectory()) return sendError(res, 400, 'Path is not a directory');

    // Runs as root — can read all dirs including database data
    const { stdout } = await execFileAsync('du', ['-sb', full], { timeout: 60_000 });
    const sizeBytes = parseInt(stdout.split('\t')[0], 10) || 0;

    sendJson(res, 200, {
      path: p,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
    });
  } catch (err) {
    console.error('[handleFolderSize]', err.message);
    if (!res.headersSent) sendError(res, 500, 'Failed to get folder size');
  }
}

const MAX_JSON_BODY = 10 * 1024 * 1024; // 10 MB cap for JSON-body endpoints

async function readBody(req) {
  const chunks = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > MAX_JSON_BODY) {
      // Drain the rest of the stream so the connection closes cleanly
      req.destroy();
      throw Object.assign(new Error('Request body exceeds 10 MB limit'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString();
  try { return JSON.parse(raw); } catch { return {}; }
}

// ─── Permissions & Ownership ─────────────────────────────────────────────────

async function handleChmod(req, res) {
  const body = await readBody(req);
  const { path: p, mode, recursive } = body;
  if (!p) return sendError(res, 400, 'path is required');
  if (!mode || !/^[0-7]{3,4}$/.test(String(mode))) return sendError(res, 400, 'mode must be an octal string (e.g. "755")');
  const full = await safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Path not found');

  try {
    let changed = 0;
    if (recursive) {
      // Same limits the archive tools hit: a fixed 60s total timeout and
      // execFile's 1 MiB buffer. `chmod -R` over a CMS tree of tens of
      // thousands of files can exceed 60s on network storage, and the SIGTERM
      // leaves permissions HALF APPLIED behind a generic error.
      //
      // -v makes busybox emit a line per file, which does two things: it feeds
      // the idle timer (a silent tool would trip it instantly) and it gives an
      // accurate count to report back.
      await runToolStreaming('chmod', ['-Rv', String(mode), full], {
        onLine: () => { changed++; },
      });
    } else {
      await runTool('chmod', [String(mode), full]);
      changed = 1;
    }
    sendJson(res, 200, { path: p, mode: String(mode), recursive: !!recursive, changed });
  } catch (err) {
    console.error('[handleChmod]', err.message);
    sendError(res, 500, describeToolFailure(err, 'change permissions'));
  }
}

async function handleChown(req, res) {
  const body = await readBody(req);
  const { path: p, uid, gid, owner: ownerName, group: groupName, recursive } = body;
  if (!p) return sendError(res, 400, 'path is required');

  // Resolve name strings to numeric UIDs/GIDs (Alpine may not have all users in /etc/passwd)
  let resolvedUid = uid;
  let resolvedGid = gid;
  if (ownerName) {
    // Reverse lookup: name → uid from our cache
    for (const [id, name] of uidNameCache) {
      if (name === ownerName) { resolvedUid = id; break; }
    }
    if (resolvedUid === undefined) {
      // Try parsing as number
      const parsed = parseInt(ownerName, 10);
      if (!isNaN(parsed)) resolvedUid = parsed;
      else return sendError(res, 400, `Unknown user: ${ownerName}`);
    }
  }
  if (groupName) {
    for (const [id, name] of gidNameCache) {
      if (name === groupName) { resolvedGid = id; break; }
    }
    if (resolvedGid === undefined) {
      const parsed = parseInt(groupName, 10);
      if (!isNaN(parsed)) resolvedGid = parsed;
      else return sendError(res, 400, `Unknown group: ${groupName}`);
    }
  }

  const ownerSpec = `${resolvedUid ?? ''}:${resolvedGid ?? ''}`;
  if (ownerSpec === ':') return sendError(res, 400, 'uid/owner or gid/group is required');

  const full = await safePath(p, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Path not found');

  try {
    let changed = 0;
    if (recursive) {
      // See handleChmod: fixed total timeout + 1 MiB buffer, replaced by an
      // idle timer that -v keeps alive.
      await runToolStreaming('chown', ['-Rv', ownerSpec, full], {
        onLine: () => { changed++; },
      });
    } else {
      await runTool('chown', [ownerSpec, full]);
      changed = 1;
    }
    sendJson(res, 200, { path: p, uid, gid, recursive: !!recursive, changed });
  } catch (err) {
    console.error('[handleChown]', err.message);
    sendError(res, 500, describeToolFailure(err, 'change ownership'));
  }
}

// ─── SSRF prevention (shared by fetch-url, clone-site, git-clone) ────────────
//
// The file-manager runs in a tenant namespace with UNRESTRICTED egress, so any
// outbound fetch it performs is an SSRF pivot into the cluster's internal
// network and the cloud metadata endpoint. A regex blocklist on the URL string
// is not enough — it misses 169.254.169.254 (metadata), IPv6, alternate IP
// encodings, and DNS names that resolve to internal IPs (DNS rebinding), and it
// is not re-checked on redirects. We instead validate the ACTUAL resolved IP at
// connect time via a custom `lookup`, which is re-run on every redirect hop and
// closes the rebind gap (the connection uses the same IP we validated).

function ipIsInternal(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0) return true;                                   // 0.0.0.0/8 "this host"
    if (o[0] === 127) return true;                                 // loopback
    if (o[0] === 10) return true;                                  // private
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;     // private
    if (o[0] === 192 && o[1] === 168) return true;                 // private
    if (o[0] === 169 && o[1] === 254) return true;                 // link-local + cloud metadata
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;    // CGNAT (k8s/cloud)
    return false;
  }
  if (v === 6) {
    const lo = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lo === '::1' || lo === '::') return true;                  // loopback / unspecified
    if (lo.startsWith('::ffff:')) return ipIsInternal(lo.slice(7)); // v4-mapped
    const h0 = parseInt(lo.split(':')[0] || '0', 16);
    if (h0 >= 0xfe80 && h0 <= 0xfebf) return true;                 // link-local fe80::/10
    if ((h0 & 0xfe00) === 0xfc00) return true;                     // unique-local fc00::/7
    if (h0 === 0x2002) return true;                                // 6to4 (RFC 3056) can embed internal v4
    return false;
  }
  return true; // not a literal IP after lookup → fail closed
}

// Reject a URL whose host is a LITERAL internal IP. Necessary because node's
// http(s).get skips the `lookup` callback entirely when the host is already an
// IP literal — so `safeLookup` alone would never see `http://169.254.169.254/`
// or `http://127.0.0.1/`. Must be re-checked on every redirect hop.
// (Hostnames that RESOLVE to internal IPs are handled by safeLookup at connect.)
function urlHostIsInternalLiteral(urlStr) {
  let host;
  try { host = new URL(urlStr).hostname; } catch { return true; } // unparseable → block
  // URL keeps the brackets on IPv6 literals ("[::1]") — strip them for isIP.
  host = host.replace(/^\[|\]$/g, '');
  return isIP(host) !== 0 && ipIsInternal(host);
}

// Custom DNS lookup that REFUSES to resolve to an internal address. Passed to
// http(s).get so the validated IP is the one actually connected to (no rebind).
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'object' && options ? options : {};
  dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    for (const a of list) {
      if (ipIsInternal(a.address)) {
        return callback(Object.assign(new Error(`Blocked internal address ${a.address} for ${hostname}`), { code: 'EBLOCKEDADDR' }));
      }
    }
    const first = list[0];
    if (opts.all) return callback(null, list);
    callback(null, first.address, first.family);
  });
}

// For tools we can't inject a lookup into (git): resolve up front and reject if
// any address is internal. Residual rebind window is acceptable for git (https
// only, lower value than the streaming fetchers).
async function assertPublicHostname(hostname) {
  const { lookup } = await import('node:dns/promises');
  const addrs = await lookup(hostname, { all: true });
  for (const a of addrs) {
    if (ipIsInternal(a.address)) {
      throw Object.assign(new Error(`Refusing to connect to internal address ${a.address} (${hostname})`), { code: 'EBLOCKEDADDR' });
    }
  }
}

async function handleFetchUrl(req, res) {
  const { statfs } = await import('node:fs/promises');
  const body = await readBody(req);
  const { url, path: destPath, force } = body;
  if (!url) return sendError(res, 400, 'url required');
  if (!destPath) return sendError(res, 400, 'path required');

  // Security: only http(s); SSRF to internal/metadata addresses is blocked by a
  // literal-IP pre-check (below) plus `safeLookup` for hostnames — both
  // re-applied on every redirect hop inside fetchWithRedirects.
  if (!/^https?:\/\//i.test(url)) {
    return sendError(res, 400, 'Only http:// and https:// URLs are supported');
  }
  if (urlHostIsInternalLiteral(url)) {
    return sendError(res, 403, 'URL not allowed (internal/local address)');
  }

  const full = await safePath(destPath, { allowHidden: isPlatformBypass(req) });
  if (!full) return sendError(res, 404, 'Destination path not allowed');

  try {
    await mkdir(dirname(full), { recursive: true });

    // Check available disk space on PVC
    const fsStats = await statfs(BASE);
    const freeBytes = fsStats.bsize * fsStats.bavail;

    async function fetchWithRedirects(fetchUrl, maxRedirects = 5) {
      if (!/^https?:\/\//i.test(fetchUrl)) { throw new Error('redirect to non-http(s) scheme blocked'); }
      if (urlHostIsInternalLiteral(fetchUrl)) { throw new Error(`Blocked internal address ${new URL(fetchUrl).hostname}`); }
      const fetchProto = fetchUrl.startsWith('https') ? await import('node:https') : await import('node:http');
      return new Promise((resolve, reject) => {
        // lookup: safeLookup → the resolved IP is validated as non-internal on
        // EVERY hop (initial + each redirect), closing the redirect-SSRF and
        // DNS-rebind gaps.
        fetchProto.default.get(fetchUrl, { timeout: 60000, lookup: safeLookup }, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
            response.resume();
            const next = new URL(response.headers.location, fetchUrl).href; // resolve relative redirects
            resolve(fetchWithRedirects(next, maxRedirects - 1));
            return;
          }
          resolve(response);
        }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Download timed out (60s)')); });
      });
    }

    await new Promise((resolve, reject) => {
      fetchWithRedirects(url).then((response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }

        const contentLength = parseInt(response.headers['content-length'] || '0', 10);

        // Check against PVC free space (not a hardcoded limit)
        if (contentLength > 0) {
          const usagePercent = ((contentLength / freeBytes) * 100);
          if (usagePercent > 90) {
            response.destroy();
            reject(new Error(`Not enough disk space. File is ${formatBytes(contentLength)} but only ${formatBytes(freeBytes)} free (would use ${Math.round(usagePercent)}% of remaining space).`));
            return;
          }
          if (usagePercent > 70 && !force) {
            response.destroy();
            sendJson(res, 200, {
              type: 'warning',
              message: `This file (${formatBytes(contentLength)}) will use ${Math.round(usagePercent)}% of remaining disk space (${formatBytes(freeBytes)} free). Continue?`,
              fileSize: contentLength,
              fileSizeFormatted: formatBytes(contentLength),
              freeSpace: freeBytes,
              freeSpaceFormatted: formatBytes(freeBytes),
              usagePercent: Math.round(usagePercent),
              needsConfirmation: true,
            });
            resolve();
            return;
          }
        }

        // Stream response with progress
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });

        const ws = createWriteStream(full);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          // Runtime check: stop if we'd exceed 95% of free space during download
          if (downloaded > freeBytes * 0.95) {
            response.destroy();
            ws.destroy();
            rm(full).catch(() => {});
            res.write(JSON.stringify({ type: 'error', message: `Download stopped: approaching disk space limit (${formatBytes(freeBytes)} free)` }) + '\n');
            res.end();
            return;
          }
          ws.write(chunk);
          res.write(JSON.stringify({
            type: 'progress',
            downloaded,
            total: contentLength || null,
            percent: contentLength ? Math.round((downloaded / contentLength) * 100) : null,
          }) + '\n');
        });

        response.on('end', async () => {
          ws.end();
          await fsChown(full, DEFAULT_UID, DEFAULT_GID).catch(() => {});
          const s = await stat(full);
          res.write(JSON.stringify({
            type: 'complete',
            path: destPath,
            size: s.size,
            sizeFormatted: formatBytes(s.size),
          }) + '\n');
          res.end();
          resolve();
        });

        response.on('error', (err) => {
          ws.destroy();
          reject(err);
        });
      }).catch(reject);
    });
  } catch (err) {
    // Clean up partial file
    await rm(full).catch(() => {});
    if (!res.headersSent) {
      sendError(res, 500, `Download failed: ${err.message}`);
    } else {
      res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
      res.end();
    }
  }
}

// ─── Pretty-print formatter (no deps) ───────────────────────────────────────

function prettifyHtml(html) {
  const voidTags = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
  const inlineTags = new Set(['a','abbr','b','bdi','bdo','cite','code','data','em','i','kbd','mark','q','s','small','span','strong','sub','sup','time','u','var']);
  let indent = 0;
  const lines = [];
  // Split on tags while preserving them
  const tokens = html.replace(/>\s+</g, '>\n<').split('\n');
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    // Closing tag
    if (/^<\//.test(trimmed)) {
      indent = Math.max(0, indent - 1);
      lines.push('  '.repeat(indent) + trimmed);
    }
    // Self-closing or void tag
    else if (/\/>$/.test(trimmed) || voidTags.has((trimmed.match(/^<(\w+)/)?.[1] ?? '').toLowerCase())) {
      lines.push('  '.repeat(indent) + trimmed);
    }
    // Opening tag
    else if (/^<\w/.test(trimmed)) {
      lines.push('  '.repeat(indent) + trimmed);
      // Only indent if not inline and not a tag that closes on the same line
      const tagName = (trimmed.match(/^<(\w+)/)?.[1] ?? '').toLowerCase();
      if (!inlineTags.has(tagName) && !trimmed.includes('</')) {
        indent++;
      }
    }
    // Text or other content
    else {
      lines.push('  '.repeat(indent) + trimmed);
    }
  }
  return lines.join('\n');
}

function prettifyCss(css) {
  let result = css;
  // Add newlines after { and ;
  result = result.replace(/\{/g, ' {\n').replace(/\}/g, '\n}\n').replace(/;/g, ';\n');
  // Indent
  let indent = 0;
  const lines = result.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('}')) indent = Math.max(0, indent - 1);
    const formatted = '  '.repeat(indent) + trimmed;
    if (trimmed.endsWith('{')) indent++;
    return formatted;
  }).filter(Boolean);
  return lines.join('\n');
}

function prettifyJs(js) {
  // Basic: add newlines after { } ; and indent
  let result = js;
  result = result.replace(/\{/g, ' {\n').replace(/\}/g, '\n}\n').replace(/;(?!\s*[\n}])/g, ';\n');
  let indent = 0;
  const lines = result.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('}')) indent = Math.max(0, indent - 1);
    const formatted = '  '.repeat(indent) + trimmed;
    if (trimmed.endsWith('{')) indent++;
    return formatted;
  }).filter(Boolean);
  return lines.join('\n');
}

function prettifyContent(content, filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'html' || ext === 'htm') return prettifyHtml(content);
  if (ext === 'css' || ext === 'scss') return prettifyCss(content);
  if (ext === 'js' || ext === 'mjs') return prettifyJs(content);
  return content;
}

function shouldPrettify(filePath, html, css, js) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if ((ext === 'html' || ext === 'htm') && html) return true;
  if ((ext === 'css' || ext === 'scss') && css) return true;
  if ((ext === 'js' || ext === 'mjs') && js) return true;
  return false;
}

// ─── Clone Site (website scraper) ────────────────────────────────────────────

async function handleCloneSite(req, res) {
  const body = await readBody(req);
  const { url, path: destPath, maxPages = 50, maxDepth = 3, prettifyHtml = false, prettifyCss = false, prettifyJs = false } = body;
  if (!url) return sendError(res, 400, 'url required');
  if (!destPath) return sendError(res, 400, 'path required');
  if (!/^https?:\/\//i.test(url)) return sendError(res, 400, 'Only http/https URLs supported');

  const full = await safePath(destPath, { allowHidden: false });
  if (!full) return sendError(res, 404, 'Destination path not allowed');

  const clampedMaxPages = Math.min(Math.max(1, maxPages), 500);
  const clampedMaxDepth = Math.min(Math.max(1, maxDepth), 10);

  // Check disk space
  const { statfs: statfsAsync } = await import('node:fs/promises');
  const fsStats = await statfsAsync(BASE);
  const freeBytes = fsStats.bsize * fsStats.bavail;
  if (freeBytes < 50 * 1024 * 1024) {
    return sendError(res, 507, 'Less than 50MB free disk space — cannot clone');
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' });

  let aborted = false;
  req.on('close', () => { aborted = true; });

  const send = (obj) => { if (!aborted) try { res.write(JSON.stringify(obj) + '\n'); } catch {} };

  try {
    await mkdir(full, { recursive: true });

    const baseUrl = new URL(url);
    const baseOrigin = baseUrl.origin;
    const visited = new Set();
    const queue = [{ url: baseUrl.href, depth: 0 }];
    let pagesDownloaded = 0;
    let assetsDownloaded = 0;
    const assetQueue = [];

    // Fetch helper with redirect following
    function fetchUrl(fetchUrl) {
      return new Promise((resolve, reject) => {
        const doFetch = (u, redirects = 0) => {
          if (!/^https?:\/\//i.test(u)) { reject(new Error('non-http(s) scheme blocked')); return; }
          if (urlHostIsInternalLiteral(u)) { reject(new Error('blocked internal address')); return; }
          // Pick the module matching THIS url's scheme (a redirect can switch
          // http↔https), not the initial one.
          const p = u.startsWith('https') ? import('node:https') : import('node:http');
          Promise.resolve(p).then(mod => mod.default).then(mod => {
            mod.get(u, { timeout: 15000, lookup: safeLookup, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SiteCloner/1.0)' } }, (r) => {
              if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && redirects < 5) {
                r.resume();
                const loc = new URL(r.headers.location, u).href;
                doFetch(loc, redirects + 1);
              } else {
                resolve(r);
              }
            }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
          });
        };
        doFetch(fetchUrl);
      });
    }

    // Collect response body as buffer
    async function fetchBody(u) {
      const response = await fetchUrl(u);
      if (response.statusCode !== 200) { response.resume(); return null; }
      const chunks = [];
      let size = 0;
      return new Promise((resolve) => {
        response.on('data', (c) => { size += c.length; if (size > 20 * 1024 * 1024) { response.destroy(); resolve(null); } else chunks.push(c); });
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', () => resolve(null));
      });
    }

    // URL to local file path
    function urlToPath(u) {
      try {
        const parsed = new URL(u);
        let p = parsed.pathname;
        if (p.endsWith('/')) p += 'index.html';
        if (!p.includes('.') && !p.endsWith('/')) p += '/index.html';
        return p.replace(/^\//, '');
      } catch { return null; }
    }

    // Extract links from HTML
    function extractLinks(html, pageUrl) {
      const links = { pages: [], assets: [] };
      // Pages: <a href="...">
      for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)/gi)) {
        try {
          const abs = new URL(m[1], pageUrl).href;
          if (abs.startsWith(baseOrigin) && !abs.includes('#')) links.pages.push(abs.split('?')[0].split('#')[0]);
        } catch {}
      }
      // CSS: <link rel="stylesheet" href="...">
      for (const m of html.matchAll(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
        if (m[0].includes('stylesheet') || m[1].endsWith('.css')) {
          try { links.assets.push(new URL(m[1], pageUrl).href); } catch {}
        }
      }
      // Scripts: <script src="...">
      for (const m of html.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
        try { links.assets.push(new URL(m[1], pageUrl).href); } catch {}
      }
      // Images: <img src="...">, srcset, background-image
      for (const m of html.matchAll(/(?:src|srcset|poster)\s*=\s*["']([^"'\s,]+)/gi)) {
        try { const abs = new URL(m[1], pageUrl).href; if (!abs.startsWith('data:')) links.assets.push(abs); } catch {}
      }
      // CSS url() references
      for (const m of html.matchAll(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
        try { const abs = new URL(m[1], pageUrl).href; if (!abs.startsWith('data:')) links.assets.push(abs); } catch {}
      }
      // Favicon
      for (const m of html.matchAll(/<link[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
        if (m[0].includes('icon')) { try { links.assets.push(new URL(m[1], pageUrl).href); } catch {} }
      }
      return links;
    }

    // Rewrite URLs in content to relative paths
    function rewriteUrls(content, pageUrl) {
      let result = content;
      // Replace absolute URLs with relative paths
      const pageDir = dirname(urlToPath(pageUrl) || 'index.html');
      result = result.replace(new RegExp(baseOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(/[^"\'\\s)]*)', 'g'), (match, path) => {
        const targetFile = urlToPath(baseOrigin + path) || path.slice(1);
        const rel = relative(pageDir, targetFile) || targetFile;
        return rel;
      });
      return result;
    }

    send({ type: 'status', message: `Starting crawl of ${baseOrigin}`, maxPages: clampedMaxPages, maxDepth: clampedMaxDepth });

    // BFS crawl pages
    while (queue.length > 0 && pagesDownloaded < clampedMaxPages && !aborted) {
      const { url: pageUrl, depth } = queue.shift();
      const normalized = pageUrl.split('?')[0].split('#')[0];
      if (visited.has(normalized)) continue;
      visited.add(normalized);

      send({ type: 'crawling', url: normalized, depth, pagesDownloaded, pagesQueued: queue.length });

      const bodyBuf = await fetchBody(normalized);
      if (!bodyBuf) continue;

      const localPath = urlToPath(normalized) || 'index.html';
      const fullPath = join(full, localPath);
      await mkdir(dirname(fullPath), { recursive: true });

      // Detect binary files — skip text processing for non-text files
      const isBinary = /\.(jpg|jpeg|png|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg|pdf|zip|gz|tar|exe|dll|so|dylib)$/i.test(localPath);

      if (isBinary) {
        // Write binary files directly — no UTF-8 conversion
        await writeFile(fullPath, bodyBuf);
        await fsChown(fullPath, DEFAULT_UID, DEFAULT_GID).catch(() => {});
        assetsDownloaded++;
        send({ type: 'asset', url: normalized, path: localPath, current: assetsDownloaded, total: 0 });
        continue;
      }

      const html = bodyBuf.toString('utf-8');

      // Extract links before rewriting
      const links = extractLinks(html, normalized);

      // Rewrite URLs and save
      const rewritten = rewriteUrls(html, normalized);
      const finalContent = shouldPrettify(localPath, prettifyHtml, prettifyCss, prettifyJs) ? prettifyContent(rewritten, localPath) : rewritten;
      await writeFile(fullPath, finalContent, 'utf-8');
      await fsChown(fullPath, DEFAULT_UID, DEFAULT_GID).catch(() => {});
      pagesDownloaded++;

      send({ type: 'page', url: normalized, path: localPath, size: bodyBuf.length, pagesDownloaded, totalDiscovered: visited.size + queue.length });

      // Queue internal page links
      if (depth < clampedMaxDepth) {
        for (const link of links.pages) {
          const norm = link.split('?')[0].split('#')[0];
          if (!visited.has(norm) && !queue.some(q => q.url === norm)) {
            queue.push({ url: norm, depth: depth + 1 });
          }
        }
      }

      // Queue assets
      for (const asset of links.assets) {
        if (!visited.has(asset)) assetQueue.push(asset);
      }
    }

    // Download assets
    const uniqueAssets = [...new Set(assetQueue)].filter(a => !visited.has(a));
    send({ type: 'status', message: `Downloading ${uniqueAssets.length} assets...` });

    for (let i = 0; i < uniqueAssets.length && !aborted; i++) {
      const assetUrl = uniqueAssets[i];
      visited.add(assetUrl);

      const localPath = urlToPath(assetUrl);
      if (!localPath) continue;

      send({ type: 'asset', url: assetUrl, path: localPath, current: i + 1, total: uniqueAssets.length });

      const assetBuf = await fetchBody(assetUrl);
      if (!assetBuf) continue;

      const fullPath = join(full, localPath);
      await mkdir(dirname(fullPath), { recursive: true });
      // Prettify text assets if enabled per-type
      const isTextAsset = /\.(css|scss|js|mjs|html?|svg|xml)$/i.test(localPath);
      if (isTextAsset && shouldPrettify(localPath, prettifyHtml, prettifyCss, prettifyJs)) {
        await writeFile(fullPath, prettifyContent(assetBuf.toString('utf-8'), localPath), 'utf-8');
      } else {
        await writeFile(fullPath, assetBuf);
      }
      await fsChown(fullPath, DEFAULT_UID, DEFAULT_GID).catch(() => {});
      assetsDownloaded++;

      // Parse CSS for additional url() references
      if (localPath.endsWith('.css')) {
        const cssText = assetBuf.toString('utf-8');
        for (const m of cssText.matchAll(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
          try {
            const abs = new URL(m[1], assetUrl).href;
            if (!abs.startsWith('data:') && !visited.has(abs)) {
              uniqueAssets.push(abs);
            }
          } catch {}
        }
      }
    }

    send({
      type: 'complete',
      pagesDownloaded,
      assetsDownloaded,
      totalFiles: pagesDownloaded + assetsDownloaded,
      path: destPath,
      message: `Cloned ${pagesDownloaded} pages and ${assetsDownloaded} assets`,
    });
  } catch (err) {
    send({ type: 'error', message: err.message });
  }

  res.end();
}

// ─── Router ──────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const path = getPath(req.url);
  const method = req.method;

  try {
    if (path === '/health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok' });
    }

    // Authentication gate — every non-health route requires the platform
    // secret. Enforced whenever the sidecar has a secret configured (always
    // true on a bootstrapped cluster: platform-api derives + injects it per
    // tenant namespace). When the secret is somehow absent we log loudly and
    // continue serving so an unusual secret-less local setup is not bricked —
    // the narrowed NetworkPolicy remains the primary control in that case.
    if (PLATFORM_INTERNAL_SECRET) {
      if (!isAuthenticated(req)) {
        return sendError(res, 403, 'Forbidden');
      }
    } else if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn('[file-manager] PLATFORM_INTERNAL_SECRET is not set — request authentication is DISABLED; relying on NetworkPolicy only');
    }

    if (path === '/ls' && method === 'GET') return handleLs(req, res);
    if (path === '/read' && method === 'GET') return handleRead(req, res);
    if (path === '/download' && method === 'GET') return handleDownload(req, res);
    if (path === '/mkdir' && method === 'POST') return handleMkdir(req, res);
    if (path === '/upload' && method === 'POST') return handleUpload(req, res);
    if (path === '/write' && method === 'POST') return handleWrite(req, res);
    if (path === '/rename' && method === 'POST') return handleRename(req, res);
    if (path === '/rm' && (method === 'DELETE' || method === 'POST')) return handleRm(req, res);
    if (path === '/trash/list' && method === 'GET') return handleTrashList(req, res);
    if (path === '/trash/summary' && method === 'GET') return handleTrashSummary(req, res);
    if (path === '/trash/restore' && method === 'POST') return handleTrashRestore(req, res);
    if (path === '/trash/purge' && method === 'POST') return handleTrashPurge(req, res);
    if (path === '/write-raw' && method === 'POST') return handleWriteRaw(req, res);
    if (path === '/copy' && method === 'POST') return handleCopy(req, res);
    if (path === '/archive' && method === 'POST') return handleArchive(req, res);
    if (path === '/extract' && method === 'POST') return handleExtract(req, res);
    if (path === '/git-clone' && method === 'POST') return handleGitClone(req, res);
    if (path === '/disk-usage' && method === 'GET') return handleDiskUsage(req, res);
    if (path === '/folder-size' && method === 'GET') return handleFolderSize(req, res);
    if (path === '/chmod' && method === 'POST') return handleChmod(req, res);
    if (path === '/chown' && method === 'POST') return handleChown(req, res);
    if (path === '/fetch-url' && method === 'POST') return handleFetchUrl(req, res);
    if (path === '/clone-site' && method === 'POST') return handleCloneSite(req, res);

    sendError(res, 404, 'Not found');
  } catch (err) {
    if (!res.headersSent) {
      if (err.code === 'BODY_TOO_LARGE') {
        sendError(res, 413, err.message);
      } else {
        console.error('[router]', err.message);
        sendError(res, 500, 'Internal error');
      }
    }
  }
});

// Don't bind a port when imported by the unit tests (FM_NO_LISTEN=1).
if (process.env.FM_NO_LISTEN !== '1') {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`File manager sidecar listening on :${PORT}`);
  });
}

// Exported for unit tests (node --test). These are pure helpers — importing
// the module with FM_NO_LISTEN=1 does not start the server.
// `server` is exported so a test can bind it on an ephemeral port
// (`server.listen(0)`) and drive real HTTP requests through the router,
// instead of racing the fixed :8111 with a parallel test file.
export { withinBase, confineRealpath, safePath, ipIsInternal, urlHostIsInternalLiteral, isHidden, relToBase, BASE, server, parseDf, trash };
