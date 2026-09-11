/**
 * Fast node-down watch — one `listNode` every 30s, nothing else.
 *
 * The node-health reconciler runs on a 5-minute tick because its other
 * signals are expensive: a kubelet `/stats/summary` call per node, two
 * cluster-wide event lists, a CSINode list. That cadence is right for those,
 * and wrong for "is a node dead": during the 2026-09-11 drill the platform
 * reported `ready: true` for a node that had been offline for **4m20s**, and
 * served that stale snapshot to the operator with no indication it was stale.
 *
 * Worse, the outage itself delayed its own detection. Losing the node killed
 * the Postgres primary, which restarted the platform-api pods, which restarted
 * the reconciler's timer — pushing the tick for the very event that caused it
 * further out.
 *
 * So this watch does the cheapest possible thing on a short interval and
 * leaves the model to the reconciler:
 *
 *   - it does NOT write `node_health_state` (severity is the reconciler's job,
 *     and a readiness-only view would compute the wrong severity)
 *   - it only announces a Ready → NotReady transition it observed itself
 *   - it shares the reconciler's dedupeKey, so whichever fires first wins and
 *     the other is suppressed — no duplicate notification
 */
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { safeTick } from '../../shared/safe-tick.js';
import { notifyAdminNodeDown } from '../notifications/events.js';

/** 30s. Kubernetes itself takes ~40s to mark a node NotReady, so polling
 *  faster than this cannot make the platform learn any sooner. */
export const FAST_DOWN_TICK_MS = 30_000;
const INITIAL_DELAY_MS = 60_000;

interface RawNode {
  metadata?: { name?: string };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}

/** The dedupe key the 5-min reconciler uses. Identical on purpose. */
export function nodeDownDedupeKey(nodeName: string, now: Date): string {
  return `node-down:${nodeName}:${now.toISOString().slice(0, 10)}`;
}

/**
 * Names that are NotReady right now. Only `Ready=True` counts — a node whose
 * kubelet has stopped posting reports `Unknown`, not `False`.
 */
export function notReadyNames(items: ReadonlyArray<RawNode>): string[] {
  return items
    .filter((n) => (n.status?.conditions ?? []).find((c) => c.type === 'Ready')?.status !== 'True')
    .map((n) => n.metadata?.name)
    .filter((n): n is string => !!n)
    .sort();
}

/**
 * Transitions INTO NotReady since the previous observation.
 *
 * On the first tick `previous` is null and nothing is announced: a node that
 * was already down before this process started is not news, and announcing it
 * on every platform-api restart would spam the operator during exactly the
 * incident they are trying to read.
 */
export function newlyDown(
  previous: ReadonlySet<string> | null,
  current: ReadonlyArray<string>,
): string[] {
  if (previous === null) return [];
  return current.filter((n) => !previous.has(n));
}

export interface FastDownWatchDeps {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly tickMs?: number;
  readonly logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

export function startFastNodeDownWatch(deps: FastDownWatchDeps): { stop: () => void } {
  const tickMs = deps.tickMs ?? FAST_DOWN_TICK_MS;
  const log = deps.logger ?? console;
  let seenNotReady: Set<string> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    const res = (await deps.k8s.core.listNode()) as { items?: RawNode[] };
    const current = notReadyNames(res.items ?? []);
    const announce = newlyDown(seenNotReady, current);
    seenNotReady = new Set(current);

    for (const nodeName of announce) {
      log.warn(`[node-down-watch] ${nodeName} went NotReady`);
      await notifyAdminNodeDown(deps.db, { nodeName }, nodeDownDedupeKey(nodeName, new Date()))
        .catch((err) => log.warn('[node-down-watch] notify failed:', (err as Error).message));
    }
  };

  const initial = setTimeout(() => {
    void safeTick('node-down-watch', tick);
    timer = setInterval(() => void safeTick('node-down-watch', tick), tickMs);
  }, INITIAL_DELAY_MS);

  return {
    stop: () => {
      clearTimeout(initial);
      if (timer) clearInterval(timer);
    },
  };
}
