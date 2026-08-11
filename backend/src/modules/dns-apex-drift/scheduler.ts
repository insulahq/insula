import { safeTick } from '../../shared/safe-tick.js';
import { scanApexDrift } from './service.js';
import type { Database } from '../../db/index.js';

/**
 * Periodic apex-drift DETECTION.
 *
 * Detection only — this never repairs. Repair is always an explicit operator
 * action from the DNS settings page, because an additive write into a customer
 * zone is not something a background timer should decide to do on its own.
 *
 * The cadence is deliberately slow: drift only appears when cluster ingress
 * membership changes, which is a rare, operator-driven event. A scan walks
 * every primary-mode zone through its DNS provider, so running it often would
 * mean constant provider traffic to detect something that changes monthly.
 */
const DEFAULT_INTERVAL_MINUTES = 60;
const INITIAL_DELAY_MS = 5 * 60_000; // let the API settle before the first walk

export interface ApexDriftSchedulerOptions {
  readonly intervalMinutes?: number;
  readonly initialDelayMs?: number;
  readonly log?: { warn: (msg: string, err?: unknown) => void };
}

export interface ApexDriftSchedulerHandle {
  readonly stop: () => void;
}

export function startApexDriftScheduler(
  db: Database,
  opts: ApexDriftSchedulerOptions = {},
): ApexDriftSchedulerHandle {
  const intervalMs = (opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000;
  const log = opts.log ?? { warn: (m: string, e?: unknown) => console.warn(m, e) };

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const report = await scanApexDrift(db, { trigger: 'scheduled' });
    if (report.driftCount > 0) {
      // Surfaced to the operator by the banner; logged so the condition is
      // also visible without the UI.
      console.log(
        `[dns-apex-drift] ${report.driftCount} domain(s) missing apex ingress records ` +
          `(${report.errorCount} unreadable). Repair is operator-invoked from DNS settings.`,
      );
    }
  };

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      // safeTick, not `void tick()` — a rejected tick with no handler
      // terminates the process.
      safeTick('dns-apex-drift', tick, log);
      schedule(intervalMs);
    }, delay);
  };

  schedule(opts.initialDelayMs ?? INITIAL_DELAY_MS);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
