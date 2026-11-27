/**
 * The overdue-backup sweep: one alert per episode, and its end.
 *
 * A database is overdue when it had no good backup in the latest scheduled
 * run that has had time to finish (wave.ts), and it was already known before
 * that run. Each sweep:
 *
 *   1. opens an episode (`stale_since`) for every newly overdue database;
 *   2. alerts on every open episode not yet alerted: ONE admin notification
 *      listing them all, then ONE per tenant listing its own. `alerted_at` is
 *      set only once the admin copy went out, so a failed dispatch is retried
 *      by the next sweep (the dedupe key, built from the episodes, keeps a
 *      partly delivered retry from repeating). A database alerted on less than
 *      ALERT_COOLDOWN_MS ago waits out the rest of that window: flapping
 *      backups are announced at most once per window, and an episode that ends
 *      inside it ends silently;
 *   3. closes every episode whose database has had a good backup since it
 *      opened, and — only for an episode that alerted — tells the admins and
 *      the tenant it is over.
 *
 * Only databases whose backups are expected to run are judged: the tenant is
 * in the nightly wave (not archived, suspended or excluded), the schedule
 * fires, and the database's instance is running (not stopped, not removed).
 * When that stops being true, an open episode closes silently.
 */

import { createHash } from 'node:crypto';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { backupJobs, backupSchedules, databaseBackupStatus, deployments, tenants } from '../../db/schema.js';
import { formatOccurredAt } from '../notifications/dispatcher/envelope.js';
import { cappedList } from '../notifications/list-items.js';
import { operatorNotificationText } from '../../shared/operator-only-text.js';
import type { DatabaseBackupRow } from './recorder.js';
import { DEPLOYMENT_ENTRY, MORE_DATABASES_ENTRY, SQLITE_DISCOVERY_ENTRY, SQLITE_SUBJECT } from './recorder.js';
import { DUMP_ERROR_LABELS, dumpErrorKind } from './error-kind.js';
import { judgedRun, runsAtOrBefore, waveAllowanceMs } from './wave.js';

/** A database alerted on this recently is not announced again yet. */
export const ALERT_COOLDOWN_MS = 12 * 3_600_000;

/** Longest notification item; error text is the part that gets cut. */
export const ITEM_MAX_CHARS = 300;

/** 'active' unless the instance is stopped or gone. SQLite files are always active. */
export type InstanceState = 'active' | 'stopped' | 'removed';

/** A row with the facts the sweep and the routes need. */
export interface SweepRow extends DatabaseBackupRow {
  readonly tenantName: string;
  readonly instanceState: InstanceState;
}

export interface SweepPlan {
  /** Newly overdue: open an episode now. */
  readonly open: readonly SweepRow[];
  /** Open episodes (incl. `open`) to alert on in this sweep. */
  readonly alert: readonly SweepRow[];
  /** Episodes that had a good backup since they opened. */
  readonly recovered: readonly SweepRow[];
  /** Episodes no longer judged or no longer overdue, with no new backup: close silently. */
  readonly expired: readonly SweepRow[];
}

/** Overdue against the run at `judged`: known before it, and no good backup since it. */
export function missedRun(r: DatabaseBackupRow, judged: Date): boolean {
  if (r.createdAt.getTime() >= judged.getTime()) return false;
  return r.lastSuccessAt === null || r.lastSuccessAt.getTime() < judged.getTime();
}

function inCooldown(r: DatabaseBackupRow, now: Date, cooldownMs: number): boolean {
  return r.lastAlertedAt !== null && now.getTime() - r.lastAlertedAt.getTime() < cooldownMs;
}

/**
 * Decide one sweep. Pure — unit tested directly. `judged` is the run to judge
 * against (wave.ts), null when there is none.
 */
export function planSweep(
  rows: readonly SweepRow[],
  now: Date,
  judged: Date | null,
  waveTenantIds: ReadonlySet<string>,
  cooldownMs: number = ALERT_COOLDOWN_MS,
): SweepPlan {
  const open: SweepRow[] = [];
  const alert: SweepRow[] = [];
  const recovered: SweepRow[] = [];
  const expired: SweepRow[] = [];
  for (const r of rows) {
    const judgeable = judged !== null && waveTenantIds.has(r.tenantId) && r.instanceState === 'active';
    if (r.staleSince) {
      if (r.lastSuccessAt && r.lastSuccessAt.getTime() > r.staleSince.getTime()) { recovered.push(r); continue; }
      if (!judgeable || !missedRun(r, judged)) { expired.push(r); continue; }
      if (!r.alertedAt && !inCooldown(r, now, cooldownMs)) alert.push(r);
      continue;
    }
    if (!judgeable || !missedRun(r, judged)) continue;
    const opened = { ...r, staleSince: now };
    open.push(opened);
    if (!inCooldown(r, now, cooldownMs)) alert.push(opened);
  }
  return { open, alert, recovered, expired };
}

const ENGINE_LABELS: Readonly<Record<string, string>> = {
  mariadb: 'MariaDB',
  mysql: 'MySQL',
  postgresql: 'PostgreSQL',
  mongodb: 'MongoDB',
  sqlite: 'SQLite',
};

/** What the database is called in a sentence, synthetic entries included. */
export function databaseLabel(r: Pick<DatabaseBackupRow, 'subjectKey' | 'databaseName'>): string {
  if (r.databaseName === DEPLOYMENT_ENTRY) return 'its databases (they could not be listed)';
  if (r.databaseName === SQLITE_DISCOVERY_ENTRY) return 'its SQLite files (they could not be searched)';
  if (r.databaseName === MORE_DATABASES_ENTRY) return 'its further databases (counted together)';
  return r.databaseName;
}

/** "my-mariadb (MariaDB)", or "SQLite files" for the volume's SQLite subject. */
export function instanceLabel(r: Pick<DatabaseBackupRow, 'subjectKey' | 'deploymentName' | 'engine'>): string {
  if (r.subjectKey === SQLITE_SUBJECT) return 'SQLite files on the volume';
  const engine = r.engine ? ENGINE_LABELS[r.engine] ?? r.engine : null;
  return engine ? `${r.deploymentName} (${engine})` : r.deploymentName;
}

function lastGood(r: DatabaseBackupRow): string {
  return r.lastSuccessAt ? `last good backup ${formatOccurredAt(r.lastSuccessAt)}` : 'never backed up';
}

function cut(s: string, max = ITEM_MAX_CHARS): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The error as an audience may read it: the operator the diagnosis, a tenant a category. */
export function errorFor(r: Pick<DatabaseBackupRow, 'lastError'>, audience: 'admin' | 'tenant'): string {
  if (!r.lastError) return '';
  if (audience === 'admin') return operatorNotificationText(r.lastError).trim();
  const kind = dumpErrorKind(r.lastError);
  return kind ? DUMP_ERROR_LABELS[kind] : '';
}

/** One list item, at most ITEM_MAX_CHARS. Tenant names are quoted: the tenant chose them. */
export function staleItem(r: SweepRow, audience: 'admin' | 'tenant'): string {
  const who = audience === 'admin' ? `"${r.tenantName}": ` : '';
  const error = errorFor(r, audience);
  const last = r.lastStatus === 'dumped' ? '' : `; last attempt ${r.lastStatus}${error ? `: ${error}` : ''}`;
  return cut(`${who}${instanceLabel(r)}, ${databaseLabel(r)}: ${lastGood(r)}${last}`);
}

export function recoveredItem(r: SweepRow, audience: 'admin' | 'tenant'): string {
  const who = audience === 'admin' ? `"${r.tenantName}": ` : '';
  const since = r.staleSince ? `, overdue since ${formatOccurredAt(r.staleSince)}` : '';
  return cut(`${who}${instanceLabel(r)}, ${databaseLabel(r)}: backed up ${formatOccurredAt(r.lastSuccessAt)}${since}`);
}

/** Dedupe key from the episodes themselves — never a wall-clock bucket. */
export function episodeKey(prefix: string, rows: readonly SweepRow[]): string {
  const ids = rows
    .map((r) => `${r.tenantId}|${r.subjectKey}|${r.databaseName}|${r.staleSince?.toISOString() ?? ''}`)
    .sort()
    .join('\n');
  return `${prefix}:${createHash('sha256').update(ids).digest('hex').slice(0, 40)}`;
}

function byTenant(rows: readonly SweepRow[]): Map<string, SweepRow[]> {
  const out = new Map<string, SweepRow[]>();
  for (const r of rows) out.set(r.tenantId, [...(out.get(r.tenantId) ?? []), r]);
  return out;
}

const rowKey = (r: DatabaseBackupRow) => and(
  eq(databaseBackupStatus.tenantId, r.tenantId),
  eq(databaseBackupStatus.subjectKey, r.subjectKey),
  eq(databaseBackupStatus.databaseName, r.databaseName),
);

export interface SweepResult {
  readonly opened: number;
  readonly alerted: number;
  readonly recovered: number;
  readonly closed: number;
  /** The run databases were judged against (ISO), null when none. */
  readonly judgedRun: string | null;
}

type Dispatched = Promise<{ ok: boolean; error?: string }>;

/** Everything a sweep reads, writes and sends — injected so tests run it whole. */
export interface SweepIo {
  readonly rows: () => Promise<SweepRow[]>;
  /** Open an episode — only if the row is still unopened and still overdue against `judged`. */
  readonly openEpisode: (r: SweepRow, at: Date, judged: Date) => Promise<void>;
  readonly closeEpisode: (r: SweepRow) => Promise<void>;
  readonly markAlerted: (r: SweepRow, at: Date) => Promise<void>;
  readonly notifyAdminStale: (tenantId: string | undefined, p: {
    databases: string[]; databaseCount: string; tenantCount: string; missedRun: string;
  }, dedupeKey: string) => Dispatched;
  readonly notifyTenantStale: (tenantId: string, p: { databases: string[]; missedRun: string }, dedupeKey: string) => Dispatched;
  readonly notifyAdminRecovered: (tenantId: string | undefined, p: { databases: string[]; databaseCount: string }, dedupeKey: string) => Dispatched;
  readonly notifyTenantRecovered: (tenantId: string, p: { databases: string[] }, dedupeKey: string) => Dispatched;
}

/** One sweep against `io`. Notification failures are logged, never thrown. */
export async function executeSweep(
  io: SweepIo,
  now: Date,
  judged: Date | null,
  waveTenantIds: ReadonlySet<string>,
): Promise<SweepResult> {
  const plan = planSweep(await io.rows(), now, judged, waveTenantIds);
  if (judged) for (const r of plan.open) await io.openEpisode(r, now, judged);
  for (const r of [...plan.recovered, ...plan.expired]) await io.closeEpisode(r);

  let alerted = 0;
  if (plan.alert.length > 0 && judged) alerted = await alertStale(io, plan.alert, judged, now);
  await announceRecoveries(io, plan.recovered.filter((r) => r.alertedAt !== null));
  return {
    opened: plan.open.length,
    alerted,
    recovered: plan.recovered.length,
    closed: plan.expired.length,
    judgedRun: judged?.toISOString() ?? null,
  };
}

/** The ONE tenant the rows belong to, or undefined when they span several. */
function onlyTenant(groups: ReadonlyMap<string, unknown>): string | undefined {
  return groups.size === 1 ? [...groups.keys()][0] : undefined;
}

async function alertStale(io: SweepIo, rows: readonly SweepRow[], judged: Date, now: Date): Promise<number> {
  const tenantsAffected = byTenant(rows);
  const missed = formatOccurredAt(judged) ?? judged.toISOString();
  const admin = await io.notifyAdminStale(onlyTenant(tenantsAffected), {
    databases: cappedList(rows.map((r) => staleItem(r, 'admin'))),
    databaseCount: String(rows.length),
    tenantCount: String(tenantsAffected.size),
    missedRun: missed,
  }, episodeKey('db-backup-stale:admin', rows));
  // The admin copy is the one that matters. If it did not go out, nothing is
  // marked: the next sweep alerts again, and the episode-derived dedupe key
  // keeps a partly delivered first attempt from repeating.
  if (!admin.ok) {
    console.error(`[database-backup-status] ADMIN overdue-backup alert did NOT dispatch (${admin.error ?? 'unknown'}); retrying next sweep`);
    return 0;
  }
  for (const r of rows) await io.markAlerted(r, now);

  for (const [tenantId, mine] of tenantsAffected) {
    const res = await io.notifyTenantStale(tenantId, {
      databases: cappedList(mine.map((r) => staleItem(r, 'tenant'))),
      missedRun: missed,
    }, episodeKey(`db-backup-stale:tenant:${tenantId}`, mine));
    // Informational, and the address may be undeliverable; the admins have it.
    if (!res.ok) console.warn(`[database-backup-status] tenant copy for ${tenantId} did not dispatch: ${res.error ?? 'unknown'}`);
  }
  return rows.length;
}

async function announceRecoveries(io: SweepIo, rows: readonly SweepRow[]): Promise<void> {
  if (rows.length === 0) return;
  const tenantsAffected = byTenant(rows);
  const admin = await io.notifyAdminRecovered(onlyTenant(tenantsAffected), {
    databases: cappedList(rows.map((r) => recoveredItem(r, 'admin'))),
    databaseCount: String(rows.length),
  }, episodeKey('db-backup-recovered:admin', rows));
  if (!admin.ok) console.warn(`[database-backup-status] admin recovery notice did not dispatch: ${admin.error ?? 'unknown'}`);
  for (const [tenantId, mine] of tenantsAffected) {
    const res = await io.notifyTenantRecovered(tenantId, {
      databases: cappedList(mine.map((r) => recoveredItem(r, 'tenant'))),
    }, episodeKey(`db-backup-recovered:tenant:${tenantId}`, mine));
    if (!res.ok) console.warn(`[database-backup-status] tenant recovery notice for ${tenantId} did not dispatch: ${res.error ?? 'unknown'}`);
  }
}

/**
 * The scheduled run to judge against: the schedule's last two fires, the
 * length of the last completed wave, and whether a wave is still running.
 * A scheduled bundle is one the platform started (initiator 'system',
 * trigger 'scheduled').
 */
export async function resolveJudgedRun(db: Database, now: Date): Promise<Date | null> {
  const [schedule] = await db.select().from(backupSchedules).where(eq(backupSchedules.subsystem, 'tenant_bundle'));
  if (!schedule?.enabled || !schedule.cronExpression) return null;
  const { resolvePlatformTimeZone } = await import('../system-settings/platform-timezone.js');
  const zone = await resolvePlatformTimeZone(db);
  const [last, prev] = runsAtOrBefore(schedule.cronExpression, zone, now, 2);
  if (!last) return null;

  let lastCompletedWaveMs: number | null = null;
  let runningWaveFiredAt: Date | null = null;
  const scheduled = and(eq(backupJobs.initiator, 'system'), eq(backupJobs.systemTrigger, 'scheduled'));
  const inFlight = sql`${backupJobs.status} IN ('pending', 'running')`;
  const [cur] = await db.select({ running: sql<number>`count(*)::int` }).from(backupJobs)
    .where(and(scheduled, sql`${backupJobs.startedAt} >= ${last}`, inFlight));
  if ((cur?.running ?? 0) > 0) runningWaveFiredAt = last;
  if (prev) {
    const [w] = await db.select({
      end: sql<Date | null>`max(${backupJobs.finishedAt})`,
      running: sql<number>`count(*) FILTER (WHERE ${inFlight})::int`,
    }).from(backupJobs)
      .where(and(scheduled, sql`${backupJobs.startedAt} >= ${prev}`, sql`${backupJobs.startedAt} < ${last}`));
    if ((w?.running ?? 0) > 0 && !runningWaveFiredAt) runningWaveFiredAt = prev;
    else if (w?.end) lastCompletedWaveMs = new Date(w.end).getTime() - prev.getTime();
  }
  return judgedRun(schedule.cronExpression, zone, now, waveAllowanceMs(lastCompletedWaveMs), runningWaveFiredAt, schedule.lastFiredAt ?? null);
}

/** The sweep against the platform database and the real dispatcher. */
export async function runDatabaseBackupSweep(db: Database, now: Date = new Date()): Promise<SweepResult> {
  const judged = await resolveJudgedRun(db, now);
  const { selectWaveTenants } = await import('../tenant-bundles/global-scheduler.js');
  const wave = new Set((await selectWaveTenants(db)).map((t) => t.id));

  const events = await import('../notifications/events.js');
  return executeSweep({
    rows: () => loadRows(db, {}),
    // Guarded on the row still being unopened and still overdue: a bundle
    // that recorded a success since the read, or a second sweep racing past
    // the lease, must not open (or move) the episode its dedupe key names.
    openEpisode: async (r, at, j) => {
      await db.update(databaseBackupStatus).set({ staleSince: at })
        .where(and(
          rowKey(r),
          sql`${databaseBackupStatus.staleSince} IS NULL`,
          sql`(${databaseBackupStatus.lastSuccessAt} IS NULL OR ${databaseBackupStatus.lastSuccessAt} < ${j})`,
        ));
    },
    closeEpisode: async (r) => {
      await db.update(databaseBackupStatus).set({ staleSince: null, alertedAt: null }).where(rowKey(r));
    },
    markAlerted: async (r, at) => {
      await db.update(databaseBackupStatus).set({ alertedAt: at, lastAlertedAt: at }).where(rowKey(r));
    },
    notifyAdminStale: (tenantId, p, key) => events.notifyAdminDatabaseBackupStale(db, tenantId, p, key),
    notifyTenantStale: (tenantId, p, key) => events.notifyTenantDatabaseBackupStale(db, tenantId, p, key),
    notifyAdminRecovered: (tenantId, p, key) => events.notifyAdminDatabaseBackupRecovered(db, tenantId, p, key),
    notifyTenantRecovered: (tenantId, p, key) => events.notifyTenantDatabaseBackupRecovered(db, tenantId, p, key),
  }, now, judged, wave);
}

/** A row's instance, from its deployment: gone or deleted → removed, stopped → stopped. */
const instanceStateSql = sql<InstanceState>`CASE
  WHEN ${databaseBackupStatus.subjectKey} = ${SQLITE_SUBJECT} THEN 'active'
  WHEN ${deployments.id} IS NULL OR ${deployments.status} = 'deleted' OR ${deployments.deletedAt} IS NOT NULL THEN 'removed'
  WHEN ${deployments.status} = 'stopped' THEN 'stopped'
  ELSE 'active' END`;

export interface RowPage {
  readonly rows: SweepRow[];
  readonly hasMore: boolean;
}

/**
 * Rows with their tenant and instance facts. Without `page`, every row (the
 * sweep); with it, one keyset page in a stable order — overdue first, then by
 * instance and database (one tenant), or by tenant (the overdue fleet list).
 */
export async function loadRows(
  db: Database,
  filter: { readonly tenantId?: string; readonly staleOnly?: boolean },
): Promise<SweepRow[]> {
  return (await loadRowPage(db, filter)).rows;
}

export async function loadRowPage(
  db: Database,
  filter: { readonly tenantId?: string; readonly staleOnly?: boolean },
  page?: { readonly limit: number; readonly after?: readonly string[] },
): Promise<RowPage> {
  const t = databaseBackupStatus;
  const where: SQL[] = [];
  if (filter.tenantId) where.push(eq(t.tenantId, filter.tenantId));
  if (filter.staleOnly) where.push(sql`${t.staleSince} IS NOT NULL`);
  // One tenant: overdue first. Fleet (overdue only): by tenant name.
  const order: SQL[] = filter.tenantId
    ? [sql`(${t.staleSince} IS NULL)::int`, sql`${t.subjectKey}`, sql`${t.databaseName}`]
    : [sql`${tenants.name}`, sql`${t.tenantId}`, sql`${t.subjectKey}`, sql`${t.databaseName}`];
  if (page?.after && page.after.length === order.length) {
    const tuple = sql.join(order, sql`, `);
    const values = sql.join(page.after.map((v, i) => (filter.tenantId && i === 0 ? sql`${Number(v)}::int` : sql`${v}`)), sql`, `);
    where.push(sql`(${tuple}) > (${values})`);
  }
  const q = db
    .select({ row: t, tenantName: tenants.name, instanceState: instanceStateSql })
    .from(t)
    .innerJoin(tenants, eq(tenants.id, t.tenantId))
    .leftJoin(deployments, eq(deployments.id, t.deploymentId))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(...order.map((o) => asc(o)));
  const raw = page ? await q.limit(page.limit + 1) : await q;
  const rows = raw.map((r) => ({ ...(r.row as DatabaseBackupRow), tenantName: r.tenantName, instanceState: r.instanceState }));
  if (!page) return { rows, hasMore: false };
  return { rows: rows.slice(0, page.limit), hasMore: rows.length > page.limit };
}

/** The keyset values of a row, in the order loadRowPage sorts by. */
export function pageKey(r: SweepRow, scope: 'tenant' | 'fleet'): string[] {
  return scope === 'tenant'
    ? [r.staleSince ? '0' : '1', r.subjectKey, r.databaseName]
    : [r.tenantName, r.tenantId, r.subjectKey, r.databaseName];
}
