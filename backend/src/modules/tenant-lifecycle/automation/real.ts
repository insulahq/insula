/**
 * The automatic archive/delete sweep bound to the database and the cluster,
 * and the status the admin panel shows for it.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import type {
  TenantAutomationCandidate,
  TenantAutomationKept,
  TenantAutomationRun,
  TenantAutomationStatus,
} from '@insula/api-contracts';
import type { Database } from '../../../db/index.js';
import { storageOperations, tenantAutomationNotices, tenants } from '../../../db/schema.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../../shared/errors.js';
import { isRunUnderWay } from '../../../shared/exclusive-run.js';
import { loadAutomationRunRecord, loadTenantAutomationSettings, saveAutomationRun } from './settings.js';
import { runTenantAutomationSweep, type ActionOutcome, type InLineTenant, type Step, type SweepIo, type TellOutcome } from './sweep.js';

/** The sweep's lease, and with `-run` its run lock. */
export const TENANT_AUTOMATION_JOB = 'storage-auto-archive';

/** How often the sweep runs by itself. */
export const TENANT_AUTOMATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The longest one sweep is waited for. It archives one tenant after another,
 * and the day it is switched on a whole backlog may be due — far beyond the
 * run lock's usual half hour.
 */
export const TENANT_AUTOMATION_MAX_HOLD_MS = 24 * 60 * 60 * 1000;

/** How long one tenant's archive may take before the sweep moves on. */
const ARCHIVE_WAIT_MS = 4 * 60 * 60 * 1000;
const ARCHIVE_POLL_MS = 5_000;

/** At most this many tenants per list in the status. */
const MAX_CANDIDATES = 500;

/** What each step looks at: the status a tenant is in, and the date its days count from. */
const STEP = {
  archive: { status: 'suspended', since: tenants.suspendedAt },
  delete: { status: 'archived', since: tenants.archivedAt },
} as const;

export interface AutomationDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly config: Record<string, unknown>;
}

/** Refusals that mean "not now", not "broken": the tenant is left for a later sweep. */
const NOT_NOW = new Set(['NO_LONGER_DUE', 'TENANT_BUSY', 'STORAGE_OP_IN_PROGRESS', 'ALREADY_ARCHIVED', 'TENANT_NOT_FOUND']);

/** What a tenant's storage state must be cleared from before anything can start on it. */
const STUCK = 'Its last storage operation failed and has not been cleared. Clear it on the tenant\'s page; the tenant is skipped until then.';

export function outcomeOfRefusal(err: unknown): ActionOutcome {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof ApiError) || !NOT_NOW.has(err.code)) return { kind: 'failed', error: message };
  // "An operation is in progress" passes by itself. A FAILED operation does
  // not: nothing clears it but an operator, so a tenant in that state would be
  // passed over at every sweep for ever with only a log line to show for it.
  const state = (err.details as { currentState?: unknown } | undefined)?.currentState;
  if (err.code === 'STORAGE_OP_IN_PROGRESS' && state === 'failed') return { kind: 'failed', error: STUCK };
  return { kind: 'skipped', reason: message };
}

/** A storage operation's stored error: the envelope's title when it is one, else the text. */
function readableOpError(raw: string | null): string {
  if (!raw) return 'the archive failed';
  try {
    const parsed = JSON.parse(raw) as { title?: unknown; detail?: unknown };
    const parts = [parsed.title, parsed.detail].filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length > 0) return parts.join(': ');
  } catch { /* plain text */ }
  return raw;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Wait for a storage operation to end; an archive runs detached from the call that starts it. */
async function waitForArchive(db: Database, operationId: string, timeoutMs: number, pollMs: number): Promise<ActionOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [op] = await db
      .select({ state: storageOperations.state, completedAt: storageOperations.completedAt, lastError: storageOperations.lastError })
      .from(storageOperations)
      .where(eq(storageOperations.id, operationId));
    // Gone with its tenant: somebody deleted the tenant while it was archived.
    if (!op) return { kind: 'failed', error: 'the tenant was deleted while it was being archived' };
    if (op.completedAt) {
      return op.state === 'failed' ? { kind: 'failed', error: readableOpError(op.lastError) } : { kind: 'done' };
    }
    if (Date.now() >= deadline) {
      return { kind: 'failed', error: `the archive was still running after ${Math.round(timeoutMs / 3_600_000)} h` };
    }
    await sleep(pollMs);
  }
}

async function archiveBlockedReason(deps: AutomationDeps): Promise<string | null> {
  try {
    const { buildArchiveServiceCtx } = await import('../../storage-lifecycle/snapshot-ctx.js');
    await buildArchiveServiceCtx(deps.db, deps.k8s, deps.config);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function platformArchiveRetentionDays(db: Database): Promise<number> {
  const { loadStorageLifecycleSettings } = await import('../../storage-lifecycle/settings.js');
  return (await loadStorageLifecycleSettings(db)).retentionPreArchiveDays;
}

type OperationalEvent = Parameters<typeof import('../../notifications/events.js').notifyAdminOperationalEvent>[2];

export function notification(run: TenantAutomationRun): { payload: OperationalEvent; dedupeKey: string } {
  const reached = run.told.filter((t) => t.reached);
  const unreached = run.told.filter((t) => !t.reached);
  const items = [
    ...run.archived.map((t) => `Archived: ${t.name}`),
    ...run.deleted.map((t) => `Deleted: ${t.name}`),
    ...reached.map((t) => `Told ${t.name}: ${t.action} on ${t.date.slice(0, 10)}`),
    ...unreached.map((t) => `Nobody to tell at ${t.name}: not ${t.action}d until it can be told`),
    ...run.failed.map((t) => `Could not ${t.action} ${t.name}: ${t.error}`),
    ...run.errors,
  ];
  const counts = [
    run.archived.length > 0 ? `archived ${run.archived.length}` : '',
    run.deleted.length > 0 ? `deleted ${run.deleted.length}` : '',
    reached.length > 0 ? `told ${reached.length}` : '',
    run.failed.length > 0 ? `failed on ${run.failed.length}` : '',
  ].filter(Boolean);
  const nobody = unreached.length > 0
    ? `${unreached.length} tenant(s) could not be told — no user and no contact address to write to, or notifications are off. They are told again at every run and left as they are until the message reaches somebody.`
    : '';
  const blocked = run.archiveSkippedReason ? `Suspended tenants are due to be archived, but no archive can be taken: ${run.archiveSkippedReason}` : '';
  const acted = counts.length > 0 ? `The automatic sweep ${counts.join(', ')} tenant(s).` : '';
  const stopped = run.errors.length > 0 ? 'A step of the automatic sweep stopped before its end.' : '';
  const problem = run.failed.length > 0 || run.errors.length > 0 || !!run.archiveSkippedReason || unreached.length > 0;
  const changed = run.archived.length + run.deleted.length + reached.length > 0;
  // A sweep that archived, deleted or told somebody is one event, always sent. One
  // that only could not — the same tenant still stuck or still unreachable, the
  // same target still missing — would say so again every six hours; that is
  // said once a day, per set of things it is about.
  const about = [
    ...run.failed.map((t) => `${t.action}:${t.tenantId}`),
    ...unreached.map((t) => `untold-${t.action}:${t.tenantId}`),
    ...run.errors,
    run.archiveSkippedReason ?? '',
  ].sort().join('|');
  return {
    payload: {
      subsystem: 'Tenant lifecycle',
      objectLabel: 'Automatic archive and delete',
      detail: [acted, nobody, stopped, blocked].filter(Boolean).join(' '),
      items,
      severityLabel: problem ? 'needs attention' : 'done',
      recommendedAction: problem
        ? 'Open Platform → Tenant Lifecycle Hooks to see what is due and why it was not done.'
        : 'Nothing to do. The limits are set under Platform → Tenant Lifecycle Hooks.',
    },
    dedupeKey: changed
      ? `tenant-automation:${run.startedAt}`
      : `tenant-automation-problem:${run.startedAt.slice(0, 10)}:${createHash('sha256').update(about).digest('hex').slice(0, 16)}`,
  };
}

/** The tenants a step looks at, with what each was told; tenants kept out are not among them. */
async function inLine(db: Database, step: Step): Promise<InLineTenant[]> {
  const { status, since } = STEP[step];
  const rows = await db
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      since,
      toldAt: tenantAutomationNotices.toldAt,
      date: tenantAutomationNotices.announcedFor,
      reached: tenantAutomationNotices.reached,
    })
    .from(tenants)
    .leftJoin(tenantAutomationNotices, and(eq(tenantAutomationNotices.tenantId, tenants.id), eq(tenantAutomationNotices.step, step)))
    // The SYSTEM tenant can be neither suspended nor archived through the API;
    // the filter is for a row written past it (ADR-040, ci-system-tenant-check).
    .where(and(eq(tenants.status, status), eq(tenants.isSystem, false), eq(tenants.lifecycleAutomationExempt, false)))
    .orderBy(sql`${since} asc nulls last`, asc(tenants.name));
  return rows.map((r) => ({
    tenantId: r.tenantId,
    name: r.name,
    since: r.since,
    notice: r.toldAt && r.date ? { toldAt: r.toldAt, date: r.date, reached: (r.reached ?? 0) > 0 } : null,
  }));
}

/**
 * Tell one tenant what is coming and write down that it was told. Sent first,
 * written second: a notice that could not be written is sent again by the next
 * sweep (the dispatcher drops the repeat by its key), while one written and
 * never sent would let the tenant be archived without a word.
 *
 * A message that reached nobody is written down too — the card shows it — but
 * as such (`reached` 0), and `tenantAutomationPlan` does not count it.
 */
async function tellTenant(db: Database, step: Step, tenant: InLineTenant, date: Date): Promise<TellOutcome> {
  const { status, since } = STEP[step];
  const [row] = await db
    .select({
      status: tenants.status,
      since,
      exempt: tenants.lifecycleAutomationExempt,
      primaryEmail: tenants.primaryEmail,
      secondaryEmail: tenants.secondaryEmail,
    })
    .from(tenants)
    .where(eq(tenants.id, tenant.tenantId));
  if (!row) return { kind: 'skipped', reason: 'the tenant is gone' };
  if (row.exempt) return { kind: 'skipped', reason: 'it is kept out of automatic archive and delete' };
  if (row.status !== status || row.since?.getTime() !== tenant.since?.getTime()) {
    return { kind: 'skipped', reason: `it is no longer ${status} as it was when the sweep began` };
  }
  const { notifyTenantLifecycleNotice } = await import('../../notifications/events.js');
  const day = date.toISOString().slice(0, 10);
  const sent = await notifyTenantLifecycleNotice(
    db,
    tenant.tenantId,
    step,
    { dueDate: day },
    // One per suspension (or archive) and date: the same notice is not sent
    // twice when writing it down failed the first time.
    `tenant-automation-notice:${step}:${tenant.tenantId}:${tenant.since?.getTime() ?? 0}:${day}`,
    // The account's contact addresses: a tenant with no user of its own is
    // reached there, and an archive or delete must not come unannounced
    // because nobody ever signed in.
    [row.primaryEmail, row.secondaryEmail].filter((a): a is string => typeof a === 'string' && a.includes('@')),
  );
  if (!sent.ok) throw new Error(sent.error ?? 'the message could not be sent');
  await db.insert(tenantAutomationNotices)
    .values({ tenantId: tenant.tenantId, step, toldAt: new Date(), announcedFor: date, reached: sent.reached })
    .onConflictDoUpdate({
      target: [tenantAutomationNotices.tenantId, tenantAutomationNotices.step],
      set: { toldAt: new Date(), announcedFor: date, reached: sent.reached },
    });
  return { kind: 'told', reached: sent.reached > 0 };
}

export function realSweepIo(deps: AutomationDeps, timing: { readonly archiveWaitMs?: number; readonly archivePollMs?: number } = {}): SweepIo {
  const { db, k8s } = deps;
  return {
    settings: () => loadTenantAutomationSettings(db),
    archiveRetentionDays: () => platformArchiveRetentionDays(db),
    inLine: (step) => inLine(db, step),
    archiveBlockedReason: () => archiveBlockedReason(deps),
    archive: async (tenant, opts) => {
      const { buildArchiveServiceCtx } = await import('../../storage-lifecycle/snapshot-ctx.js');
      const { archiveTenant } = await import('../../storage-lifecycle/service.js');
      let operationId: string;
      try {
        const ctx = await buildArchiveServiceCtx(db, k8s, deps.config);
        ({ operationId } = await archiveTenant(ctx, tenant.tenantId, {
          retentionDays: opts.retentionDays,
          onlyIfSuspendedBefore: opts.suspendedBefore,
        }));
      } catch (err) {
        return outcomeOfRefusal(err);
      }
      return waitForArchive(db, operationId, timing.archiveWaitMs ?? ARCHIVE_WAIT_MS, timing.archivePollMs ?? ARCHIVE_POLL_MS);
    },
    remove: async (tenant, opts) => {
      const { deleteTenant } = await import('../../tenants/service.js');
      try {
        await deleteTenant(db, tenant.tenantId, k8s, { onlyIfArchivedBefore: opts.archivedBefore });
        return { kind: 'done' };
      } catch (err) {
        return outcomeOfRefusal(err);
      }
    },
    tell: (step, tenant, date) => tellTenant(db, step, tenant, date),
    record: (run) => saveAutomationRun(db, run),
    notify: async (run) => {
      const { notifyAdminOperationalEvent } = await import('../../notifications/events.js');
      const { TENANT_AUTOMATION_RESOURCE } = await import('../../notifications/action-path.js');
      const { payload, dedupeKey } = notification(run);
      await notifyAdminOperationalEvent(db, 'platform', payload, dedupeKey, TENANT_AUTOMATION_RESOURCE);
    },
    now: () => new Date(),
    log: (line) => { console.log(`[tenant-automation] ${line}`); },
  };
}

/**
 * One sweep, with everything real. Its callers take the job's run lock
 * (`runExclusive(db, 'storage-auto-archive', …)`): the schedule's tick, and
 * the admin's "Run now".
 */
export function sweepTenantsOnce(deps: AutomationDeps, trigger: TenantAutomationRun['trigger']): Promise<TenantAutomationRun> {
  return runTenantAutomationSweep(realSweepIo(deps), trigger);
}

async function candidates(db: Database, step: Step): Promise<TenantAutomationCandidate[]> {
  const { status, since } = STEP[step];
  const rows = await db
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      since,
      state: tenants.storageLifecycleState,
      toldAt: tenantAutomationNotices.toldAt,
      date: tenantAutomationNotices.announcedFor,
      reached: tenantAutomationNotices.reached,
    })
    .from(tenants)
    .leftJoin(tenantAutomationNotices, and(eq(tenantAutomationNotices.tenantId, tenants.id), eq(tenantAutomationNotices.step, step)))
    .where(and(eq(tenants.status, status), eq(tenants.isSystem, false), eq(tenants.lifecycleAutomationExempt, false)))
    .orderBy(sql`${since} asc nulls last`, asc(tenants.name))
    .limit(MAX_CANDIDATES);
  return rows.map((r) => ({
    tenantId: r.tenantId,
    name: r.name,
    since: r.since ? r.since.toISOString() : null,
    busy: r.state === 'idle' ? null : r.state,
    // Only a notice of THIS suspension (or archive): one from before the
    // tenant was resumed says nothing about now.
    notice: r.toldAt && r.date && r.since && r.toldAt.getTime() >= r.since.getTime()
      ? { toldAt: r.toldAt.toISOString(), date: r.date.toISOString(), reached: (r.reached ?? 0) > 0 }
      : null,
  }));
}

/** Every tenant kept out of the automation, whatever its status. */
async function keptOut(db: Database): Promise<TenantAutomationKept[]> {
  return db
    .select({ tenantId: tenants.id, name: tenants.name, status: tenants.status })
    .from(tenants)
    .where(and(eq(tenants.lifecycleAutomationExempt, true), eq(tenants.isSystem, false)))
    .orderBy(asc(tenants.name))
    .limit(MAX_CANDIDATES);
}

/**
 * Keep a tenant out of the automation, or put it back. Answers the tenant as
 * it is stored afterwards.
 */
export async function setTenantAutomationExempt(db: Database, tenantId: string, exempt: boolean): Promise<TenantAutomationKept & { readonly exempt: boolean }> {
  const [row] = await db
    .update(tenants)
    .set({ lifecycleAutomationExempt: exempt })
    .where(and(eq(tenants.id, tenantId), eq(tenants.isSystem, false)))
    .returning({ tenantId: tenants.id, name: tenants.name, status: tenants.status, exempt: tenants.lifecycleAutomationExempt });
  if (!row) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
  return row;
}

export async function getTenantAutomationStatus(deps: AutomationDeps): Promise<TenantAutomationStatus> {
  const { db } = deps;
  const [settings, record, running, blocked, archiveRetentionDays, suspended, archived, kept] = await Promise.all([
    loadTenantAutomationSettings(db),
    loadAutomationRunRecord(db),
    isRunUnderWay(db, TENANT_AUTOMATION_JOB),
    archiveBlockedReason(deps),
    platformArchiveRetentionDays(db),
    candidates(db, 'archive'),
    candidates(db, 'delete'),
    keptOut(db),
  ]);
  // The schedule's sweep comes one interval after its last — unless the
  // process that ran it has restarted since, and then sooner. A time already
  // past says nothing; the panel then shows the interval instead.
  const next = record.lastScheduledAt ? Date.parse(record.lastScheduledAt) + TENANT_AUTOMATION_INTERVAL_MS : null;
  return {
    settings,
    intervalHours: TENANT_AUTOMATION_INTERVAL_MS / 3_600_000,
    running,
    lastRun: record.lastRun,
    nextRunAt: next !== null && next > Date.now() ? new Date(next).toISOString() : null,
    archiveBlockedReason: blocked,
    archiveRetentionDays,
    suspended,
    archived,
    kept,
  };
}
