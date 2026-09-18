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

export function startLonghornRecurringJobReconciler(
  log: Logger,
  kubeconfigPath?: string,
): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const k8s = createK8sClients(kubeconfigPath);
      const r = await reconcileLonghornRecurringJobs({ k8s, log });
      if (r.deletedSnapshots > 0 || r.labelled.length > 0) {
        log.info(
          {
            labelled: r.labelled.length,
            deletedSnapshots: r.deletedSnapshots,
            purgedVolumes: r.purgedVolumes.length,
            deferredVolumes: r.deferredVolumes,
          },
          'longhorn-recurring-jobs: tick converged',
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
