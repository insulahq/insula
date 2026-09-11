/**
 * The REAL WAL-archive recency, read from `pg_stat_archiver`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The WAL card used to report the CNPG `ContinuousArchiving` condition's
 * `lastTransitionTime` as "last WAL archived". A condition only transitions
 * when archiving HEALTH changes, so a cluster that has been archiving happily
 * since the day it was configured keeps that first timestamp forever. Measured
 * on production 2026-09-11: the card showed **2026-08-12** while the
 * barman-cloud sidecar was uploading a segment every five minutes.
 *
 * `pg_stat_archiver` is the authority — it is what Postgres itself updates on
 * every successful and every failed archive_command.
 *
 * Scope: the only cluster this module reports on (`platform/system-db`) IS the
 * platform database, so the existing connection answers for it. A second
 * system cluster would need its own connection; callers get `null` and fall
 * back to the condition-derived health instead of a wrong number.
 */

import { sql } from 'drizzle-orm';
import { CNPG_DEFAULT_ARCHIVE_TIMEOUT, type WalArchivingSource } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';

/**
 * Is WAL actually being archived, and why?
 *
 * `pluginAttached` — the barman-cloud entry exists in `Cluster.spec.plugins[]`.
 * Its PRESENCE is the gate (see backup-rclone-shim/postgres-objectstore.ts);
 * `isWALArchiver` is not, and neither is the `system_wal_archive_state` row.
 *
 * `archiveTimeout` — written ONLY by enableWalStreaming, cleared ONLY by
 * disableWalStreaming, so it is the canonical "the operator asked for
 * streaming" signal.
 *
 * The two are independent, which is the whole bug: production had
 * pluginAttached=true (scheduled base backups need it) with archiveTimeout
 * NULL, and the settings tab answered the second question while claiming to
 * answer the first — "WAL streaming: not enabled" on a cluster shipping a
 * segment off-site every five minutes.
 */
export function classifyWalArchiving(
  pluginAttached: boolean,
  archiveTimeout: string | null | undefined,
): {
  readonly active: boolean;
  readonly source: WalArchivingSource;
  readonly effectiveArchiveTimeout: string | null;
} {
  if (!pluginAttached) {
    return { active: false, source: 'none', effectiveArchiveTimeout: null };
  }
  return {
    active: true,
    source: archiveTimeout ? 'streaming' : 'scheduled_backups',
    // No explicit value means CNPG's own default is in force — an RPO the
    // operator never chose, which is worth naming rather than showing blank.
    effectiveArchiveTimeout: archiveTimeout ?? CNPG_DEFAULT_ARCHIVE_TIMEOUT,
  };
}

export interface ArchiverStats {
  readonly lastArchivedWal: string | null;
  readonly lastArchivedWalTime: string | null;
  readonly lastFailedWal: string | null;
  readonly lastFailedArchiveTime: string | null;
  readonly archivedCount: number | null;
  readonly failedCount: number | null;
}

interface ArchiverRow {
  readonly archived_count: number | string | null;
  readonly last_archived_wal: string | null;
  readonly last_archived_time: Date | string | null;
  readonly failed_count: number | string | null;
  readonly last_failed_wal: string | null;
  readonly last_failed_time: Date | string | null;
}

function toIso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toCount(v: number | string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Best-effort: returns null rather than throwing, so a WAL card still renders
 * (with condition-derived health only) if the view is unreadable.
 */
export async function readArchiverStats(db: Database): Promise<ArchiverStats | null> {
  try {
    const result = await db.execute(sql`
      SELECT archived_count, last_archived_wal, last_archived_time,
             failed_count, last_failed_wal, last_failed_time
        FROM pg_stat_archiver
    `) as unknown as { rows?: ArchiverRow[] } | ArchiverRow[];

    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    const row = rows[0];
    if (!row) return null;

    return {
      lastArchivedWal: row.last_archived_wal ?? null,
      lastArchivedWalTime: toIso(row.last_archived_time),
      lastFailedWal: row.last_failed_wal ?? null,
      lastFailedArchiveTime: toIso(row.last_failed_time),
      archivedCount: toCount(row.archived_count),
      failedCount: toCount(row.failed_count),
    };
  } catch {
    return null;
  }
}

/**
 * True when this is the cluster the platform's own DB connection points at —
 * the only one `readArchiverStats` can speak for.
 */
export function isPlatformDbCluster(namespace: string, name: string): boolean {
  return namespace === 'platform' && name === 'system-db';
}
