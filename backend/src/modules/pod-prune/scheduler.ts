/**
 * Auto-prune scheduler.
 *
 * Runs on a slow tick — dead pod records accumulate at the rate nodes reboot,
 * which is a handful per week at most, so anything faster is pure API traffic
 * for nothing. The sweep is idempotent: it re-derives the prunable set from the
 * cluster every tick, so a missed tick or a mid-tick restart costs nothing.
 *
 * `autoPruneDays: 0` disables the sweep. The manual endpoint is unaffected —
 * an operator can still prune on demand with automation switched off, which is
 * the point of having both.
 */
import type * as k8s from '@kubernetes/client-node';
import type { Database } from '../../db/index.js';
import { prunePods } from './service.js';
import { getAutoPruneDays } from './settings.js';

/** Once every 6 hours. */
export const POD_PRUNE_TICK_MS = 6 * 60 * 60 * 1000;

export interface PodPruneSchedulerArgs {
  readonly db: Database;
  readonly clients: () => { core: k8s.CoreV1Api; batch: k8s.BatchV1Api } | null;
  readonly log: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
  readonly tickMs?: number;
}

export async function runPodPruneTick(args: PodPruneSchedulerArgs): Promise<void> {
  let days: number;
  try {
    days = await getAutoPruneDays(args.db);
  } catch (err) {
    args.log.warn({ err }, 'pod-prune: could not read retention — skipping this tick');
    return;
  }
  if (days <= 0) return; // disabled

  const c = args.clients();
  if (!c) {
    args.log.warn({}, 'pod-prune: Kubernetes unavailable — skipping this tick');
    return;
  }

  try {
    const result = await prunePods({
      core: c.core,
      batch: c.batch,
      olderThanDays: days,
      log: { warn: (m: string) => args.log.warn({}, m) },
    });
    // Only speak when something happened. A quiet cluster should produce a
    // quiet log, or the signal is lost in six-hourly "nothing to do" lines.
    if (result.pruned.length > 0) {
      args.log.info(
        { autoPruneDays: days, scanned: result.scanned, pruned: result.pruned.length },
        'pod-prune: swept dead pod records',
      );
    }
  } catch (err) {
    args.log.warn({ err }, 'pod-prune: sweep failed — will retry next tick');
  }
}

export function startPodPruneScheduler(args: PodPruneSchedulerArgs): () => void {
  const tick = args.tickMs ?? POD_PRUNE_TICK_MS;
  const timer = setInterval(() => { void runPodPruneTick(args); }, tick);
  // Do not hold the process open for a housekeeping sweep.
  timer.unref?.();
  return () => clearInterval(timer);
}
