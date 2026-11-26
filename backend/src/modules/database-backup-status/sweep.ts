/**
 * The stale-backup sweep: one alert per episode, and its end.
 *
 * A database is stale when its last good backup (or, if it never had one, the
 * moment it was first seen) is older than the schedule allows
 * (threshold.ts). Each sweep:
 *
 *   1. opens an episode (`stale_since`) for every newly stale database of a
 *      tenant the nightly wave covers;
 *   2. alerts on every open episode not yet alerted: ONE admin notification
 *      listing them all, then ONE per tenant listing its own. `alerted_at` is
 *      set only once the admin copy went out, so a failed dispatch is retried
 *      by the next sweep (the dedupe key, built from the episodes, keeps a
 *      partly delivered retry from repeating);
 *   3. closes every episode whose database has had a good backup since it
 *      opened, and — only for an episode that alerted — tells the admins and
 *      the tenant it is over. An episode the threshold no longer calls stale
 *      (the schedule changed) closes silently.
 *
 * Archived, suspended and wave-excluded tenants get no new episodes: their
 * backups are not expected to run.
 */

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { backupSchedules, databaseBackupStatus, tenants } from '../../db/schema.js';
import { formatOccurredAt } from '../notifications/dispatcher/envelope.js';
import { cappedList } from '../notifications/list-items.js';
import { tenantVisibleText } from '../../shared/operator-only-text.js';
import type { DatabaseBackupRow } from './recorder.js';
import { DEPLOYMENT_ENTRY, SQLITE_DISCOVERY_ENTRY, SQLITE_SUBJECT } from './recorder.js';
import { staleThresholdMs } from './threshold.js';

/** A row with the tenant facts the sweep needs. */
export interface SweepRow extends DatabaseBackupRow {
  readonly tenantName: string;
}

export interface SweepPlan {
  /** Newly stale: open an episode now. */
  readonly open: readonly SweepRow[];
  /** Open episodes (incl. `open`) to alert on in this sweep. */
  readonly alert: readonly SweepRow[];
  /** Episodes that had a good backup since they opened. */
  readonly recovered: readonly SweepRow[];
  /** Episodes the threshold no longer calls stale, with no new backup: close silently. */
  readonly expired: readonly SweepRow[];
}

/**
 * Decide one sweep. Pure — unit tested directly. `thresholdMs` null means the
 * schedule never fires: nothing opens, open episodes stay until they recover.
 */
export function planSweep(
  rows: readonly SweepRow[],
  now: Date,
  thresholdMs: number | null,
  waveTenantIds: ReadonlySet<string>,
): SweepPlan {
  const open: SweepRow[] = [];
  const alert: SweepRow[] = [];
  const recovered: SweepRow[] = [];
  const expired: SweepRow[] = [];
  for (const r of rows) {
    const goodAt = r.lastSuccessAt ?? null;
    if (r.staleSince) {
      if (goodAt && goodAt.getTime() > r.staleSince.getTime()) { recovered.push(r); continue; }
      const stillStale = thresholdMs === null || isStale(r, now, thresholdMs);
      if (!stillStale) { expired.push(r); continue; }
      if (!r.alertedAt && waveTenantIds.has(r.tenantId)) alert.push(r);
      continue;
    }
    if (thresholdMs === null || !waveTenantIds.has(r.tenantId)) continue;
    if (isStale(r, now, thresholdMs)) {
      const opened = { ...r, staleSince: now };
      open.push(opened);
      alert.push(opened);
    }
  }
  return { open, alert, recovered, expired };
}

function isStale(r: DatabaseBackupRow, now: Date, thresholdMs: number): boolean {
  const since = r.lastSuccessAt ?? r.createdAt;
  return now.getTime() - since.getTime() > thresholdMs;
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

/** One list item. `audience` decides how much of the error is shown. */
export function staleItem(r: SweepRow, audience: 'admin' | 'tenant'): string {
  const who = audience === 'admin' ? `${r.tenantName}: ` : '';
  const raw = r.lastError ?? '';
  const error = audience === 'tenant' ? tenantVisibleText(raw).trim() : raw.trim();
  const last = r.lastStatus === 'dumped' ? '' : `; last attempt ${r.lastStatus}${error ? `: ${error}` : ''}`;
  return `${who}${instanceLabel(r)}, ${databaseLabel(r)}: ${lastGood(r)}${last}`;
}

export function recoveredItem(r: SweepRow, audience: 'admin' | 'tenant'): string {
  const who = audience === 'admin' ? `${r.tenantName}: ` : '';
  const since = r.staleSince ? `, overdue since ${formatOccurredAt(r.staleSince)}` : '';
  return `${who}${instanceLabel(r)}, ${databaseLabel(r)}: backed up ${formatOccurredAt(r.lastSuccessAt)}${since}`;
}

/** Dedupe key from the episodes themselves — never a wall-clock bucket. */
export function episodeKey(prefix: string, rows: readonly SweepRow[]): string {
  const ids = rows
    .map((r) => `${r.tenantId}|${r.subjectKey}|${r.databaseName}|${r.staleSince?.toISOString() ?? ''}`)
    .sort()
    .join('\n');
  return `${prefix}:${createHash('sha256').update(ids).digest('hex').slice(0, 40)}`;
}

/** "26 hours", "7 days and 2 hours". */
export function describeThreshold(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} hours`;
  const days = Math.floor(hours / 24);
  const rest = hours - days * 24;
  return rest === 0 ? `${days} days` : `${days} days and ${rest} hours`;
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
  readonly thresholdMs: number | null;
}

type Dispatched = Promise<{ ok: boolean; error?: string }>;

/** Everything a sweep reads, writes and sends — injected so tests run it whole. */
export interface SweepIo {
  readonly rows: () => Promise<SweepRow[]>;
  readonly openEpisode: (r: SweepRow, at: Date) => Promise<void>;
  readonly closeEpisode: (r: SweepRow) => Promise<void>;
  readonly markAlerted: (r: SweepRow, at: Date) => Promise<void>;
  readonly notifyAdminStale: (tenantId: string | undefined, p: {
    databases: string[]; databaseCount: string; tenantCount: string; staleAfter: string;
  }, dedupeKey: string) => Dispatched;
  readonly notifyTenantStale: (tenantId: string, p: { databases: string[]; staleAfter: string }, dedupeKey: string) => Dispatched;
  readonly notifyAdminRecovered: (tenantId: string | undefined, p: { databases: string[]; databaseCount: string }, dedupeKey: string) => Dispatched;
  readonly notifyTenantRecovered: (tenantId: string, p: { databases: string[] }, dedupeKey: string) => Dispatched;
}

/** One sweep against `io`. Notification failures are logged, never thrown. */
export async function executeSweep(
  io: SweepIo,
  now: Date,
  thresholdMs: number | null,
  waveTenantIds: ReadonlySet<string>,
): Promise<SweepResult> {
  const plan = planSweep(await io.rows(), now, thresholdMs, waveTenantIds);
  for (const r of plan.open) await io.openEpisode(r, now);
  for (const r of [...plan.recovered, ...plan.expired]) await io.closeEpisode(r);

  let alerted = 0;
  if (plan.alert.length > 0 && thresholdMs !== null) alerted = await alertStale(io, plan.alert, thresholdMs, now);
  await announceRecoveries(io, plan.recovered.filter((r) => r.alertedAt !== null));
  return { opened: plan.open.length, alerted, recovered: plan.recovered.length, thresholdMs };
}

/** The ONE tenant the rows belong to, or undefined when they span several. */
function onlyTenant(groups: ReadonlyMap<string, unknown>): string | undefined {
  return groups.size === 1 ? [...groups.keys()][0] : undefined;
}

async function alertStale(io: SweepIo, rows: readonly SweepRow[], thresholdMs: number, now: Date): Promise<number> {
  const tenantsAffected = byTenant(rows);
  const staleAfter = describeThreshold(thresholdMs);
  const admin = await io.notifyAdminStale(onlyTenant(tenantsAffected), {
    databases: cappedList(rows.map((r) => staleItem(r, 'admin'))),
    databaseCount: String(rows.length),
    tenantCount: String(tenantsAffected.size),
    staleAfter,
  }, episodeKey('db-backup-stale:admin', rows));
  // The admin copy is the one that matters. If it did not go out, nothing is
  // marked: the next sweep alerts again, and the episode-derived dedupe key
  // keeps a partly delivered first attempt from repeating.
  if (!admin.ok) {
    console.error(`[database-backup-status] ADMIN stale-backup alert did NOT dispatch (${admin.error ?? 'unknown'}); retrying next sweep`);
    return 0;
  }
  for (const r of rows) await io.markAlerted(r, now);

  for (const [tenantId, mine] of tenantsAffected) {
    const res = await io.notifyTenantStale(tenantId, {
      databases: cappedList(mine.map((r) => staleItem(r, 'tenant'))),
      staleAfter,
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

/** The sweep against the platform database and the real dispatcher. */
export async function runDatabaseBackupSweep(db: Database, now: Date = new Date()): Promise<SweepResult> {
  const [schedule] = await db.select().from(backupSchedules).where(eq(backupSchedules.subsystem, 'tenant_bundle'));
  const { resolvePlatformTimeZone } = await import('../system-settings/platform-timezone.js');
  const zone = await resolvePlatformTimeZone(db);
  const thresholdMs = schedule?.enabled ? staleThresholdMs(schedule.cronExpression, zone, now) : null;

  const { selectWaveTenants } = await import('../tenant-bundles/global-scheduler.js');
  const wave = new Set((await selectWaveTenants(db)).map((t) => t.id));

  const events = await import('../notifications/events.js');
  return executeSweep({
    rows: () => loadRows(db, {}),
    // Guarded on IS NULL: a second sweep racing past the lease cannot move
    // an episode's start, which its dedupe key is built from.
    openEpisode: async (r, at) => {
      await db.update(databaseBackupStatus).set({ staleSince: at })
        .where(and(rowKey(r), sql`${databaseBackupStatus.staleSince} IS NULL`));
    },
    closeEpisode: async (r) => {
      await db.update(databaseBackupStatus).set({ staleSince: null, alertedAt: null }).where(rowKey(r));
    },
    markAlerted: async (r, at) => {
      await db.update(databaseBackupStatus).set({ alertedAt: at }).where(rowKey(r));
    },
    notifyAdminStale: (tenantId, p, key) => events.notifyAdminDatabaseBackupStale(db, tenantId, p, key),
    notifyTenantStale: (tenantId, p, key) => events.notifyTenantDatabaseBackupStale(db, tenantId, p, key),
    notifyAdminRecovered: (tenantId, p, key) => events.notifyAdminDatabaseBackupRecovered(db, tenantId, p, key),
    notifyTenantRecovered: (tenantId, p, key) => events.notifyTenantDatabaseBackupRecovered(db, tenantId, p, key),
  }, now, thresholdMs, wave);
}

/** Exported for the routes: rows of one tenant, or every stale one. */
export async function loadRows(db: Database, filter: { readonly tenantId?: string; readonly staleOnly?: boolean }): Promise<SweepRow[]> {
  const where = [];
  if (filter.tenantId) where.push(eq(databaseBackupStatus.tenantId, filter.tenantId));
  if (filter.staleOnly) where.push(sql`${databaseBackupStatus.staleSince} IS NOT NULL`);
  const q = db
    .select({ row: databaseBackupStatus, tenantName: tenants.name })
    .from(databaseBackupStatus)
    .innerJoin(tenants, eq(tenants.id, databaseBackupStatus.tenantId));
  const rows = where.length > 0 ? await q.where(and(...where)) : await q;
  return rows.map((r) => ({ ...(r.row as DatabaseBackupRow), tenantName: r.tenantName })) as SweepRow[];
}
