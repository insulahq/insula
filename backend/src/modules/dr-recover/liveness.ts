/**
 * Liveness for background recoveries.
 *
 * A recovery runs inside one platform-api process. If that process dies — a
 * deploy, an eviction, an OOM — its task row would stay `running`: blocking
 * the retry ("already being recovered") and showing a recovery that is not
 * happening, until the 24 h orphan reaper. So every run heartbeats its row,
 * and a new start (./exclusive.ts) first fails the rows that stopped
 * heartbeating — judged on the DATABASE clock, the one that wrote them.
 */

import type { FastifyInstance } from 'fastify';
import * as taskService from '../tasks/service.js';

export const HEARTBEAT_MS = 30_000;
/** Six missed heartbeats. Longer than any pause a live run makes between writes. */
export const STALE_AFTER_SECONDS = 3 * 60;

export const ABANDONED_MESSAGE =
  'Stopped reporting progress — the platform-api process running it was restarted. ' +
  'Check the tenant, then start the recovery again.';

/** Keep `taskId` fresh while its run is alive. Returns the stop function. */
export function startHeartbeat(app: FastifyInstance, taskId: string): () => void {
  const timer = setInterval(() => {
    // progress() with no fields only refreshes updated_at (to NOW()).
    taskService.progress(app.db, taskId, {}).catch((err: unknown) => {
      app.log.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, 'dr-recover: heartbeat failed');
    });
  }, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
