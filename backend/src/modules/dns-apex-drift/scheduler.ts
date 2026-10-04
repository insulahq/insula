import { safeTick } from '../../shared/safe-tick.js';
import { scanApexDrift } from './service.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

/**
 * Periodic apex-drift DETECTION.
 *
 * Detection only — this never changes DNS. Repair is always an explicit
 * operator action (the drift modal, or "Refresh route DNS" on a domain),
 * because adding and removing records in a customer zone is not something a
 * background timer should decide to do on its own.
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

  let k8s: K8sClients | null = null;
  try {
    k8s = createK8sClients(process.env.KUBECONFIG_PATH);
  } catch {
    k8s = null; // no kubeconfig (local dev): scan from the stored inventory
  }
  const tick = async (): Promise<void> => {
    if (stopped) return;
    // One replica scans: every scan reads every tenant zone from the DNS
    // provider, and the report is shared anyway.
    const leased = await withSchedulerLease(db, 'dns-route-drift-scan', intervalMs * 1.5,
      () => scanApexDrift(db, { trigger: 'scheduled', k8s }));
    if (!leased.ran) return;
    const report = leased.value;
    if (report.driftCount > 0) {
      // Surfaced by the DNS page banner and the dashboard tile; logged so the
      // condition is also visible without the UI.
      console.log(
        `[dns-route-drift] ${report.driftCount} domain(s) drift: ${report.missingCount} missing, `
          + `${report.staleCount} stale record(s) (${report.errorCount} unreadable). Repair from the DNS page or the dashboard.`,
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
