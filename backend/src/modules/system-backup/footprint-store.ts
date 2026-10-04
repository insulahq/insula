import { eq, inArray } from 'drizzle-orm';
import { backupTargetAssignments, platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { ClusterBackupHealth } from '../cnpg-backup-health/service.js';

/**
 * What the SYSTEM backup class has actually done, persisted for readers that
 * may not touch Kubernetes or the backup target (the dashboard summary).
 *
 * The class is the platform database's CNPG base backups + WAL, the etcd
 * snapshots and the DR bundles, all at the system target. None of them report
 * to the API, and `system_backup_runs` only holds manual operator exports — so
 * a reader of that table sees a months-old secrets export as "the last system
 * backup" while the database is backed up every few hours.
 *
 *   - `system_backup_last_success`: the newest completed CNPG base backup of
 *     the platform database, written by the CNPG backup-health tick (5 min).
 *   - `system_backup_footprint`: bytes stored at the system target, measured
 *     hourly by listing it (see footprint-measure.ts).
 */
export const SYSTEM_BACKUP_LAST_SUCCESS_KEY = 'system_backup_last_success';
export const SYSTEM_BACKUP_FOOTPRINT_KEY = 'system_backup_footprint';

/** The platform database's CNPG cluster. */
export const PLATFORM_DB_CLUSTER = { namespace: 'platform', name: 'system-db' } as const;

export interface SystemBackupLastSuccess {
  /** When the backup finished (CNPG `stoppedAt`; `startedAt` when absent). */
  readonly at: string;
  readonly backupName: string;
  readonly clusterName: string;
}

export interface FootprintPart {
  /** `postgres` (base backups + WAL), `etcd`, `dr` (secrets + cluster-state bundles). */
  readonly name: string;
  readonly prefix: string;
  readonly bytes: number;
  readonly objects: number;
  /** The walk stopped early (page cap or deadline): `bytes` is a floor. */
  readonly truncated: boolean;
  readonly error: string | null;
}

export interface SystemBackupFootprint {
  readonly measuredAt: string;
  readonly totalBytes: number;
  readonly objectCount: number;
  readonly truncated: boolean;
  /** Set when no part could be listed at all — `totalBytes` then means nothing. */
  readonly error: string | null;
  readonly parts: readonly FootprintPart[];
}

async function writeJson(db: Database, key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  await db.insert(platformSettings).values({ key, value: text })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: text } });
}

function parse<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

export async function readSystemBackupFacts(db: Database): Promise<{
  lastSuccess: SystemBackupLastSuccess | null;
  footprint: SystemBackupFootprint | null;
}> {
  const rows = await db.select().from(platformSettings)
    .where(inArray(platformSettings.key, [SYSTEM_BACKUP_LAST_SUCCESS_KEY, SYSTEM_BACKUP_FOOTPRINT_KEY]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    lastSuccess: parse<SystemBackupLastSuccess>(byKey.get(SYSTEM_BACKUP_LAST_SUCCESS_KEY)),
    footprint: parse<SystemBackupFootprint>(byKey.get(SYSTEM_BACKUP_FOOTPRINT_KEY)),
  };
}

/**
 * Record the platform database's newest completed base backup from a CNPG
 * health snapshot. Writes only when it changed, so five-minute ticks on every
 * replica do not rewrite the row; never moves backwards (a snapshot taken
 * while the API server lists stale data must not undo a newer record).
 */
export async function recordSystemLastSuccess(
  db: Database,
  snapshot: ReadonlyArray<ClusterBackupHealth>,
): Promise<SystemBackupLastSuccess | null> {
  const cluster = snapshot.find((c) => c.namespace === PLATFORM_DB_CLUSTER.namespace && c.clusterName === PLATFORM_DB_CLUSTER.name);
  const b = cluster?.lastSuccessfulBackup;
  const at = b?.stoppedAt ?? b?.startedAt;
  if (!b || !at) return null;
  const next: SystemBackupLastSuccess = { at: new Date(at).toISOString(), backupName: b.name, clusterName: b.clusterName };

  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, SYSTEM_BACKUP_LAST_SUCCESS_KEY));
  const prev = parse<SystemBackupLastSuccess>(row?.value);
  if (prev && (prev.backupName === next.backupName || Date.parse(prev.at) >= Date.parse(next.at))) return prev;
  await writeJson(db, SYSTEM_BACKUP_LAST_SUCCESS_KEY, next);
  return next;
}

export async function storeSystemFootprint(db: Database, footprint: SystemBackupFootprint): Promise<void> {
  await writeJson(db, SYSTEM_BACKUP_FOOTPRINT_KEY, footprint);
}

export async function clearSystemFootprint(db: Database): Promise<void> {
  await db.delete(platformSettings).where(eq(platformSettings.key, SYSTEM_BACKUP_FOOTPRINT_KEY));
}

/** Whether the SYSTEM class has a backup target at all. */
export async function systemClassIsBound(db: Database): Promise<boolean> {
  const [row] = await db.select({ cls: backupTargetAssignments.backupClass })
    .from(backupTargetAssignments)
    .where(eq(backupTargetAssignments.backupClass, 'system'))
    .limit(1);
  return Boolean(row);
}
