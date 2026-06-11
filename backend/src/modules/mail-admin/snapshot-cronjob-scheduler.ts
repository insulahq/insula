/**
 * stalwart-snapshot CronJob reconciler scheduler.
 *
 * Same shape as backup-rclone-shim/etcd-cronjob-scheduler.ts: a 5-minute
 * tick + setImmediate cold-start kick. The cold-start kick is load-bearing
 * on a FRESH bootstrap — it claims SSA ownership of spec.schedule early so
 * the `platform` Kustomization reaches Ready with a valid live value.
 *
 * Drift-check fast path (2026-06-10): spec.schedule cannot be protected
 * from Flux — it is required-on-create (cannot be stripped from the
 * apply) and no valid `kustomize.toolkit.fluxcd.io/ssa` policy
 * preserves a manifest-present field — so EVERY Flux reconcile reverts
 * the operator-set schedule to the manifest default. With only the
 * 5-minute full tick that meant a revert window of up to 5 min per
 * Flux pass (~half the wall-clock at Flux's default interval): an
 * operator's daily-backup cadence ran at the manifest's 30-minute
 * default for long stretches. The fast path is a single CronJob GET every 30s comparing
 * the live schedule/suspend against the last reconciled desired state —
 * on drift it fires the full reconcile immediately, shrinking the
 * revert window to ≤~30s while adding only 2 trivial reads/min to the
 * apiserver. The 5-minute full tick remains the authority (it
 * recomputes desired state from the DB; the fast path only compares
 * against its cached result and never writes on its own).
 */

import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import { eq, and, or, isNull, lt, sql } from 'drizzle-orm';
import { backupSchedules } from '../../db/schema.js';
import { cronMatchesMinute, minuteStamp } from '../../shared/cron-match.js';
import {
  reconcileMailSnapshotCronJob,
  resolveDesiredSchedule,
  DEFAULT_MAIL_SNAPSHOT_SCHEDULE,
  MAIL_SNAPSHOT_CRONJOB_NAMESPACE,
  MAIL_SNAPSHOT_CRONJOB_NAME,
  type MailSnapshotCronJobClients,
} from './snapshot-cronjob-reconciler.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DRIFT_CHECK_MS = 30 * 1000;
/**
 * R17.1 firing engine cadence + catch-up window. Mirrors the
 * tenant-bundle global scheduler's convention (±window matching with a
 * persisted backup_schedules.last_fired_at dedup): every tick we look
 * for the most recent minute inside the window that the operator cron
 * matches and fire ONCE for it. A pod restart inside the window
 * catches up at most one fire; longer outages skip (same semantics as
 * k8s cron with startingDeadlineSeconds unset).
 */
const DEFAULT_FIRE_CHECK_MS = 30 * 1000;
const FIRE_WINDOW_MS = 5 * 60 * 1000;

export interface MailSnapshotCronJobSchedulerHandle {
  readonly stop: () => void;
}

export function startMailSnapshotCronJobReconciler(
  db: Database,
  clients: MailSnapshotCronJobClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: {
    intervalMs?: number;
    driftCheckMs?: number;
    fireCheckMs?: number;
    /** Passed through to triggerMailSnapshot for the platform-fired path. */
    kubeconfigPath?: string;
    /** Test injection — defaults to the real triggerMailSnapshot. */
    fireFn?: (jobName: string) => Promise<void>;
  } = {},
): MailSnapshotCronJobSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const driftCheckMs = opts.driftCheckMs ?? DEFAULT_DRIFT_CHECK_MS;
  const fireCheckMs = opts.fireCheckMs ?? DEFAULT_FIRE_CHECK_MS;
  let cancelled = false;
  // Desired state as of the last successful full reconcile. null until
  // the first tick lands (the fast path no-ops until then so it can
  // never act on stale assumptions).
  let lastDesired: { schedule: string; suspended: boolean; platformFired: boolean; bound: boolean } | null = null;
  let ticking = false;
  let firing = false;

  const tick = async (): Promise<void> => {
    if (cancelled || ticking) return;
    ticking = true;
    try {
      const result = await reconcileMailSnapshotCronJob(db, clients, log);
      if (result.state === 'STATE_OK' || result.state === 'STATE_NO_MAIL_TARGET') {
        lastDesired = {
          schedule: result.schedule,
          suspended: result.suspended,
          platformFired: result.platformFired === true,
          bound: result.state === 'STATE_OK',
        };
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'mail-snapshot-cronjob-scheduler: tick threw',
      );
    } finally {
      ticking = false;
    }
  };

  const driftCheck = async (): Promise<void> => {
    if (cancelled || ticking || !lastDesired) return;
    try {
      const live = (await clients.batch.readNamespacedCronJob({
        namespace: MAIL_SNAPSHOT_CRONJOB_NAMESPACE,
        name: MAIL_SNAPSHOT_CRONJOB_NAME,
      } as unknown as Parameters<typeof clients.batch.readNamespacedCronJob>[0])) as {
        spec?: { schedule?: string; suspend?: boolean };
      };
      const liveSchedule = live.spec?.schedule ?? '';
      const liveSuspend = live.spec?.suspend === true;
      // Schedule comparison reads the DB-authoritative desired value,
      // NOT the cached lastDesired. The cache has a lost-update
      // blindspot (caught live on testing 2026-06-11): a full tick that
      // started BEFORE an operator PATCH can SSA-apply the stale
      // schedule AFTER the route's apply — live and cache then AGREE on
      // the stale value, no drift is seen, and the operator's setting
      // stays reverted until the next 5-minute tick. One tiny indexed
      // read per 30s closes the window: the DB is where the route's
      // write landed first, so the mismatch is always visible here.
      // Suspend keeps the cached comparison — its desired value depends
      // on backup-target binding state, which only the full tick
      // computes.
      const desiredSchedule = await resolveDesiredSchedule(db);
      // Schedule comparison only applies in NATIVE mode (R17.1): in
      // platform-fired mode the live spec.schedule is the manifest
      // default by design and the DB cron drives the firing engine —
      // comparing them would re-trigger the full tick forever. Mode
      // changes (operator flips between default and custom cadence)
      // are recomputed directly from the DB value, and the operator's
      // CRON value itself changing in platform mode must refresh the
      // firing engine's cached schedule too.
      const desiredPlatformFired = desiredSchedule !== DEFAULT_MAIL_SNAPSHOT_SCHEDULE;
      const scheduleDrift = desiredPlatformFired
        ? desiredSchedule !== lastDesired.schedule        // firing-engine cadence stale
        : liveSchedule !== desiredSchedule;               // Flux/stale-tick revert
      const modeDrift = desiredPlatformFired !== lastDesired.platformFired;
      if (scheduleDrift || modeDrift || liveSuspend !== lastDesired.suspended) {
        log.info(
          {
            liveSchedule,
            desiredSchedule,
            liveSuspend,
            desiredSuspend: lastDesired.suspended,
          },
          'mail-snapshot-cronjob-scheduler: drift detected (Flux revert or stale-tick overwrite) — re-asserting',
        );
        await tick();
      }
    } catch {
      // Read failures (CronJob absent on a fresh install, transient
      // apiserver blip) are the full tick's problem — stay silent.
    }
  };

  /**
   * R17.1 firing engine — only active in platform-fired mode (operator
   * cadence ≠ manifest default; the CronJob is force-suspended). Finds
   * the most recent minute in the catch-up window matching the operator
   * cron and fires exactly once for it. Dedup is two-layered:
   *   1. backup_schedules.last_fired_at, advanced with a conditional
   *      UPDATE (WHERE last_fired_at IS NULL OR < fire-minute) so two
   *      platform-api replicas cannot both claim the same fire;
   *   2. the deterministic Job name (stalwart-snapshot-cron-<minute>)
   *      with tolerateExisting — even a raced claim collides on the
   *      name and reads as success.
   */
  const fireCheck = async (): Promise<void> => {
    if (cancelled || firing) return;
    if (!lastDesired?.platformFired || !lastDesired.bound) return;
    firing = true;
    try {
      const now = new Date();
      // Most recent matching minute within the window.
      let fireAt: Date | null = null;
      for (let back = 0; back * 60_000 <= FIRE_WINDOW_MS; back++) {
        const cand = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - back * 60_000);
        if (cronMatchesMinute(lastDesired.schedule, cand)) { fireAt = cand; break; }
      }
      if (!fireAt) return;

      // Claim the fire (replica-safe conditional update).
      const claimed = await db
        .update(backupSchedules)
        .set({ lastFiredAt: fireAt })
        .where(and(
          eq(backupSchedules.subsystem, 'mail'),
          or(isNull(backupSchedules.lastFiredAt), lt(backupSchedules.lastFiredAt, fireAt)),
        ))
        .returning({ subsystem: backupSchedules.subsystem });
      if (claimed.length === 0) return; // already fired for this minute

      const jobName = `stalwart-snapshot-cron-${minuteStamp(fireAt)}`;
      const fire = opts.fireFn ?? (async (name: string) => {
        const { triggerMailSnapshot } = await import('./snapshot.js');
        await triggerMailSnapshot({
          db,
          kubeconfigPath: opts.kubeconfigPath,
          jobName: name,
          tolerateExisting: true,
        });
      });
      await fire(jobName);
      log.info(
        { jobName, schedule: lastDesired.schedule, fireAt: fireAt.toISOString() },
        'mail-snapshot-cronjob-scheduler: platform-fired snapshot Job created',
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'mail-snapshot-cronjob-scheduler: platform fire failed (next matching minute retries)',
      );
      // Roll the claim back so the next tick can retry this minute.
      // Best-effort: a lost rollback only delays to the next matching
      // minute — never double-fires (Job name dedup holds regardless).
      try {
        await db
          .update(backupSchedules)
          .set({ lastFiredAt: sql`NULL` })
          .where(eq(backupSchedules.subsystem, 'mail'));
      } catch { /* covered by the name-collision layer */ }
    } finally {
      firing = false;
    }
  };

  setImmediate(tick);
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const driftTimer = setInterval(() => void driftCheck(), driftCheckMs);
  driftTimer.unref();
  const fireTimer = setInterval(() => void fireCheck(), fireCheckMs);
  fireTimer.unref();

  log.info({ intervalMs, driftCheckMs }, 'mail-snapshot-cronjob-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(driftTimer);
      clearInterval(fireTimer);
    },
  };
}
