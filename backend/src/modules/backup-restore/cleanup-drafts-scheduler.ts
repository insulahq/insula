/**
 * 15-minute scheduler that sweeps abandoned draft restore carts.
 *
 * Idempotent: each tick deletes drafts older than the retention
 * cutoff via `cleanupDraftRestoreCarts`. The function swallows its
 * own errors, so a transient DB hiccup never crashes the process
 * or stops future ticks.
 *
 * Wiring lives in app.ts next to the other 15-min cleanups
 * (backup-health, cnpg-backup-health). Pattern mirrors
 * backup-health/scheduler.ts.
 */
import { cleanupDraftRestoreCarts } from './cleanup-drafts.js';
import type { Database } from '../../db/index.js';

/** Default tick interval — 15 minutes. */
export const CLEANUP_DRAFTS_TICK_MS = 15 * 60 * 1000;

export interface CleanupDraftsSchedulerDeps {
  readonly db: Database;
  readonly tickMs?: number;
  readonly logger?: {
    info: (msg: string, ctx?: object) => void;
    warn: (msg: string, err?: unknown) => void;
  };
}

/** Start the scheduler; returns a stop callback. */
export function startCleanupDraftsScheduler(
  deps: CleanupDraftsSchedulerDeps,
): () => void {
  const tickMs = deps.tickMs ?? CLEANUP_DRAFTS_TICK_MS;
  const log = deps.logger ?? {
    // eslint-disable-next-line no-console
    info: (msg, ctx) => console.log(`[restore-cart-cleanup] ${msg}`, ctx ?? ''),
    // eslint-disable-next-line no-console
    warn: (msg, err) => console.warn(`[restore-cart-cleanup] ${msg}`, err ?? ''),
  };

  const runTick = async () => {
    const result = await cleanupDraftRestoreCarts({
      db: deps.db,
      now: () => new Date(),
      logger: { warn: log.warn },
    });
    // Quiet success path: only log when we actually deleted
    // something. Steady-state clusters won't have abandoned drafts
    // on every tick; logging every "deleted=0" tick would spam.
    if (result.deleted > 0) {
      log.info('swept abandoned drafts', { deleted: result.deleted });
    }
  };

  // Fire once on boot so a fresh deploy doesn't wait 15 min to do
  // its first sweep. Doesn't block startup — the .catch swallows
  // unexpected throws so the scheduler installs even if the first
  // tick fails.
  void runTick().catch((err) => log.warn('initial tick threw', err));

  const timer = setInterval(() => {
    void runTick();
  }, tickMs);

  return () => clearInterval(timer);
}
