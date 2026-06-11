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
import {
  reconcileMailSnapshotCronJob,
  resolveDesiredSchedule,
  MAIL_SNAPSHOT_CRONJOB_NAMESPACE,
  MAIL_SNAPSHOT_CRONJOB_NAME,
  type MailSnapshotCronJobClients,
} from './snapshot-cronjob-reconciler.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_DRIFT_CHECK_MS = 30 * 1000;

export interface MailSnapshotCronJobSchedulerHandle {
  readonly stop: () => void;
}

export function startMailSnapshotCronJobReconciler(
  db: Database,
  clients: MailSnapshotCronJobClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  opts: { intervalMs?: number; driftCheckMs?: number } = {},
): MailSnapshotCronJobSchedulerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const driftCheckMs = opts.driftCheckMs ?? DEFAULT_DRIFT_CHECK_MS;
  let cancelled = false;
  // Desired state as of the last successful full reconcile. null until
  // the first tick lands (the fast path no-ops until then so it can
  // never act on stale assumptions).
  let lastDesired: { schedule: string; suspended: boolean } | null = null;
  let ticking = false;

  const tick = async (): Promise<void> => {
    if (cancelled || ticking) return;
    ticking = true;
    try {
      const result = await reconcileMailSnapshotCronJob(db, clients, log);
      if (result.state === 'STATE_OK' || result.state === 'STATE_NO_MAIL_TARGET') {
        lastDesired = { schedule: result.schedule, suspended: result.suspended };
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
      if (liveSchedule !== desiredSchedule || liveSuspend !== lastDesired.suspended) {
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

  setImmediate(tick);
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  const driftTimer = setInterval(() => void driftCheck(), driftCheckMs);
  driftTimer.unref();

  log.info({ intervalMs, driftCheckMs }, 'mail-snapshot-cronjob-scheduler: started');

  return {
    stop: () => {
      cancelled = true;
      clearInterval(timer);
      clearInterval(driftTimer);
    },
  };
}
