/**
 * Makes `backup_schedules` rows real for the DR artefacts.
 *
 * Before this, three of the rows the admin UI can edit drove nothing at all:
 * `system_pitr` and `longhorn_recurring` had no executor whatsoever (both sat
 * `enabled=false`, `last_fired_at` NULL, while the real work ran from a CNPG
 * ScheduledBackup and a Longhorn RecurringJob), and the etcd/secrets/cluster
 * artefacts had no row to edit in the first place.
 *
 * Each target is converged according to how it is actually owned — see
 * `targets.ts`. The two rules that matter:
 *
 *   * A Flux-owned `spec.schedule` is never patched. Flux reconciles every
 *     minute on production and would revert it; instead the CronJob is
 *     suspended and the platform fires the Jobs (see `firing.ts`).
 *   * `enabled=false` always suspends, whatever the mechanism. A schedule an
 *     operator switched off must stop producing work even if the cadence is
 *     otherwise manifest-driven.
 */

import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';

import { backupSchedules } from '../../../db/schema.js';
import type { Database } from '../../../db/index.js';
import { JSON_PATCH } from '../../../shared/k8s-patch.js';
import { CADENCE_TARGETS, toCnpgCron, type CadenceTarget } from './targets.js';
import { systemClassBound } from '../../backup-rclone-shim/dr-cronjobs.js';

export interface CadenceClients {
  readonly batch: {
    readNamespacedCronJob: (args: { name: string; namespace: string }) => Promise<unknown>;
    patchNamespacedCronJob: (args: { name: string; namespace: string; body: object }, opts?: unknown) => Promise<unknown>;
  };
  /** CustomObjects client, used for the CNPG ScheduledBackup. */
  readonly custom: {
    getNamespacedCustomObject: (args: {
      group: string; version: string; namespace: string; plural: string; name: string;
    }) => Promise<unknown>;
    patchNamespacedCustomObject: (args: {
      group: string; version: string; namespace: string; plural: string; name: string; body: unknown;
    }, opts?: unknown) => Promise<unknown>;
  };
}

/** What the reconciler decided for one target, for logs, tests and the API. */
export interface CadenceOutcome {
  readonly subsystem: string;
  readonly state:
    | 'STATE_OK'
    | 'STATE_NOT_INSTALLED'
    | 'STATE_READ_ONLY'
    | 'STATE_NO_ROW'
    | 'STATE_INVALID_CRON'
    | 'STATE_ERROR';
  /** True when the platform fires the Jobs because the operator left the default. */
  readonly platformFired: boolean;
  readonly desiredCron: string | null;
  readonly desiredSuspend: boolean;
  readonly patched: boolean;
  readonly errorMessage: string;
}

interface ScheduleRow {
  readonly enabled: boolean;
  readonly cronExpression: string | null;
}

async function readRow(db: Database, subsystem: string): Promise<ScheduleRow | null> {
  const [row] = await db
    .select({ enabled: backupSchedules.enabled, cronExpression: backupSchedules.cronExpression })
    .from(backupSchedules)
    .where(eq(backupSchedules.subsystem, subsystem));
  return row ?? null;
}

function statusCodeOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number; code?: number; response?: { statusCode?: number } };
  return e?.statusCode ?? e?.code ?? e?.response?.statusCode;
}

/**
 * Converge one target. Never throws: a single broken target must not stop the
 * others from being reconciled, and the caller logs the outcome.
 */
export async function reconcileCadenceTarget(
  db: Database,
  clients: CadenceClients,
  target: CadenceTarget,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<CadenceOutcome> {
  const base = { subsystem: target.subsystem, platformFired: false, patched: false, errorMessage: '' };

  const row = await readRow(db, target.subsystem);
  if (!row) {
    // Not an error: a cluster whose migrations have not reached 0129 yet, or a
    // subsystem deliberately left unseeded.
    return { ...base, state: 'STATE_NO_ROW', desiredCron: null, desiredSuspend: false };
  }

  const desiredCron = (row.cronExpression ?? target.manifestDefault).trim();

  if (target.mechanism === 'read-only') {
    // Nothing to converge. The card renders the manifest value and says so.
    return { ...base, state: 'STATE_READ_ONLY', desiredCron, desiredSuspend: !row.enabled };
  }

  if (target.mechanism === 'cnpg-backup') {
    const cnpgCron = toCnpgCron(desiredCron);
    if (!cnpgCron) {
      log.warn({ subsystem: target.subsystem, desiredCron }, 'cadence: refusing to write a malformed cron to CNPG');
      return {
        ...base,
        state: 'STATE_INVALID_CRON',
        desiredCron,
        desiredSuspend: !row.enabled,
        errorMessage: `"${desiredCron}" is not a 5- or 6-field cron expression`,
      };
    }
    return reconcileCnpg(clients, target, cnpgCron, !row.enabled, log);
  }

  // ─── CronJob-backed targets ─────────────────────────────────────────
  //
  // `cronjob-owned`: the schedule is ours to patch outright.
  // `cronjob-flux` : Flux owns the schedule. Matching the manifest default
  //                  means the CronJob fires itself; anything else means we
  //                  suspend it and fire the Jobs ourselves.
  const fluxOwnsSchedule = target.mechanism === 'cronjob-flux';
  // The same gate the dr-cronjobs bridge uses. These jobs upload through the
  // shim, so with no SYSTEM target bound they can only fail; the bridge has
  // always suspended them for that reason. Gating on the identical predicate
  // is what stops the two from flipping the field against each other — see
  // the ownership note in dr-cronjobs.ts.
  const bound = await systemClassBound(db);
  /** The schedule is meant to produce work at all. */
  const active = bound && row.enabled;
  /** The operator moved this job off the cadence its manifest compiles in. */
  const cadenceDiffers = fluxOwnsSchedule && desiredCron !== target.manifestDefault;

  // `platformFired` means "the platform is responsible for creating this job's
  // Jobs", so it MUST include `active`. An earlier version defined it purely as
  // cadence-differs, which meant disabling a schedule that had been moved off
  // its default suspended the CronJob (correct) while the firing engine kept
  // creating Jobs on the operator's old cron (not correct at all) — the switch
  // looked like it worked and stopped nothing.
  const platformFired = cadenceDiffers && active;
  // Suspend whenever the job must not fire ITSELF: switched off, nowhere to
  // upload, or held back because the platform fires it instead.
  const desiredSuspend = !active || cadenceDiffers;

  let live: { spec?: { schedule?: string; suspend?: boolean } };
  try {
    live = (await clients.batch.readNamespacedCronJob({
      name: target.name,
      namespace: target.namespace,
    })) as { spec?: { schedule?: string; suspend?: boolean } };
  } catch (err) {
    if (statusCodeOf(err) === 404) {
      log.warn({ cronjob: target.name }, 'cadence: CronJob not installed yet; skipping');
      return { ...base, state: 'STATE_NOT_INSTALLED', desiredCron, desiredSuspend, platformFired };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, cronjob: target.name }, 'cadence: CronJob read failed');
    return { ...base, state: 'STATE_ERROR', desiredCron, desiredSuspend, platformFired, errorMessage: msg };
  }

  const ops: Array<{ op: 'replace'; path: string; value: unknown }> = [];
  // Default to `true`: a missing suspend field must never read as "running".
  if ((live.spec?.suspend ?? true) !== desiredSuspend) {
    ops.push({ op: 'replace', path: '/spec/suspend', value: desiredSuspend });
  }
  if (!fluxOwnsSchedule && (live.spec?.schedule ?? '') !== desiredCron) {
    ops.push({ op: 'replace', path: '/spec/schedule', value: desiredCron });
  }

  if (ops.length === 0) {
    return { ...base, state: 'STATE_OK', desiredCron, desiredSuspend, platformFired };
  }

  try {
    await clients.batch.patchNamespacedCronJob(
      { name: target.name, namespace: target.namespace, body: ops as unknown as object },
      JSON_PATCH,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, cronjob: target.name }, 'cadence: CronJob patch failed');
    return { ...base, state: 'STATE_ERROR', desiredCron, desiredSuspend, platformFired, errorMessage: msg };
  }

  log.info(
    { cronjob: target.name, schedule: desiredCron, suspend: desiredSuspend, platformFired },
    'cadence: CronJob converged',
  );
  return { ...base, state: 'STATE_OK', desiredCron, desiredSuspend, platformFired, patched: true };
}

async function reconcileCnpg(
  clients: CadenceClients,
  target: CadenceTarget,
  cnpgCron: string,
  desiredSuspend: boolean,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<CadenceOutcome> {
  const ref = {
    group: 'postgresql.cnpg.io',
    version: 'v1',
    namespace: target.namespace,
    plural: 'scheduledbackups',
    name: target.name,
  };
  const base = { subsystem: target.subsystem, platformFired: false, patched: false, errorMessage: '' };

  let live: { spec?: { schedule?: string; suspend?: boolean } };
  try {
    live = (await clients.custom.getNamespacedCustomObject(ref)) as { spec?: { schedule?: string; suspend?: boolean } };
  } catch (err) {
    if (statusCodeOf(err) === 404) {
      log.warn({ name: target.name }, 'cadence: ScheduledBackup not installed yet; skipping');
      return { ...base, state: 'STATE_NOT_INSTALLED', desiredCron: cnpgCron, desiredSuspend };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, name: target.name }, 'cadence: ScheduledBackup read failed');
    return { ...base, state: 'STATE_ERROR', desiredCron: cnpgCron, desiredSuspend, errorMessage: msg };
  }

  // CNPG's ScheduledBackup omits `suspend` entirely when it has never been
  // set, and an absent suspend means NOT suspended.
  const liveSuspend = live.spec?.suspend ?? false;
  if ((live.spec?.schedule ?? '') === cnpgCron && liveSuspend === desiredSuspend) {
    return { ...base, state: 'STATE_OK', desiredCron: cnpgCron, desiredSuspend };
  }

  try {
    // Merge-patch, not JSON-patch: `/spec/suspend` may be absent, and a JSON
    // `replace` on an absent path is a 422.
    await clients.custom.patchNamespacedCustomObject(
      { ...ref, body: { spec: { schedule: cnpgCron, suspend: desiredSuspend } } },
      { headers: { 'Content-Type': 'application/merge-patch+json' } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, name: target.name }, 'cadence: ScheduledBackup patch failed');
    return { ...base, state: 'STATE_ERROR', desiredCron: cnpgCron, desiredSuspend, errorMessage: msg };
  }

  log.info({ name: target.name, schedule: cnpgCron, suspend: desiredSuspend }, 'cadence: ScheduledBackup converged');
  return { ...base, state: 'STATE_OK', desiredCron: cnpgCron, desiredSuspend, patched: true };
}

/**
 * What the firing engine needs, computed fresh from the database.
 *
 * Deliberately NOT taken from the last reconcile's cached outcome: that cache
 * is per-process, so in HA mode every other replica would keep firing on a cron
 * the operator changed — or one they disabled — until its own 5-minute tick
 * caught up. Five rows is a cheap query; a wrong backup is not.
 */
export async function resolveFiringPlan(
  db: Database,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<ReadonlyArray<{ target: CadenceTarget; cron: string }>> {
  const plan: Array<{ target: CadenceTarget; cron: string }> = [];
  const bound = await systemClassBound(db);
  if (!bound) return plan;
  for (const target of CADENCE_TARGETS) {
    if (target.mechanism !== 'cronjob-flux') continue;
    const row = await readRow(db, target.subsystem);
    if (!row || !row.enabled) continue;
    const cron = (row.cronExpression ?? target.manifestDefault).trim();
    // Equal to the manifest default means the CronJob fires itself; firing
    // here as well would double it.
    if (cron === target.manifestDefault) continue;
    plan.push({ target, cron });
  }
  if (plan.length > 0) {
    log.info({ subsystems: plan.map((p) => p.target.subsystem) }, 'cadence: platform-fired schedules');
  }
  return plan;
}

/** Converge every target. Independent: one failure never blocks the rest. */
export async function reconcileAllCadence(
  db: Database,
  clients: CadenceClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<readonly CadenceOutcome[]> {
  const out: CadenceOutcome[] = [];
  for (const target of CADENCE_TARGETS) {
    try {
      out.push(await reconcileCadenceTarget(db, clients, target, log));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg, subsystem: target.subsystem }, 'cadence: target threw');
      out.push({
        subsystem: target.subsystem,
        state: 'STATE_ERROR',
        platformFired: false,
        desiredCron: null,
        desiredSuspend: false,
        patched: false,
        errorMessage: msg,
      });
    }
  }
  return out;
}
