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
import { CNPG_DEFAULT_ARCHIVE_TIMEOUT } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';

/**
 * The archive_timeout actually in force.
 *
 * The operator's explicit value when they set one, otherwise CNPG's own default
 * — which is what applies the moment the barman-cloud plugin is attached. A
 * blank here would hide the fact that WAL is being uploaded on SOME interval.
 */
export function effectiveArchiveTimeout(
  pluginAttached: boolean,
  archiveTimeout: string | null | undefined,
): string | null {
  if (!pluginAttached) return null;
  return archiveTimeout ?? CNPG_DEFAULT_ARCHIVE_TIMEOUT;
}

export interface ArchiverStats {
  readonly lastArchivedWal: string | null;
  readonly lastArchivedWalTime: string | null;
  readonly lastFailedWal: string | null;
  readonly lastFailedArchiveTime: string | null;
  readonly archivedCount: number | null;
  readonly failedCount: number | null;
  /** When these counters were last zeroed — the window they describe. */
  readonly statsResetAt: string | null;
}

/**
 * Is archiving failing RIGHT NOW?
 *
 * `pg_stat_archiver` keeps `last_failed_wal`/`last_failed_time` forever (until
 * the stats are reset), so their mere presence says nothing about the current
 * state. Caught on DEV 2026-09-11 the moment this shipped: 64 failures with the
 * last one on 2026-09-08, 4472 successes with the last one seconds earlier —
 * and the health chip rendered a red "WAL failing". A failure counts only when
 * nothing has been archived SINCE it.
 */
export function isArchivingCurrentlyFailing(stats: ArchiverStats | null | undefined): boolean {
  if (!stats?.lastFailedArchiveTime) return false;
  if (!stats.lastArchivedWalTime) return true;
  return new Date(stats.lastFailedArchiveTime).getTime()
    > new Date(stats.lastArchivedWalTime).getTime();
}

interface ArchiverRow {
  readonly archived_count: number | string | null;
  readonly last_archived_wal: string | null;
  readonly last_archived_time: Date | string | null;
  readonly failed_count: number | string | null;
  readonly last_failed_wal: string | null;
  readonly last_failed_time: Date | string | null;
  readonly stats_reset: Date | string | null;
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
             failed_count, last_failed_wal, last_failed_time, stats_reset
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
      statsResetAt: toIso(row.stats_reset),
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

/**
 * Segments per WAL log-file value — `0x100000000 / wal_segment_size`.
 *
 * The WAL gap detector needs this to know that …0000FF is followed by
 * …00010000 rather than by a hole. It is 256 for the default 16 MB segment
 * size (verified on production 2026-09-12), but the setting is configurable at
 * initdb time and a wrong divisor invents a gap at every roll-over — so it is
 * read from Postgres rather than assumed.
 *
 * Returns null when it cannot be read; the caller then falls back to the
 * documented default rather than refusing to report anything.
 */
export async function readSegmentsPerFile(db: Database): Promise<number | null> {
  try {
    const result = await db.execute(sql`SHOW wal_segment_size`) as unknown as
      { rows?: Array<Record<string, string>> } | Array<Record<string, string>>;
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    const raw = rows[0] ? Object.values(rows[0])[0] : undefined;
    if (typeof raw !== 'string') return null;

    const m = /^(\d+)\s*([kMG]B)?$/.exec(raw.trim());
    if (!m) return null;
    const unit = { kB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 }[m[2] ?? 'MB'] ?? 1;
    const bytes = Number(m[1]) * unit;
    if (!Number.isFinite(bytes) || bytes <= 0) return null;

    const perFile = Math.floor(0x100000000 / bytes);
    return perFile > 0 ? perFile : null;
  } catch {
    return null;
  }
}
