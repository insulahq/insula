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
 * last GOOD backup, which is what the overdue sweep and both panels need.
 *
 * WHAT COUNTS AS A GOOD BACKUP
 * ----------------------------
 * A dump that is `dumped` AND whose files snapshot completed: the dump lives
 * inside that snapshot, so a dump the snapshot did not keep backs nothing up.
 *
 * WHAT A BUNDLE THAT DID NOT DUMP SAYS
 * ------------------------------------
 * When the dumps did not run at all (the pre-dump step threw, or the file
 * manager for the SQLite capture could not be had), the databases it would
 * have dumped are stamped `failed` — "did not run" — instead of keeping a
 * last attempt that reads as backed up.
 *
 * PRUNING — only on positive evidence
 * -----------------------------------
 * A row is removed when its database is shown to be gone, never because a
 * bundle failed to mention it:
 *   - its deployment no longer exists or is deleted;
 *   - its deployment listed its databases without a deployment-level error,
 *     and this one was not among them;
 *   - SQLite: a capture that ran to its end (no discovery failure, nothing cut
 *     short) did not find the file, or found no SQLite files at all.
 *
 * BOUNDED
 * -------
 * Names come from the tenant (database names, SQLite paths), so each is cut to
 * a fixed length with a hash of the whole (the key stays stable and unique),
 * and a tenant's rows are capped: past the cap, a subject's remaining
 * databases are folded into one row that counts them.
 */

import { createHash } from 'node:crypto';
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

/** The row a subject's databases past the cap are folded into. */
export const MORE_DATABASES_ENTRY = '(more databases)';

/** Stored error text is capped: it is shown in panels and notifications, not a log. */
export const ERROR_MAX_CHARS = 500;

/** Longest stored database name / file path; longer ones keep a hash of the whole. */
export const NAME_MAX_CHARS = 255;
/** Longest stored instance name (deployment_name is varchar(255)). */
const DEPLOYMENT_NAME_MAX_CHARS = 255;

/** Rows one tenant may hold; past it, each subject keeps fewer and folds the rest. */
export const MAX_ROWS_PER_TENANT = 500;
/** Rows one subject may hold before folding, while the tenant is under its cap. */
export const MAX_ROWS_PER_SUBJECT = 100;
/** The fewest rows a subject keeps when the tenant cap forces folding. */
const MIN_ROWS_PER_SUBJECT = 5;

/** Why a `dumped` entry is not a backup when its files snapshot failed. */
export const SNAPSHOT_NOT_KEPT_ERROR =
  'the dump was written, but the files snapshot that keeps it failed, so it was not kept';

/** Prefix of the error stamped on databases whose dumps did not run at all. */
export const DUMPS_DID_NOT_RUN_PREFIX = 'the dump did not run';

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
  readonly lastAlertedAt: Date | null;
  readonly createdAt: Date;
}

/** One bundle's outcome, as the orchestrator knows it. */
export interface BundleDatabaseOutcome {
  readonly tenantId: string;
  readonly bundleId: string;
  /** When the bundle finished — the attempt (and, if good, the success) time. */
  readonly at: Date;
  readonly summary: BackupDatabaseDumps;
  /** The files snapshot completed: it keeps the dumps that have no snapshot of their own (SQLite). */
  readonly snapshotKept: boolean;
  /**
   * The SQLite capture ran to its end without being cut short. False when the
   * file manager was not available, the capture threw, or a dump was
   * interrupted: then a missing SQLite file proves nothing.
   */
  readonly sqliteCaptureComplete: boolean;
  /** The catalog-database dumps did not run at all; why. */
  readonly databaseDumpsDidNotRun?: string;
  /** The SQLite capture did not run at all; why. */
  readonly sqliteDidNotRun?: string;
}

export interface RecordPlan {
  readonly upserts: readonly DatabaseBackupRow[];
  readonly deletes: ReadonlyArray<{ readonly subjectKey: string; readonly databaseName: string }>;
}

type SummaryEntry = BackupDatabaseDumps['deployments'][number]['databases'][number];

const key = (subjectKey: string, databaseName: string): string => `${subjectKey}\u0000${databaseName}`;

function capError(error: string | null | undefined): string | null {
  if (!error) return null;
  // Dump errors can echo the dump command line, and these rows feed panels
  // and notifications: redact again here rather than trust every path that
  // wrote one.
  const clean = redactDbSecrets(error);
  return clean.length > ERROR_MAX_CHARS ? `${clean.slice(0, ERROR_MAX_CHARS - 1)}…` : clean;
}

/** A tenant-supplied name, bounded; a cut name keeps a hash of the whole so it stays unique. */
export function boundedName(name: string, max = NAME_MAX_CHARS): string {
  if (name.length <= max) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `${name.slice(0, max - hash.length - 2)}…#${hash}`;
}

function subjectOf(d: BackupDatabaseDumps['deployments'][number]): string {
  return d.engine === 'sqlite' || d.deploymentId === '' ? SQLITE_SUBJECT : d.deploymentId;
}

const STATUS_RANK: Readonly<Record<DumpStatus, number>> = { dumped: 0, degraded: 1, failed: 2 };

/**
 * Fold a subject's entries past `keep` into one MORE_DATABASES_ENTRY row: its
 * status is the worst among them, its size their sum. Synthetic entries and
 * names sort first so they are never the ones folded.
 */
function foldEntries(entries: readonly SummaryEntry[], keep: number): SummaryEntry[] {
  if (entries.length <= keep) return [...entries];
  const sorted = [...entries].sort((a, b) => {
    const synth = (e: SummaryEntry) => (e.name.startsWith('(') ? 0 : 1);
    return synth(a) - synth(b) || a.name.localeCompare(b.name);
  });
  const kept = sorted.slice(0, Math.max(0, keep - 1));
  const rest = sorted.slice(kept.length);
  const worst = rest.reduce((w, e) => (STATUS_RANK[e.status] > STATUS_RANK[w] ? e.status : w), 'dumped' as DumpStatus);
  const failed = rest.filter((e) => e.status !== 'dumped').length;
  // The folded entry stands on its own snapshots only when every dump in it does.
  const ownSnapshots = rest.every((e) => e.status !== 'dumped' || Boolean(e.snapshotId));
  return [...kept, {
    name: MORE_DATABASES_ENTRY,
    status: worst,
    sizeBytes: rest.reduce((n, e) => n + (e.sizeBytes ?? 0), 0),
    error: failed === 0 ? null : `${failed} of ${rest.length} further databases were not backed up`,
    ...(ownSnapshots ? { snapshotId: rest.find((e) => e.snapshotId)?.snapshotId } : {}),
  }];
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

  const subjects = outcome.summary.deployments;
  const perSubject = Math.max(
    MIN_ROWS_PER_SUBJECT,
    Math.min(MAX_ROWS_PER_SUBJECT, Math.floor(MAX_ROWS_PER_TENANT / Math.max(1, subjects.length))),
  );

  const upsert = (prev: DatabaseBackupRow | undefined, base: Omit<DatabaseBackupRow,
    'lastSuccessAt' | 'lastSuccessBundleId' | 'lastSuccessSizeBytes' | 'staleSince' | 'alertedAt' | 'lastAlertedAt' | 'createdAt'>,
  good: { readonly sizeBytes: number } | null): void => {
    upserts.push({
      ...base,
      lastSuccessAt: good ? outcome.at : prev?.lastSuccessAt ?? null,
      lastSuccessBundleId: good ? outcome.bundleId : prev?.lastSuccessBundleId ?? null,
      lastSuccessSizeBytes: good ? good.sizeBytes : prev?.lastSuccessSizeBytes ?? null,
      // Episode state belongs to the sweep: it sees the success and sends
      // the recovery notice before clearing it.
      staleSince: prev?.staleSince ?? null,
      alertedAt: prev?.alertedAt ?? null,
      lastAlertedAt: prev?.lastAlertedAt ?? null,
      createdAt: prev?.createdAt ?? outcome.at,
    });
  };

  for (const dep of subjects) {
    const subjectKey = subjectOf(dep);
    seenSubjects.add(subjectKey);
    const listed = new Set<string>();
    const entries = foldEntries(dep.databases.map((d) => ({ ...d, name: boundedName(d.name) })), perSubject);
    for (const db of entries) {
      listed.add(db.name);
      const prev = byKey.get(key(subjectKey, db.name));
      // A dump with its own snapshot is kept by it; one that rode on the files
      // snapshot (SQLite, older bundles) only when that snapshot completed.
      const kept = db.status !== 'dumped' || Boolean(db.snapshotId) || outcome.snapshotKept;
      const status: DumpStatus = kept ? db.status : 'failed';
      const good = status === 'dumped';
      upsert(prev, {
        tenantId: outcome.tenantId,
        subjectKey,
        databaseName: db.name,
        deploymentId: subjectKey === SQLITE_SUBJECT ? null : dep.deploymentId,
        deploymentName: boundedName(dep.deploymentName, DEPLOYMENT_NAME_MAX_CHARS),
        engine: dep.engine,
        lastAttemptAt: outcome.at,
        lastAttemptBundleId: outcome.bundleId,
        lastStatus: status,
        lastError: good ? null : (kept ? capError(db.error) : SNAPSHOT_NOT_KEPT_ERROR),
      }, good ? { sizeBytes: db.sizeBytes } : null);
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

  // Subjects this bundle did not mention.
  for (const r of existing) {
    if (seenSubjects.has(r.subjectKey)) continue;
    const isSqlite = r.subjectKey === SQLITE_SUBJECT;
    // Gone, on positive evidence only: a deleted deployment, or a complete
    // SQLite capture that found no SQLite files at all.
    const gone = isSqlite ? outcome.sqliteCaptureComplete : !liveDeploymentIds.has(r.subjectKey);
    if (gone) {
      deletes.push({ subjectKey: r.subjectKey, databaseName: r.databaseName });
      continue;
    }
    // The dumps for it did not run: say so, instead of a last attempt that
    // still reads as backed up.
    const why = isSqlite ? outcome.sqliteDidNotRun : outcome.databaseDumpsDidNotRun;
    if (why) {
      upsert(r, {
        ...r,
        lastAttemptAt: outcome.at,
        lastAttemptBundleId: outcome.bundleId,
        lastStatus: 'failed',
        lastError: capError(`${DUMPS_DID_NOT_RUN_PREFIX}: ${why}`),
      }, null);
    }
  }

  return { upserts, deletes };
}

/**
 * Apply one bundle's outcome. Never throws: the bundle is already recorded,
 * and a status write that failed is retried by the next bundle.
 *
 * Bundles can overlap (a manual one during the nightly wave) and finish out
 * of order, so a write never moves a row's last attempt or last success
 * backwards: each group of columns is taken only from the newer of the stored
 * and the incoming value.
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

    const t = databaseBackupStatus;
    const newerAttempt = sql`excluded.last_attempt_at >= ${t.lastAttemptAt}`;
    const newerSuccess = sql`excluded.last_success_at IS NOT NULL AND (${t.lastSuccessAt} IS NULL OR excluded.last_success_at > ${t.lastSuccessAt})`;
    await db.transaction(async (tx) => {
      for (const d of plan.deletes) {
        await tx.delete(t).where(and(
          eq(t.tenantId, outcome.tenantId),
          eq(t.subjectKey, d.subjectKey),
          eq(t.databaseName, d.databaseName),
        ));
      }
      for (const row of plan.upserts) {
        await tx.insert(t).values(row).onConflictDoUpdate({
          target: [t.tenantId, t.subjectKey, t.databaseName],
          set: {
            deploymentId: sql`excluded.deployment_id`,
            deploymentName: sql`excluded.deployment_name`,
            engine: sql`excluded.engine`,
            lastAttemptAt: sql`CASE WHEN ${newerAttempt} THEN excluded.last_attempt_at ELSE ${t.lastAttemptAt} END`,
            lastAttemptBundleId: sql`CASE WHEN ${newerAttempt} THEN excluded.last_attempt_bundle_id ELSE ${t.lastAttemptBundleId} END`,
            lastStatus: sql`CASE WHEN ${newerAttempt} THEN excluded.last_status ELSE ${t.lastStatus} END`,
            lastError: sql`CASE WHEN ${newerAttempt} THEN excluded.last_error ELSE ${t.lastError} END`,
            lastSuccessAt: sql`CASE WHEN ${newerSuccess} THEN excluded.last_success_at ELSE ${t.lastSuccessAt} END`,
            lastSuccessBundleId: sql`CASE WHEN ${newerSuccess} THEN excluded.last_success_bundle_id ELSE ${t.lastSuccessBundleId} END`,
            lastSuccessSizeBytes: sql`CASE WHEN ${newerSuccess} THEN excluded.last_success_size_bytes ELSE ${t.lastSuccessSizeBytes} END`,
            // stale_since / alerted_at / last_alerted_at are the sweep's; a
            // concurrent sweep that just opened an episode must not be
            // overwritten here.
            staleSince: sql`${t.staleSince}`,
            alertedAt: sql`${t.alertedAt}`,
            lastAlertedAt: sql`${t.lastAlertedAt}`,
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
