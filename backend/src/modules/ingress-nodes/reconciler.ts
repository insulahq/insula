import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import { selectIngressNodeAddresses, type NodeLike } from './discovery.js';
import { safeTick } from '../../shared/safe-tick.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

/**
 * Keep the DISCOVERED ingress addresses in step with live cluster state.
 *
 * Writes `ingress_discovered_ipv4` / `ingress_discovered_ipv6` — never
 * `ingress_default_ipv4` / `ingress_default_ipv6`. Those remain the operator's
 * to set, and an operator value always wins (see `getIngressSettings`). The
 * split matters: an operator may deliberately point tenant apexes at a
 * load-balancer VIP or an anycast address that is not any node's ExternalIP,
 * and a reconciler that overwrote that would silently undo a deliberate
 * decision every hour.
 *
 * This only maintains the *inputs*. It never writes DNS: drift detection and
 * the additive repair stay exactly as they were — the operator still decides
 * when tenant zones change.
 */

export const DISCOVERED_IPV4_KEY = 'ingress_discovered_ipv4';
export const DISCOVERED_IPV6_KEY = 'ingress_discovered_ipv6';
/** Node names that produced the current value — operator-facing provenance. */
export const DISCOVERED_NODES_KEY = 'ingress_discovered_nodes';

const DEFAULT_INTERVAL_MINUTES = 5;
const INITIAL_DELAY_MS = 60_000;

async function setSetting(db: Database, key: string, value: string): Promise<void> {
  await db
    .insert(platformSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

async function getSetting(db: Database, key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key));
  return row?.value ?? null;
}

export interface ReconcileResult {
  readonly ipv4: string[];
  readonly ipv6: string[];
  readonly nodeNames: string[];
  readonly changed: boolean;
}

export async function reconcileIngressAddresses(
  db: Database,
  k8s: K8sClients,
): Promise<ReconcileResult> {
  const res = (await k8s.core.listNode()) as unknown as { items?: NodeLike[] };
  const discovered = selectIngressNodeAddresses(res.items ?? []);

  // Refuse to publish an empty set. A transient API read that returns nothing
  // (or a cluster mid-upgrade with every node briefly NotReady) would
  // otherwise blank the discovered addresses, and every apex would look like
  // it had drifted to zero. Keeping the last known-good value is strictly
  // safer — this reconciler only ever has to be eventually right.
  if (discovered.ipv4.length === 0 && discovered.ipv6.length === 0) {
    return { ...discovered, changed: false };
  }

  const nextV4 = discovered.ipv4.join(',');
  const nextV6 = discovered.ipv6.join(',');
  const nextNodes = discovered.nodeNames.join(',');

  const [curV4, curV6] = await Promise.all([
    getSetting(db, DISCOVERED_IPV4_KEY),
    getSetting(db, DISCOVERED_IPV6_KEY),
  ]);

  const changed = curV4 !== nextV4 || curV6 !== nextV6;
  if (!changed) return { ...discovered, changed: false };

  await setSetting(db, DISCOVERED_IPV4_KEY, nextV4);
  await setSetting(db, DISCOVERED_IPV6_KEY, nextV6);
  await setSetting(db, DISCOVERED_NODES_KEY, nextNodes);

  console.log(
    `[ingress-nodes] discovered ingress addresses changed: ` +
      `v4=[${nextV4}] v6=[${nextV6}] from ${discovered.nodeNames.length} node(s). ` +
      `Tenant apex records are NOT updated automatically — run a DNS drift scan to review.`,
  );

  return { ...discovered, changed: true };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

export interface IngressNodeSchedulerOptions {
  readonly intervalMinutes?: number;
  readonly initialDelayMs?: number;
  readonly log?: { warn: (msg: string, err?: unknown) => void };
}

export interface IngressNodeSchedulerHandle {
  readonly stop: () => void;
}

/**
 * 5-minute cadence, matching the ingress-external-ips CronJob so both views of
 * "which nodes serve ingress" converge at the same rate. A node add/remove
 * window is then never wider than one tick on either side.
 */
export function startIngressNodeScheduler(
  db: Database,
  k8s: K8sClients,
  opts: IngressNodeSchedulerOptions = {},
): IngressNodeSchedulerHandle {
  const intervalMs = (opts.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) * 60_000;
  const log = opts.log ?? { warn: (m: string, e?: unknown) => console.warn(m, e) };

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      safeTick('ingress-nodes', () => reconcileIngressAddresses(db, k8s), log);
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
