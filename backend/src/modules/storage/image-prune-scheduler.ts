/**
 * Daily image prune — scheduled counterpart of the manual "Purge Cache"
 * button (POST /admin/storage/purge) and the reactive pressure watcher.
 *
 * Why (2026-06-05 audit): kubelet image GC only acts at 85% disk and the
 * pressure watcher at 75% of ephemeral storage — below those thresholds
 * unused images accumulate indefinitely (22 GB on testing, 15 GB on
 * staging1, mostly per-push timestamped tags). A daily sweep keeps the
 * cache at the working set without waiting for pressure.
 *
 * Reuses purgeUnusedImages() wholesale: in-use and protected images are
 * never touched; per-node privileged pods run `crictl rmi`; results are
 * logged. The three layers are complementary:
 *   - daily prune (this)        — steady-state hygiene
 *   - pressure watcher (60s)    — reactive, >75% ephemeral or DiskPressure
 *   - kubelet image GC          — last-resort at 85% disk
 */
import type { FastifyBaseLogger } from 'fastify';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { purgeUnusedImages } from './service.js';

const TICK_MS = 24 * 60 * 60 * 1000;      // daily
const INITIAL_DELAY_MS = 30 * 60 * 1000;  // past startup + first inventory

export interface ImagePruneDeps {
  readonly purge: () => Promise<{ removedImages: ReadonlyArray<string>; freedBytes: number; errors: ReadonlyArray<string> }>;
}

export interface ImagePruneResult {
  readonly removedCount: number;
  readonly freedBytes: number;
  readonly errorCount: number;
}

/** One prune pass over the injected seam — unit-testable off k8s. */
export async function runDailyImagePrune(deps: ImagePruneDeps): Promise<ImagePruneResult> {
  const r = await deps.purge();
  return {
    removedCount: r.removedImages.length,
    freedBytes: r.freedBytes,
    errorCount: r.errors.length,
  };
}

export function startDailyImagePrune(
  k8s: K8sClients,
  log: FastifyBaseLogger,
): { readonly stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let ticking = false; // a purge fans out per-node pods — never overlap ticks
  log.info('[image-prune] starting (daily unused-image sweep)');

  const tick = async () => {
    if (stopped) return;
    if (!ticking) {
      ticking = true;
      try {
        const r = await runDailyImagePrune({ purge: () => purgeUnusedImages(k8s, false) });
        if (r.removedCount > 0 || r.errorCount > 0) {
          log.info(`[image-prune] removed ${r.removedCount} image(s), freed ${(r.freedBytes / 1e9).toFixed(2)} GB, ${r.errorCount} error(s)`);
        }
      } catch (err) {
        log.warn({ err }, '[image-prune] daily sweep failed');
      } finally {
        ticking = false;
      }
    }
    if (!stopped) timer = setTimeout(tick, TICK_MS);
  };

  timer = setTimeout(tick, INITIAL_DELAY_MS);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
