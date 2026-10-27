/**
 * The timer that removes idle source shims (service.ts#sweepIdleSourceShims).
 * One replica sweeps: two removing the same shim would only race on 404s, but
 * the lease keeps the log to one line per shim.
 */
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { sweepIdleSourceShims } from './service.js';

const INTERVAL_MS = 5 * 60 * 1000;

export function startSourceShimSweeper(
  db: Database,
  k8s: K8sClients,
  log: Pick<Logger, 'info' | 'warn'>,
): { readonly stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      await withSchedulerLease(db, 'backup-source-shim-sweep', INTERVAL_MS * 1.5,
        () => sweepIdleSourceShims(k8s, log), { log });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'backup-source-shim-sweep: tick threw');
    }
  };
  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
