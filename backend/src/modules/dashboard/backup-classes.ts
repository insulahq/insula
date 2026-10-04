import { sql } from 'drizzle-orm';
import type { AdminDashboardSummary } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { evaluateFreshness, resolveScheduleZone } from '../backup-health/freshness.js';
import { fromCnpgCron } from '../backup-schedules/cadence/targets.js';
import { readSystemBackupFacts } from '../system-backup/footprint-store.js';

type BackupsData = NonNullable<AdminDashboardSummary['backups']['data']>;
type BackupClassRow = BackupsData['classes'][number];

/**
 * The Backups & DR card: per class, when it last WORKED, how much it stores,
 * and whether it is on schedule — each from that class's own source.
 *
 *   system — the platform database's CNPG base backups (+ WAL), etcd snapshots
 *            and DR bundles at the system target. Last success: the newest
 *            completed base backup (recorded by the CNPG health tick). Size: an
 *            hourly LIST of the system target. NOT `system_backup_runs`: that
 *            holds only manual operator exports, so it showed a months-old
 *            secrets export as the last system backup.
 *   tenant — tenant bundles. Last success: the newest FINISHED bundle. Size:
 *            the tenant repositories' measured totals (`repo_total_bytes`), not
 *            the bytes the last snapshot processed.
 *   mail   — the whole mail store's snapshot repository (Stalwart), separate
 *            from the per-tenant mailbox data in the tenant repos. Last success
 *            and size: what the snapshot job reports after each run.
 *
 * DB-only, like the rest of the summary: the k8s- and target-backed facts are
 * persisted by their schedulers and read here.
 */
export async function buildBackupClasses(db: Database, now: Date = new Date()): Promise<BackupsData> {
  const assign = await db.execute<{ backup_class: string; target: string | null; kind: string | null }>(sql`
    SELECT a.backup_class, c.name AS target, c."storageType" AS kind
      FROM backup_target_assignments a
      LEFT JOIN backup_configurations c ON c.id = a.target_id
  `);
  const byClass = new Map((assign.rows ?? []).map((r) => [r.backup_class, r]));

  const schedules = await db.execute<{ subsystem: string; cron_expression: string | null; enabled: boolean }>(sql`
    SELECT subsystem, cron_expression, enabled FROM backup_schedules
  `);
  const scheduleOf = (subsystem: string): Schedule => {
    const row = (schedules.rows ?? []).find((r) => r.subsystem === subsystem);
    return row?.enabled ? { enabled: true, cron: row.cron_expression } : { enabled: false, cron: null };
  };
  const baseBackup = await db.execute<{ schedule: string | null }>(sql`
    SELECT base_backup_schedule AS schedule FROM system_wal_archive_state
     WHERE cluster_namespace = 'platform' AND cluster_name = 'system-db' LIMIT 1
  `);
  const platformZone = await platformTimeZone(db);

  // ── tenant ──
  const fresh = await db.execute<{ newest: string | Date | null; bundles: number }>(sql`
    SELECT MAX(COALESCE(finished_at, created_at)) AS newest, COUNT(*)::int AS bundles
      FROM backup_jobs WHERE status = 'completed'
  `);
  const f = (fresh.rows ?? [])[0];
  // One row per (tenant, component); since the repository merge a tenant's
  // second component is anchored to 0, so the plain sum is the stored total.
  const repo = await db.execute<{ total: string | number | null; unmeasured: number }>(sql`
    SELECT SUM(repo_total_bytes)::bigint AS total,
           COUNT(*) FILTER (WHERE repo_total_bytes IS NULL)::int AS unmeasured
      FROM tenant_restic_repo_state
  `);
  const repoRow = (repo.rows ?? [])[0];
  const tenantBytes = repoRow?.total == null ? null : Number(repoRow.total);

  // ── mail ──
  const mail = await db.execute<{ stats: { runAt?: string; totalSnapshotSizeBytes?: number } | null }>(sql`
    SELECT mail_snapshot_last_run_stats AS stats FROM system_settings WHERE id = 'system'
  `);
  const mailStats = (mail.rows ?? [])[0]?.stats ?? null;
  // The job posts 0 when `restic stats` fails; a repository that just took a
  // successful snapshot is never empty, so 0 here means "not measured".
  const mailBytes = mailStats?.totalSnapshotSizeBytes ? Number(mailStats.totalSnapshotSizeBytes) : null;

  // ── system ──
  const { lastSuccess: sysLast, footprint } = await readSystemBackupFacts(db);
  const sysBytes = footprint && !footprint.error ? footprint.totalBytes : null;

  const never = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM tenants t
     WHERE t.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM backup_jobs b WHERE b.tenant_id = t.id AND b.status = 'completed')
  `);

  const iso = (v: string | Date | null | undefined): string | null => (v ? new Date(v).toISOString() : null);
  const baseSchedule = (baseBackup.rows ?? [])[0]?.schedule ?? null;

  const rows: Record<'system' | 'tenant' | 'mail', Omit<BackupClassRow, 'backupClass' | 'targetName' | 'targetKind' | 'healthy' | 'healthDetail'> & { schedule: Schedule; zone: string }> = {
    system: {
      lastSuccessAt: sysLast?.at ?? null,
      repoBytes: sysBytes,
      repoMeasuredAt: footprint?.measuredAt ?? null,
      repoBytesPartial: Boolean(footprint?.truncated),
      // CNPG evaluates ScheduledBackup crons (6-field) in the operator's UTC.
      // No row / no schedule = periodic base backups are switched off.
      schedule: baseSchedule ? { enabled: true, cron: fromCnpgCron(baseSchedule) } : { enabled: false, cron: null },
      zone: 'UTC',
    },
    tenant: {
      lastSuccessAt: iso(f?.newest),
      repoBytes: tenantBytes,
      repoMeasuredAt: null,
      repoBytesPartial: Number(repoRow?.unmeasured ?? 0) > 0,
      schedule: scheduleOf('tenant_bundle'),
      zone: platformZone,
    },
    mail: {
      lastSuccessAt: mailStats?.runAt ? iso(mailStats.runAt) : null,
      repoBytes: mailBytes,
      repoMeasuredAt: mailBytes !== null && mailStats?.runAt ? iso(mailStats.runAt) : null,
      repoBytesPartial: false,
      schedule: scheduleOf('mail'),
      zone: platformZone,
    },
  };

  return {
    classes: (['system', 'tenant', 'mail'] as const).map((cls) => {
      const a = byClass.get(cls);
      const r = rows[cls];
      const health = classHealth({ target: a?.target ?? null, lastSuccessAt: r.lastSuccessAt, schedule: r.schedule, zone: r.zone, now });
      return {
        backupClass: cls,
        lastSuccessAt: r.lastSuccessAt,
        targetName: a?.target ?? null,
        targetKind: a?.kind ?? null,
        healthy: health.healthy,
        healthDetail: health.detail,
        repoBytes: r.repoBytes,
        repoMeasuredAt: r.repoMeasuredAt,
        repoBytesPartial: r.repoBytesPartial,
      };
    }),
    bundles: Number(f?.bundles ?? 0),
    repoBytes: tenantBytes,
    tenantsNeverBackedUp: Number((never.rows ?? [])[0]?.n ?? 0),
  };
}

export interface Schedule {
  readonly enabled: boolean;
  readonly cron: string | null;
}

/** Without a parseable schedule, a success older than this is not "healthy". */
const UNSCHEDULED_FRESH_MS = 48 * 3_600_000;

/**
 * Healthy = a target, a success, scheduled backups switched ON, and no
 * scheduled run missed beyond its grace — judged by the same evaluator the
 * backup-freshness alerts use, so the card and the alerts cannot disagree.
 *
 * A switched-off schedule is NOT healthy, however recent the last success:
 * nothing renews it, and a green dot over a frozen timestamp is exactly how a
 * stopped backup goes unnoticed for days.
 */
export function classHealth(input: {
  readonly target: string | null;
  readonly lastSuccessAt: string | null;
  readonly schedule: Schedule;
  readonly zone: string;
  readonly now: Date;
}): { healthy: boolean; detail: string } {
  if (!input.target) return { healthy: false, detail: 'No backup target assigned.' };
  if (!input.schedule.enabled) {
    return { healthy: false, detail: 'Scheduled backups are switched off — nothing renews the last success.' };
  }
  if (!input.lastSuccessAt) return { healthy: false, detail: 'No successful backup recorded yet.' };
  const verdict = evaluateFreshness({
    lastSuccessAt: new Date(input.lastSuccessAt),
    cronExpression: input.schedule.cron,
    now: input.now,
    timeZone: input.zone,
  });
  if (verdict.verdict === 'stale') return { healthy: false, detail: verdict.detail };
  if (verdict.verdict === 'unknown') {
    const age = input.now.getTime() - Date.parse(input.lastSuccessAt);
    return age <= UNSCHEDULED_FRESH_MS
      ? { healthy: true, detail: `${verdict.detail} Last success within 48 h.` }
      : { healthy: false, detail: `${verdict.detail} Last success is older than 48 h.` };
  }
  return { healthy: true, detail: verdict.detail };
}

/** The zone platform-fired schedules run in (see resolveScheduleZone). */
export async function platformTimeZone(db: Database): Promise<string> {
  try {
    const { getSettings } = await import('../system-settings/service.js');
    return resolveScheduleZone(null, (await getSettings(db)).timezone ?? null);
  } catch {
    return 'UTC';
  }
}
