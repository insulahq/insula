/**
 * Reaping for the bundle-import path (ADR-063 D6).
 *
 * An import creates five kinds of artifact and every one needs an owner:
 *
 *   | artifact                    | reaped by                                  |
 *   |-----------------------------|--------------------------------------------|
 *   | staged unit directory       | `rm -rf` after each unit; the stage is an   |
 *   |                             | `emptyDir` and dies with the pod anyway     |
 *   | the import Job              | `ttlSecondsAfterFinished`                   |
 *   | the creds Secret            | ownerRef'd to the Job                       |
 *   | the UPLOADED ARCHIVE        | `reapImportUpload` — here                   |
 *   | partial restic snapshots    | `forgetImportSnapshots` — here              |
 *
 * The uploaded archive is the one an operator actually notices: it sits on the
 * tenant's own PVC and counts against their quota. It is deleted on success
 * AND on failure, and `sweepAbandonedImportUploads` catches the uploads whose
 * import never started (browser closed mid-upload, platform-api restarted).
 */
import { eq, and, inArray } from 'drizzle-orm';

import { backupJobs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { IMPORT_UPLOAD_DIR } from './import-job.js';
import { runResticForget } from './restic-driver.js';
import type { BackupTarget } from './restic-driver.js';

/** Uploads older than this with no live import row are abandoned. */
export const ABANDONED_UPLOAD_AGE_MS = 6 * 60 * 60 * 1000; // 6h

export interface FileManagerGateway {
  /** POST `/rm` on the tenant's file-manager sidecar. */
  remove(namespace: string, path: string, permanent: boolean): Promise<void>;
  /** GET `/ls` on the tenant's file-manager sidecar. */
  list(namespace: string, path: string): Promise<ReadonlyArray<{
    name: string;
    modifiedAt?: string | number | null;
    size?: number;
  }>>;
}

export interface ReapLog {
  warn: (ctx: Record<string, unknown>, msg: string) => void;
  info?: (ctx: Record<string, unknown>, msg: string) => void;
}

/** Path of an import upload, relative to the tenant file root. */
export function importUploadPath(importId: string, ext = 'tar.gz'): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(importId)) {
    throw new Error(`importUploadPath: unsafe import id ${JSON.stringify(importId)}`);
  }
  return `${IMPORT_UPLOAD_DIR}/${importId}.${ext}`;
}

/**
 * Delete an uploaded archive from the tenant's file space.
 *
 * `permanent: true` deliberately — the recycle bin would keep a multi-GB
 * archive charged against the tenant's quota, which is the opposite of
 * reaping it. Best-effort: a reap failure must never turn a SUCCESSFUL
 * import into a reported failure, so it is logged and swallowed. The
 * sweeper is the backstop.
 */
export async function reapImportUpload(
  fm: FileManagerGateway,
  namespace: string,
  relPath: string,
  log?: ReapLog,
): Promise<boolean> {
  try {
    await fm.remove(namespace, `/${relPath.replace(/^\/+/, '')}`, true);
    return true;
  } catch (err) {
    log?.warn(
      { namespace, relPath, err: err instanceof Error ? err.message : String(err) },
      'bundle-import: could not delete the uploaded archive — the sweeper will retry',
    );
    return false;
  }
}

/**
 * Drop the snapshots a FAILED import already wrote.
 *
 * Without this a half-finished import leaves orphan snapshots that no
 * `backup_components` row references, so retention never reclaims them and
 * they are invisible in the UI — they only show up as unexplained repo growth.
 *
 * Grouped per repo URI because `files` and `mailboxes` are separate
 * repositories under the `per-component` layout.
 */
export async function forgetImportSnapshots(
  args: {
    readonly target: BackupTarget;
    readonly passwordHex: string;
    /** repoUri → snapshot ids written into it before the failure. */
    readonly byRepo: ReadonlyMap<string, ReadonlyArray<string>>;
    readonly log?: ReapLog;
  },
): Promise<{ forgotten: number; failed: number }> {
  let forgotten = 0;
  let failed = 0;
  for (const [repoUri, ids] of args.byRepo) {
    const snapshotIds = ids.filter((id) => /^[0-9a-f]{64}$/.test(id));
    if (snapshotIds.length === 0) continue;
    try {
      await runResticForget({ target: args.target, passwordHex: args.passwordHex, repoUri, snapshotIds });
      forgotten += snapshotIds.length;
    } catch (err) {
      failed += snapshotIds.length;
      // Logged, not thrown: the import already failed and the caller must
      // still finish tearing down. An orphan snapshot is a reclaim problem,
      // not a correctness one.
      args.log?.warn(
        { repoUri, count: snapshotIds.length, err: err instanceof Error ? err.message : String(err) },
        'bundle-import: could not forget partial snapshots from a failed import',
      );
    }
  }
  return { forgotten, failed };
}

/**
 * Pull the import id out of a bundle row's description.
 *
 * ★ The bundle row's PRIMARY KEY is a freshly minted `bkp-<uuid>`, NOT the
 * import id — they can never be equal, so matching `backup_jobs.id` against an
 * import id (as an earlier version did) always found nothing and the liveness
 * check silently did not exist. `describeImport` stamps `[import:<id>]` into
 * the description precisely so this correlation is possible without a schema
 * change.
 */
export function importIdFromDescription(description: string | null | undefined): string | null {
  const m = (description ?? '').match(/\[import:([A-Za-z0-9_-]{1,64})\]/);
  return m ? m[1]! : null;
}

/** Parse an import id out of an upload filename, or null if it is not one. */
export function importIdFromUploadName(name: string): string | null {
  const m = name.match(/^([A-Za-z0-9_-]{1,64})\.(?:tar\.gz|tar\.gz\.enc|tar|zip)$/);
  return m ? m[1]! : null;
}

/**
 * Delete uploads in `.insula-imports/` that no live import owns.
 *
 * An upload is abandoned when it is older than `ABANDONED_UPLOAD_AGE_MS` AND
 * its import id does not match a `backup_jobs` row still in `pending`/
 * `running`. The age gate matters on its own: an upload that is still
 * streaming has no row yet, and deleting it would break a live import.
 */
export async function sweepAbandonedImportUploads(args: {
  readonly db: Database;
  readonly fm: FileManagerGateway;
  readonly namespace: string;
  /** Owner of this namespace — scopes the liveness query to their bundles. */
  readonly tenantId: string;
  readonly now?: number;
  readonly maxAgeMs?: number;
  readonly log?: ReapLog;
}): Promise<{ scanned: number; deleted: number; skippedLive: number; skippedYoung: number }> {
  const now = args.now ?? Date.now();
  const maxAge = args.maxAgeMs ?? ABANDONED_UPLOAD_AGE_MS;

  let entries: ReadonlyArray<{ name: string; modifiedAt?: string | number | null }>;
  try {
    entries = await args.fm.list(args.namespace, `/${IMPORT_UPLOAD_DIR}`);
  } catch {
    // No upload directory is the normal case for a tenant that never
    // imported. Not an error, and not something to log every sweep.
    return { scanned: 0, deleted: 0, skippedLive: 0, skippedYoung: 0 };
  }

  const candidates: Array<{ name: string; importId: string }> = [];
  let skippedYoung = 0;
  for (const e of entries) {
    const importId = importIdFromUploadName(e.name);
    if (!importId) continue;
    const mtime = e.modifiedAt == null ? NaN : new Date(e.modifiedAt).getTime();
    // An unreadable mtime must NOT read as "ancient" — that would delete a
    // live upload. Unknown age is treated as young and retried next sweep.
    if (!Number.isFinite(mtime) || now - mtime < maxAge) {
      skippedYoung += 1;
      continue;
    }
    candidates.push({ name: e.name, importId });
  }

  if (candidates.length === 0) {
    return { scanned: entries.length, deleted: 0, skippedLive: 0, skippedYoung };
  }

  // One query for the whole batch — never one per file. Scoped to this
  // tenant's in-flight bundles; the import id is read back out of the
  // description, because the row's own id is a different identifier entirely.
  const live = await args.db
    .select({ description: backupJobs.description })
    .from(backupJobs)
    .where(and(
      eq(backupJobs.tenantId, args.tenantId),
      inArray(backupJobs.status, ['pending', 'running']),
    ));
  const liveIds = new Set(
    live.map((r) => importIdFromDescription(r.description)).filter((v): v is string => v !== null),
  );

  let deleted = 0;
  let skippedLive = 0;
  for (const c of candidates) {
    if (liveIds.has(c.importId)) { skippedLive += 1; continue; }
    const ok = await reapImportUpload(args.fm, args.namespace, `${IMPORT_UPLOAD_DIR}/${c.name}`, args.log);
    if (ok) deleted += 1;
  }
  if (deleted > 0) {
    args.log?.info?.({ namespace: args.namespace, deleted }, 'bundle-import: swept abandoned upload(s)');
  }
  return { scanned: entries.length, deleted, skippedLive, skippedYoung };
}

/** Narrowing helper so callers can drop a bundle row that never completed. */
export async function deleteAbortedImportRow(db: Database, bundleId: string): Promise<void> {
  // Scoped to a NON-completed row so a race that completed the import cannot
  // have its bundle deleted out from under it.
  await db.delete(backupJobs).where(and(
    eq(backupJobs.id, bundleId),
    inArray(backupJobs.status, ['pending', 'running', 'failed']),
  ));
}
