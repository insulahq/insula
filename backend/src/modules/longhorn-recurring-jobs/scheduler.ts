/**
 * Longhorn recurring-job convergence tick.
 *
 * 15 minutes, because neither half is urgent: the group label only matters
 * before the next top-of-hour snapshot, and the sweep is deliberately paced so
 * a few volumes' snapshot chains coalesce per tick instead of all of them at
 * once. A cluster with nothing to do costs three LIST calls per tick.
 *
 * Safe to run on every replica: labelling writes the same label, and a snapshot
 * a peer already deleted comes back 404, which `deleteSnapshot` treats as done.
 */

import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileLonghornRecurringJobs, type Logger } from './service.js';

const TICK_MS = 15 * 60 * 1000;
/** Let the cluster settle before the first write; also de-synchronises replicas. */
const INITIAL_DELAY_MS = 4 * 60 * 1000;

export interface PendingCounts {
  readonly detached: number;
  readonly headParent: number;
}

/**
 * What to say about snapshots still waiting to be purged, given what was said
 * last tick.
 *
 * Pure, because the interesting part is WHEN it stays quiet. Neither count is
 * an error or something to retry, and a volume that stays detached holds the
 * same snapshots at the same count for as long as it is down — so repeating
 * that four times an hour is noise. Said on change only, including the change
 * back to nothing, which is the operator's "it finished" signal.
 */
export function pendingMessages(
  last: PendingCounts | null,
  current: PendingCounts,
): Array<{ obj: Record<string, unknown>; msg: string }> {
  const changed = last === null
    || last.detached !== current.detached
    || last.headParent !== current.headParent;
  if (!changed) return [];

  const out: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  if (current.detached > 0) {
    out.push({
      obj: { snapshots: current.detached },
      msg: 'longhorn-recurring-jobs: snapshots marked for deletion are waiting for their volume to attach before Longhorn can purge them',
    });
  }
  if (current.headParent > 0) {
    out.push({
      obj: { snapshots: current.headParent },
      msg: "longhorn-recurring-jobs: snapshots marked for deletion are the live head's parent, which Longhorn cannot fold; they clear on the volume's next snapshot, and the nightly filesystem trim reclaims their freed blocks meanwhile",
    });
  }
  // Only worth saying if something WAS outstanding; on a clean cluster the
  // first tick should not announce the absence of a problem.
  if (out.length === 0 && last !== null) {
    out.push({ obj: {}, msg: 'longhorn-recurring-jobs: no snapshots left waiting to be purged' });
  }
  return out;
}

export function startLonghornRecurringJobReconciler(
  log: Logger,
  kubeconfigPath?: string,
): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  /** Last reported pending counts, so an unchanging one is said once. */
  let lastPending: PendingCounts | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const k8s = createK8sClients(kubeconfigPath);
      const r = await reconcileLonghornRecurringJobs({ k8s, log });

      const pending = { detached: r.pendingDetached, headParent: r.pendingHeadParent };
      for (const m of pendingMessages(lastPending, pending)) log.info(m.obj, m.msg);
      lastPending = pending;

      if (r.deletedSnapshots > 0 || r.labelled.length > 0) {
        const outstanding = r.deferredVolumes > 0 || r.pendingPurge > 0;
        log.info(
          {
            labelled: r.labelled.length,
            deletedSnapshots: r.deletedSnapshots,
            purgedVolumes: r.purgedVolumes.length,
            deferredVolumes: r.deferredVolumes,
            pendingPurge: r.pendingPurge,
            pendingDetached: r.pendingDetached,
            pendingHeadParent: r.pendingHeadParent,
          },
          // "converged" is a claim about the cluster, so it is only made when
          // nothing is deferred and nothing is still waiting to be purged.
          outstanding
            ? 'longhorn-recurring-jobs: tick applied, work still outstanding'
            : 'longhorn-recurring-jobs: tick converged',
        );
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'longhorn-recurring-jobs: tick failed');
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
