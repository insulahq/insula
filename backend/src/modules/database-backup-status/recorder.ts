/**
 * Recording each bundle's per-database dump outcome as standing status.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every bundle wrote its database dumps' outcome into
 * `backup_jobs.database_dumps` — on the bundle, where nothing read it again. A
 * production tenant's seven MariaDB databases failed to dump on every retained
 * night for at least two weeks, every bundle said `completed`, and nobody was
 * told. `database_backup_status` keeps, per database, the last attempt and the
 * last GOOD backup, which is what the stale sweep and both panels need.
 *
 * WHAT COUNTS AS A GOOD BACKUP
 * ----------------------------
 * A dump that is `dumped` AND whose files snapshot completed: the dump lives
 * inside that snapshot, so a dump the snapshot did not keep backs nothing up.
 *
 * PRUNING — only on positive evidence
 * -----------------------------------
 * A row is removed when its database is shown to be gone, never because a
 * bundle failed to mention it:
 *   - its deployment no longer exists (deleted);
 *   - its deployment listed its databases without a deployment-level error,
 *     and this one was not among them;
 *   - SQLite: a capture that ran to its end (no discovery failure, nothing cut
 *     short) did not find the file, or found no SQLite files at all.
 * A failed enumeration prunes nothing, so a database whose dumps stop being
 * attempted goes stale and is alerted on instead of silently disappearing.
 */

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { BackupDatabaseDumps } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { databaseBackupStatus, deployments } from '../../db/schema.js';
import { redactDbSecrets } from '../deployments/db-manager.js';

/** subject_key for SQLite files found on the tenant volume. */
export const SQLITE_SUBJECT = 'sqlite';

/** The summary's synthetic entry for a deployment whose databases could not be listed. */
export const DEPLOYMENT_ENTRY = '(deployment)';

/** The summary's synthetic entry for a SQLite capture that failed as a whole. */
export const SQLITE_DISCOVERY_ENTRY = '(SQLite discovery)';

/** Stored error text is capped: it is shown in panels and notifications, not a log. */
export const ERROR_MAX_CHARS = 500;

/** Why a `dumped` entry is not a backup when its files snapshot failed. */
export const SNAPSHOT_NOT_KEPT_ERROR =
  'the dump was written, but the files snapshot that keeps it failed, so it was not kept';

export type DumpStatus = 'dumped' | 'degraded' | 'failed';

/** A row as the planner needs it (and as it writes it). */
export interface DatabaseBackupRow {
  readonly tenantId: string;
  readonly subjectKey: string;
  readonly databaseName: string;
  readonly deploymentId: string | null;
  readonly deploymentName: string;
  readonly engine: string | null;
  readonly lastAttemptAt: Date;
  readonly lastAttemptBundleId: string;
  readonly lastStatus: DumpStatus;
  readonly lastError: string | null;
  readonly lastSuccessAt: Date | null;
  readonly lastSuccessBundleId: string | null;
  readonly lastSuccessSizeBytes: number | null;
  readonly staleSince: Date | null;
  readonly alertedAt: Date | null;
  readonly createdAt: Date;
}

/** One bundle's outcome, as the orchestrator knows it. */
export interface BundleDatabaseOutcome {
  readonly tenantId: string;
  readonly bundleId: string;
  /** When the bundle finished — the attempt (and, if good, the success) time. */
  readonly at: Date;
  readonly summary: BackupDatabaseDumps;
  /** The files snapshot that carries the dumps completed. */
  readonly snapshotKept: boolean;
  /**
   * The SQLite capture ran to its end without being cut short. False when the
   * file manager was not available, the capture threw, or a dump was
   * interrupted: then a missing SQLite file proves nothing.
   */
  readonly sqliteCaptureComplete: boolean;
}

export interface RecordPlan {
  readonly upserts: readonly DatabaseBackupRow[];
  readonly deletes: ReadonlyArray<{ readonly subjectKey: string; readonly databaseName: string }>;
}

const key = (subjectKey: string, databaseName: string): string => `${subjectKey}\u0000${databaseName}`;

function capError(error: string | null | undefined): string | null {
  if (!error) return null;
  // Dump errors can echo the dump command line, and these rows are shown to
  // tenants: redact again here rather than trust every path that wrote one.
  const clean = redactDbSecrets(error);
  return clean.length > ERROR_MAX_CHARS ? `${clean.slice(0, ERROR_MAX_CHARS - 1)}…` : clean;
}

function subjectOf(d: BackupDatabaseDumps['deployments'][number]): string {
  return d.engine === 'sqlite' || d.deploymentId === '' ? SQLITE_SUBJECT : d.deploymentId;
}

/**
 * Decide what one bundle changes. Pure — unit tested directly.
 *
 * `existing` is every row the tenant has; `liveDeploymentIds` the tenant's
 * deployments that still exist (not deleted).
 */
export function planDatabaseBackupRecord(
  existing: readonly DatabaseBackupRow[],
  outcome: BundleDatabaseOutcome,
  liveDeploymentIds: ReadonlySet<string>,
): RecordPlan {
  const byKey = new Map(existing.map((r) => [key(r.subjectKey, r.databaseName), r]));
  const upserts: DatabaseBackupRow[] = [];
  const deletes: Array<{ subjectKey: string; databaseName: string }> = [];
  const seenSubjects = new Set<string>();

  for (const dep of outcome.summary.deployments) {
    const subjectKey = subjectOf(dep);
    seenSubjects.add(subjectKey);
    const listed = new Set<string>();
    for (const db of dep.databases) {
      listed.add(db.name);
      const prev = byKey.get(key(subjectKey, db.name));
      const kept = db.status !== 'dumped' || outcome.snapshotKept;
      const status: DumpStatus = kept ? db.status : 'failed';
      const error = kept ? capError(db.error) : SNAPSHOT_NOT_KEPT_ERROR;
      const good = status === 'dumped';
      upserts.push({
        tenantId: outcome.tenantId,
        subjectKey,
        databaseName: db.name,
        deploymentId: subjectKey === SQLITE_SUBJECT ? null : dep.deploymentId,
        deploymentName: dep.deploymentName,
        engine: dep.engine,
        lastAttemptAt: outcome.at,
        lastAttemptBundleId: outcome.bundleId,
        lastStatus: status,
        lastError: good ? null : error,
        lastSuccessAt: good ? outcome.at : prev?.lastSuccessAt ?? null,
        lastSuccessBundleId: good ? outcome.bundleId : prev?.lastSuccessBundleId ?? null,
        lastSuccessSizeBytes: good ? db.sizeBytes : prev?.lastSuccessSizeBytes ?? null,
        // Episode state belongs to the sweep: it sees the success and sends
        // the recovery notice before clearing it.
        staleSince: prev?.staleSince ?? null,
        alertedAt: prev?.alertedAt ?? null,
        createdAt: prev?.createdAt ?? outcome.at,
      });
    }

    const enumeratedCleanly = subjectKey === SQLITE_SUBJECT
      ? outcome.sqliteCaptureComplete && !listed.has(SQLITE_DISCOVERY_ENTRY)
      : !listed.has(DEPLOYMENT_ENTRY);
    if (enumeratedCleanly) {
      for (const r of existing) {
        if (r.subjectKey === subjectKey && !listed.has(r.databaseName)) {
          deletes.push({ subjectKey, databaseName: r.databaseName });
        }
      }
    }
  }

  // Subjects this bundle did not mention: gone only on positive evidence.
  for (const r of existing) {
    if (seenSubjects.has(r.subjectKey)) continue;
    const gone = r.subjectKey === SQLITE_SUBJECT
      // A complete capture that reported nothing found no SQLite files at all.
      ? outcome.sqliteCaptureComplete
      : !liveDeploymentIds.has(r.subjectKey);
    if (gone) deletes.push({ subjectKey: r.subjectKey, databaseName: r.databaseName });
  }

  return { upserts, deletes };
}

/**
 * Apply one bundle's outcome. Never throws: the bundle is already recorded,
 * and a status write that failed is retried by the next bundle.
 */
export async function recordDatabaseBackupResults(db: Database, outcome: BundleDatabaseOutcome): Promise<void> {
  try {
    const existing = (await db.select().from(databaseBackupStatus)
      .where(eq(databaseBackupStatus.tenantId, outcome.tenantId))) as DatabaseBackupRow[];
    const live = await db.select({ id: deployments.id }).from(deployments)
      .where(and(
        eq(deployments.tenantId, outcome.tenantId),
        ne(deployments.status, 'deleted'),
        isNull(deployments.deletedAt),
      ));
    const plan = planDatabaseBackupRecord(existing, outcome, new Set(live.map((d) => d.id)));

    await db.transaction(async (tx) => {
      for (const d of plan.deletes) {
        await tx.delete(databaseBackupStatus).where(and(
          eq(databaseBackupStatus.tenantId, outcome.tenantId),
          eq(databaseBackupStatus.subjectKey, d.subjectKey),
          eq(databaseBackupStatus.databaseName, d.databaseName),
        ));
      }
      for (const row of plan.upserts) {
        await tx.insert(databaseBackupStatus).values(row).onConflictDoUpdate({
          target: [databaseBackupStatus.tenantId, databaseBackupStatus.subjectKey, databaseBackupStatus.databaseName],
          set: {
            deploymentId: row.deploymentId,
            deploymentName: row.deploymentName,
            engine: row.engine,
            lastAttemptAt: row.lastAttemptAt,
            lastAttemptBundleId: row.lastAttemptBundleId,
            lastStatus: row.lastStatus,
            lastError: row.lastError,
            lastSuccessAt: row.lastSuccessAt,
            lastSuccessBundleId: row.lastSuccessBundleId,
            lastSuccessSizeBytes: row.lastSuccessSizeBytes,
            // stale_since / alerted_at are the sweep's; a concurrent sweep
            // that just opened an episode must not be overwritten here.
            staleSince: sql`${databaseBackupStatus.staleSince}`,
            alertedAt: sql`${databaseBackupStatus.alertedAt}`,
          },
        });
      }
    });
  } catch (err) {
    console.warn(
      `[database-backup-status] recording bundle ${outcome.bundleId} for tenant ${outcome.tenantId} failed: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
