// Recycle bin for the file-manager sidecar.
//
// WHY A ROOT-LEVEL TRASH: the tenant PVC is ONE filesystem mounted at /data,
// and deployments mount subPaths of it (/data/runtimes/<runtime>/<site>,
// /data/applications/<app>/<name>/…). That buys two properties nothing else
// does:
//
//   1. `rename()` is atomic and O(1) — trashing a 20 GB directory is instant
//      and consumes no extra space. A copy-based trash would double the PVC.
//   2. /data/.trash is a SIBLING of every docroot, so a trashed `shell.php`
//      stops being web-reachable. A per-directory `.Trash` (macOS style) would
//      leave it live at https://site/.Trash/shell.php.
//
// Layout — payload and metadata are separate trees sharded by deletion month
// so no single directory grows without bound (handleLs stat()s every entry):
//
//   /data/.trash/files/<yyyy-mm>/<id>          the moved file or directory
//   /data/.trash/info/<yyyy-mm>/<id>.json      { originalPath, deletedAt, … }
//
// `id` is `<epochMs>-<8 hex>`: unique (two `index.php` from different
// directories must not collide), sortable, and the shard is derivable from it
// without a scan.
//
// THE PAYLOAD TREE IS THE SOURCE OF TRUTH. listTrash() walks files/ and joins
// info/ where present, so a payload whose metadata write failed still shows up
// and is still restorable — it just restores to a fallback path. Deriving
// state from observed contents (rather than a DB table that can drift from the
// PVC) is what makes this self-healing across tenant-bundle restores, which
// bring the trash back with the rest of /data.
//
// This module is a factory rather than a plain import: server.mjs owns BASE,
// safePath and confineRealpath, and importing them here would be circular
// (server.mjs has top-level await). Dependencies come in, handlers come out.

import { readdir, stat, lstat, readFile, writeFile, mkdir, rm, rename, chown as fsChown, unlink } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const TRASH_DIRNAME = '.trash';

/** Directory-size probe cap. A trashed dir is already moved by the time we
 *  measure, so a slow `du` must never fail or stall the delete — it just
 *  yields a null size and the UI offers an on-demand calculation. */
const DU_TIMEOUT_MS = 5_000;

/** Belt-and-braces floor if a caller ever omits `olderThanDays`. Retention is
 *  owned by the backend (a platform_settings row) and travels as a request
 *  parameter — the sidecar must never be the authority, because the FM
 *  Deployment's drift check does not compare env, so a pod-baked value would
 *  freeze at creation time and never see an admin change. */
export const FALLBACK_RETENTION_DAYS = 14;

function shardFor(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function newId(now) {
  return `${now.getTime()}-${randomBytes(4).toString('hex')}`;
}

/** Recover the shard from an id without scanning. Falls back to null when the
 *  id is not in our format (hand-created entry, future format change). */
function shardFromId(id) {
  const epoch = Number(String(id).split('-')[0]);
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const d = new Date(epoch);
  return Number.isNaN(d.getTime()) ? null : shardFor(d);
}

/** `foo/bar.txt` → `foo/bar (restored).txt`; `foo/bar` → `foo/bar (restored)`.
 *  Dotfiles (`.env`) have no extension by extname()'s reckoning, which is what
 *  we want — `.env (restored)`, not `(restored).env`. */
function suffixName(relPath, n) {
  const tag = n === 1 ? ' (restored)' : ` (restored ${n})`;
  const dir = dirname(relPath);
  const base = basename(relPath);
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const next = `${stem}${tag}${ext}`;
  return dir === '.' ? next : `${dir}/${next}`;
}

export function createTrash({ BASE, safePath, confineRealpath, execFileAsync, defaultUid, defaultGid, log }) {
  const TRASH_ROOT = join(BASE, TRASH_DIRNAME);
  const FILES_ROOT = join(TRASH_ROOT, 'files');
  const INFO_ROOT = join(TRASH_ROOT, 'info');

  const warn = (...a) => (log ?? console.warn)(...a);

  /** True when `abs` is the trash tree or lives inside it. Used to refuse
   *  trashing the trash and to refuse restoring back into it. */
  function isInsideTrash(abs) {
    return abs === TRASH_ROOT || abs.startsWith(TRASH_ROOT + '/');
  }

  /** Resolve a DIRECTORY inside the trash tree. Deliberately not safePath(),
   *  which refuses `.trash` for ordinary operations — but it keeps the same
   *  symlink confinement, so a symlinked shard directory cannot redirect a
   *  purge at the wider filesystem. */
  async function trashPath(...segments) {
    const candidate = join(TRASH_ROOT, ...segments);
    if (!isInsideTrash(candidate)) return null;
    const confined = await confineRealpath(candidate);
    if (confined === null || !isInsideTrash(confined)) return null;
    return confined;
  }

  /**
   * Resolve one entry: the shard DIRECTORY is realpath-confined, the leaf is
   * appended lexically.
   *
   * The asymmetry is deliberate and load-bearing. Confining the leaf too (the
   * obvious version) resolves a symlinked payload to its target, and since a
   * payload pointing outside the PVC fails that check, the entry becomes
   * PERMANENTLY un-purgeable — the bin can never be emptied and keeps billing
   * the tenant for space. Anyone with SFTP access can plant such a link.
   *
   * Treating the leaf lexically is safe because every operation we perform on
   * it (`rm`, `rename`) acts on the LINK, never on what it points at: removing
   * a symlink unlinks the link, and moving one moves the link. Confining the
   * shard directory is what stops a symlinked ancestor from turning that into
   * a traversal.
   */
  async function entryPath(root, shard, leaf) {
    if (!leaf || leaf.includes('/') || leaf.includes('\\') || leaf === '.' || leaf === '..') return null;
    if (!shard || shard.includes('/') || shard.includes('\\') || shard === '.' || shard === '..') return null;
    const shardDir = await confineRealpath(join(root, shard));
    if (shardDir === null || !isInsideTrash(shardDir)) return null;
    return join(shardDir, leaf);
  }

  async function measureBytes(abs, isDir) {
    if (!isDir) {
      try {
        const s = await stat(abs);
        return s.size;
      } catch { return null; }
    }
    try {
      const { stdout } = await execFileAsync('du', ['-sb', abs], { timeout: DU_TIMEOUT_MS });
      const n = parseInt(stdout.split('\t')[0], 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null; // slow or vanished — the move already succeeded either way
    }
  }

  /**
   * Move `absSrc` into the trash. Returns the created entry.
   *
   * Order matters: the payload is renamed FIRST, then the metadata is written.
   * The reverse order would leave an info file describing a payload that never
   * arrived. This way a metadata failure leaves a payload that listTrash()
   * still surfaces and restoreFromTrash() can still recover.
   */
  async function moveToTrash(absSrc, relSrc, meta = {}) {
    if (absSrc === BASE) throw Object.assign(new Error('Cannot trash the PVC root'), { code: 'ETRASHROOT' });
    if (isInsideTrash(absSrc)) throw Object.assign(new Error('Cannot trash the trash'), { code: 'ETRASHSELF' });

    const now = new Date();
    const shard = shardFor(now);
    const id = newId(now);

    const s = await stat(absSrc); // throws ENOENT → caller maps to 404
    const isDir = s.isDirectory();

    await mkdir(join(FILES_ROOT, shard), { recursive: true });
    await mkdir(join(INFO_ROOT, shard), { recursive: true });

    const payload = join(FILES_ROOT, shard, id);
    await rename(absSrc, payload);

    const sizeBytes = await measureBytes(payload, isDir);
    const entry = {
      id,
      originalPath: relSrc,
      name: basename(relSrc),
      type: isDir ? 'directory' : 'file',
      sizeBytes,
      deletedAt: now.toISOString(),
      deletedBy: meta.actor ?? null,
      origin: meta.origin ?? 'file-manager',
      // Which operation displaced it, so the bin can say WHY an entry the user
      // never explicitly deleted is sitting there.
      ...(meta.replacedBy ? { replacedBy: meta.replacedBy } : {}),
      ...(meta.deploymentName ? { deploymentName: meta.deploymentName } : {}),
    };

    try {
      await writeFile(join(INFO_ROOT, shard, `${id}.json`), JSON.stringify(entry), 'utf-8');
    } catch (err) {
      // Payload is safe; only the metadata is missing. Surface it rather than
      // pretending the delete failed — the file IS out of the docroot.
      warn(`[trash] metadata write failed for ${id}: ${err.message}`);
    }
    return entry;
  }

  /**
   * Back up a path that is ABOUT to be destroyed by an incidental overwrite,
   * then report what happened. Returns the trash entry, or null when there was
   * nothing there (the overwhelmingly common case, so this is a cheap `lstat`
   * on the happy path).
   *
   * "Incidental" is the whole point. A move, a copy, an upload or an archive
   * extraction that lands on an occupied name destroys the occupant as a SIDE
   * EFFECT of doing something else — the user never named the file they lost.
   * An editor save, by contrast, is a deliberate overwrite of the file the user
   * is looking at, so callers declare that with `expectExisting` and get no
   * backup (otherwise every Ctrl-S would leave a trash entry behind).
   *
   * `lstat`, not `stat`: a dangling symlink at the destination is still an
   * entry that a rename would silently replace.
   */
  async function trashIfExists(abs, rel, meta = {}) {
    try {
      await lstat(abs);
    } catch {
      return null; // nothing to displace
    }
    if (isInsideTrash(abs) || abs === BASE) return null;
    return moveToTrash(abs, rel, { ...meta, origin: meta.origin ?? 'replaced' });
  }

  async function readInfo(shard, id) {
    try {
      const raw = await readFile(join(INFO_ROOT, shard, `${id}.json`), 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { return null; }
  }

  async function listShards() {
    try {
      const entries = await readdir(FILES_ROOT, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
    } catch { return []; } // trash never used
  }

  /**
   * Every payload in the trash, newest first. `originalPath: null` marks an
   * entry whose metadata is missing — still listed, still restorable.
   *
   * `deletedAt` falls back to the payload's ctime because `rename()` updates
   * the inode's ctime, making it a faithful record of when the move happened.
   * (mtime would be wrong — it survives the rename and reflects the file's own
   * last write, often years earlier.)
   */
  async function listTrash() {
    const out = [];
    for (const shard of await listShards()) {
      let names;
      try {
        names = await readdir(join(FILES_ROOT, shard));
      } catch { continue; }
      for (const id of names) {
        const payload = join(FILES_ROOT, shard, id);
        let s;
        try {
          // lstat, NOT stat: a payload may be a symlink (planted over SFTP, or
          // a link the tenant legitimately deleted). Following it would report
          // the target's type and size, and a DANGLING link would throw and
          // drop the entry from the listing entirely — invisible in the UI
          // while still occupying the bin.
          s = await lstat(payload);
        } catch { continue; } // vanished mid-walk
        const info = await readInfo(shard, id);
        const isDir = s.isDirectory();
        // Type comes from what is ON DISK, not from the metadata — the
        // metadata is tenant-writable over SFTP, and the purge path branches on
        // this to decide whether to measure or follow anything. Size still
        // prefers the recorded value so listing does not re-`du` every folder.
        const observedType = s.isSymbolicLink() ? 'symlink' : (isDir ? 'directory' : 'file');
        out.push({
          id,
          shard,
          originalPath: info?.originalPath ?? null,
          name: info?.name ?? id,
          type: observedType,
          sizeBytes: observedType === 'directory' ? (info?.sizeBytes ?? null) : s.size,
          deletedAt: info?.deletedAt ?? s.ctime.toISOString(),
          deletedBy: info?.deletedBy ?? null,
          origin: info?.origin ?? 'file-manager',
          ...(info?.replacedBy ? { replacedBy: info.replacedBy } : {}),
          ...(info?.deploymentName ? { deploymentName: info.deploymentName } : {}),
          orphaned: info === null,
        });
      }
    }
    out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
    return out;
  }

  /** Locate a payload by id — O(1) via the embedded epoch, with a scan as the
   *  fallback for ids that predate or diverge from the format. */
  async function locate(id) {
    if (typeof id !== 'string' || !id) return null;
    const derived = shardFromId(id);
    const shards = derived ? [derived, ...(await listShards()).filter(s => s !== derived)] : await listShards();
    for (const shard of shards) {
      const payload = await entryPath(FILES_ROOT, shard, id);
      if (!payload) continue;
      try {
        const s = await lstat(payload);
        return { shard, payload, stat: s };
      } catch { /* not in this shard */ }
    }
    return null;
  }

  /**
   * Restore an entry to its recorded original path.
   *
   * SECURITY: `originalPath` comes off disk, and the PVC is writable over SFTP
   * — a tenant can hand-author /data/.trash/info/<id>.json with
   * `originalPath: "../../etc/passwd"`. It is therefore treated as untrusted
   * input and re-validated through safePath() (traversal + symlink
   * confinement) on every restore, exactly like a path arriving over HTTP.
   */
  async function restoreFromTrash(id, opts = {}) {
    const found = await locate(id);
    if (!found) return { status: 404, error: 'Trash entry not found' };

    const info = await readInfo(found.shard, id);
    // An orphaned payload has no recorded destination; park it somewhere
    // obvious rather than refusing to give the data back.
    const requested = info?.originalPath || `restored/${id}`;

    // The recorded path is UNTRUSTED: /data is writable over SFTP, so a tenant
    // can hand-author .trash/info/<id>.json with whatever they like. Check the
    // SHAPE before safePath(), because safePath is deliberately lenient with
    // leading slashes — it strips them and re-roots the path under BASE. That
    // containment is right for a path typed into the UI, but here it would turn
    // a forged "/etc/passwd" into a silent restore to /data/etc/passwd instead
    // of the refusal the operator expects. We only ever WRITE clean relative
    // paths into this field, so anything else is forged by definition.
    if (typeof requested !== 'string' || requested.length === 0
        || requested.startsWith('/')
        || requested.split('/').some(seg => seg === '..')) {
      return { status: 400, error: 'Recorded original path is not a valid location' };
    }

    let target = await safePath(requested);
    if (!target) return { status: 400, error: 'Recorded original path is not a valid location' };
    if (isInsideTrash(target)) return { status: 400, error: 'Cannot restore into the trash' };

    let relTarget = requested.replace(/^\/+/, '');
    let exists = true;
    try { await stat(target); } catch { exists = false; }

    if (exists) {
      if (opts.overwrite) {
        await rm(target, { recursive: true, force: true });
      } else if (opts.autoRename) {
        let n = 1;
        for (; n <= 50; n += 1) {
          const candidateRel = suffixName(relTarget, n);
          const candidate = await safePath(candidateRel); // eslint-disable-line no-await-in-loop
          if (!candidate) return { status: 400, error: 'Could not derive a safe restore path' };
          let taken = true;
          try { await stat(candidate); } catch { taken = false; } // eslint-disable-line no-await-in-loop
          if (!taken) { target = candidate; relTarget = candidateRel; break; }
        }
        if (n > 50) return { status: 409, error: 'Too many restored copies already exist' };
      } else {
        return { status: 409, error: 'A file or folder already exists at the original location', conflictPath: relTarget };
      }
    }

    // Recreate any parent directories the delete left behind. New dirs get the
    // www-data ownership the rest of the sidecar uses, or a restored PHP app
    // cannot write into its own folder. The payload itself keeps its original
    // uid/gid for free — rename() does not touch them.
    const parent = dirname(target);
    try {
      await mkdir(parent, { recursive: true });
      await fsChown(parent, defaultUid, defaultGid).catch(() => {});
    } catch (err) {
      return { status: 500, error: `Could not recreate parent directory: ${err.message}` };
    }

    await rename(found.payload, target);
    await unlink(join(INFO_ROOT, found.shard, `${id}.json`)).catch(() => {});

    return {
      status: 200,
      id,
      restoredTo: relTarget,
      renamed: relTarget !== (info?.originalPath ?? relTarget),
    };
  }

  /**
   * Delete trash entries for good.
   *
   * `olderThanDays` drives scheduled expiry; `ids` drives an explicit
   * "delete forever" from the UI; `all` empties the bin. Bytes freed are
   * measured per entry BEFORE removal so the caller can report a real number.
   */
  async function purgeTrash({ olderThanDays = null, ids = null, all = false } = {}) {
    const cutoff = olderThanDays === null ? null : Date.now() - olderThanDays * 86_400_000;
    const wanted = ids ? new Set(ids) : null;

    const entries = await listTrash();
    let purged = 0;
    let bytesFreed = 0;
    const failed = [];

    for (const e of entries) {
      const eligible = all
        || (wanted ? wanted.has(e.id) : false)
        || (cutoff !== null && Date.parse(e.deletedAt) < cutoff);
      if (!eligible) continue;

      const payload = await entryPath(FILES_ROOT, e.shard, e.id);
      if (!payload) { failed.push({ id: e.id, error: 'Path escaped the trash root' }); continue; }
      try {
        // Measure before removal; a recorded size may be null (du timed out at
        // trash time) and reporting 0 freed for a 5 GB purge reads as a bug.
        // A symlink payload is measured as itself — never followed.
        const bytes = e.type === 'symlink'
          ? 0
          : (e.sizeBytes ?? await measureBytes(payload, e.type === 'directory'));
        // rm() on a symlink unlinks the LINK; it does not recurse into the
        // target. Combined with the realpath-confined shard directory from
        // entryPath(), this cannot reach outside the trash.
        await rm(payload, { recursive: true, force: true });
        const infoFile = await entryPath(INFO_ROOT, e.shard, `${e.id}.json`);
        if (infoFile) await unlink(infoFile).catch(() => {});
        purged += 1;
        bytesFreed += bytes ?? 0;
      } catch (err) {
        failed.push({ id: e.id, error: err.message });
      }
    }

    await pruneEmptyShards();
    return { purged, bytesFreed, failed, examined: entries.length };
  }

  /** Drop shard directories that no longer hold anything, so an old trash does
   *  not leave a growing tail of empty `2026-01/` dirs behind. */
  async function pruneEmptyShards() {
    for (const root of [FILES_ROOT, INFO_ROOT]) {
      let shards;
      try { shards = await readdir(root); } catch { continue; }
      for (const shard of shards) {
        try {
          const remaining = await readdir(join(root, shard));
          if (remaining.length === 0) await rm(join(root, shard), { recursive: true, force: true });
        } catch { /* raced or unreadable */ }
      }
    }
  }

  /** Bytes the trash occupies on the PVC. Reported alongside disk usage so the
   *  quota cost of the bin is visible rather than inferred — there is no size
   *  cap, so transparency is the whole control. */
  async function trashUsageBytes() {
    try {
      const { stdout } = await execFileAsync('du', ['-sb', TRASH_ROOT], { timeout: DU_TIMEOUT_MS });
      const n = parseInt(stdout.split('\t')[0], 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0; // no trash yet, or du unavailable
    }
  }

  /** Oldest surviving entry — lets the backend decide whether a tenant is
   *  worth waking for an expiry sweep without starting its pod first. */
  async function trashSummary() {
    const entries = await listTrash();
    let oldest = null;
    for (const e of entries) {
      if (oldest === null || e.deletedAt < oldest) oldest = e.deletedAt;
    }
    return { count: entries.length, oldestDeletedAt: oldest, usedBytes: await trashUsageBytes() };
  }

  return {
    TRASH_ROOT,
    isInsideTrash,
    moveToTrash,
    trashIfExists,
    listTrash,
    restoreFromTrash,
    purgeTrash,
    trashUsageBytes,
    trashSummary,
    // exported for unit tests
    _internals: { shardFor, shardFromId, suffixName, trashPath },
  };
}
