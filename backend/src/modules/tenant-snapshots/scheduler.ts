/**
 * Tenant volume-snapshot reaper. Snapshots are short-term (hours) PVC recovery
 * points; this sweep deletes any past their `expires_at` (the admin-set
 * `snapshot_expiry_hours`). 30-min granularity is ample for an hours-scale TTL.
 * Mirrors the storage-lifecycle scheduler shape.
 */

import type { Database } from '../../db/index.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { reapExpiredSnapshots } from './service.js';

const TICK_MS = 30 * 60 * 1000; // 30 min
const INITIAL_DELAY_MS = 3 * 60 * 1000; // avoid a boot thundering-herd

export function startTenantSnapshotReaper(db: Database, kubeconfigPath?: string): { stop: () => void } {
  // eslint-disable-next-line no-console
  console.log('[tenant-snapshot-reaper] starting');
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const k8s = createK8sClients(kubeconfigPath);
      const n = await reapExpiredSnapshots({ db, k8s });
      if (n > 0) {
        // eslint-disable-next-line no-console
        console.log(`[tenant-snapshot-reaper] reaped ${n} expired snapshot(s)`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[tenant-snapshot-reaper] tick failed:', err);
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
