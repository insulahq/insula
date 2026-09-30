/**
 * 15-minute sweep of Traefik's orphaned response-buffer spool.
 *
 * Pattern mirrors backup-restore/cleanup-drafts-scheduler.ts. Wiring lives in
 * app.ts next to the other periodic sweeps.
 *
 * The tick also publishes `platform_ingress_spool_bytes`, so the leak is
 * VISIBLE rather than only swept. A reaper with no gauge hides its own subject:
 * if the spool starts growing faster than the sweep clears it, a 15-minute
 * cleanup would keep the disk from filling while telling nobody that something
 * upstream regressed — most likely a route that lost its GET carve-out.
 */
import { ingressSpoolBytes } from '../../shared/metrics.js';
import { reapIngressSpool, type SpoolReaperDeps, type SpoolReapResult } from './reaper.js';

/** Default tick interval — 15 minutes, matching the other cleanup sweeps. */
export const SPOOL_REAPER_TICK_MS = 15 * 60 * 1000;

/**
 * Log loudly above this. A single orphan is routine (someone closed a tab);
 * a quarter-gig sitting in Traefik's emptyDir is a disk problem in progress.
 */
export const SPOOL_WARN_BYTES = 256 * 1024 * 1024;

export interface SpoolReaperSchedulerDeps extends Omit<SpoolReaperDeps, 'logger'> {
  readonly tickMs?: number;
  readonly logger?: SpoolSchedulerLogger;
}

export interface SpoolSchedulerLogger {
  readonly info: (msg: string, ctx?: object) => void;
  readonly warn: (msg: string, err?: unknown) => void;
}

/** Start the scheduler; returns a stop callback. */
export function startIngressSpoolReaper(deps: SpoolReaperSchedulerDeps): () => void {
  const tickMs = deps.tickMs ?? SPOOL_REAPER_TICK_MS;
  const log: SpoolSchedulerLogger = deps.logger ?? {
    // eslint-disable-next-line no-console
    info: (msg, ctx) => console.log(`[spool-reaper] ${msg}`, ctx ?? ''),
    // eslint-disable-next-line no-console
    warn: (msg, err) => console.warn(`[spool-reaper] ${msg}`, err ?? ''),
  };

  const runTick = async (): Promise<SpoolReapResult> => {
    const result = await reapIngressSpool({ ...deps, logger: log });
    // Publish even when zero — a measured zero is the all-clear and must be
    // distinguishable from "the reaper never ran", which is an absent series.
    if (result.podsScanned > 0) {
      ingressSpoolBytes.set(result.remainingBytes);
    }
    if (result.deleted > 0) {
      const line = {
        deleted: result.deleted,
        reclaimedMb: Math.round(result.reclaimedBytes / 1048576),
        remainingMb: Math.round(result.remainingBytes / 1048576),
        pods: result.podsScanned,
      };
      if (result.reclaimedBytes >= SPOOL_WARN_BYTES) {
        // Not an error — the sweep worked. But reclaiming this much means the
        // spool is being produced faster than downloads are completing, and
        // that is worth an operator's attention rather than a quiet info line.
        log.warn('reaped a large orphaned response spool from Traefik', line);
      } else {
        log.info('reaped orphaned response spool', line);
      }
    }
    return result;
  };

  // Fire once on boot: a pod that has been leaking since its last restart
  // should not wait 15 minutes for the first sweep.
  void runTick().catch((err) => log.warn('initial tick threw', err));

  const timer = setInterval(() => {
    void runTick().catch((err) => log.warn('tick threw', err));
  }, tickMs);

  return () => clearInterval(timer);
}
