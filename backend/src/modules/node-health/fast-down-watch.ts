/**
 * Fast node-down watch — one `listNode` every 30s, nothing else.
 *
 * The node-health reconciler runs on a 5-minute tick because its other
 * signals are expensive: a kubelet `/stats/summary` call per node, two
 * cluster-wide event lists, a CSINode list. That cadence is right for those,
 * and wrong for "is a node dead": during the drill the platform
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
 *   - it does NOT compute severity in `node_health_state` (the reconciler's
 *     job; a readiness-only view would get it wrong). The one thing it writes
 *     there is `reboot_announced`, after announcing a shutdown, so the startup
 *     notice can say the shutdown was announced.
 *   - it only announces a Ready → NotReady transition it observed itself, and
 *     announces it ONCE, worded by what the kubelet said: "shutting down" when
 *     it reported a graceful shutdown (boot-events.ts kubeletReportsShutdown),
 *     "down" otherwise. It used to be "down" here and then "rebooting" from the
 *     reconciler for the same shutdown, four minutes later.
 *   - both notices share the reconciler's dedupeKey (nodeDownDedupeKey), so
 *     whichever detector fires first wins and the other is suppressed
 *   - it never announces a node inside its join grace window (join-grace.ts).
 *     A bootstrapping node is NotReady by definition; it was announced as
 *     "down" on its very first sighting. The node is kept OUT of the
 *     remembered NotReady set while it joins, so if it is still NotReady when
 *     the window closes it reads as newly down and is announced then.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { nodeHealthState } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { safeTick } from '../../shared/safe-tick.js';
import { notifyAdminNodeDown, notifyAdminNodeShuttingDown } from '../notifications/events.js';
import { kubeletReportsShutdown } from './boot-events.js';
import {
  describeSuppression,
  joinGraceIndex,
  listPendingPeerWindows,
  nodeJoinGraceMs,
  type JoinGraceVerdict,
  type RawGraceNode,
} from './join-grace.js';

/** 30s. Kubernetes itself takes ~40s to mark a node NotReady, so polling
 *  faster than this cannot make the platform learn any sooner. */
export const FAST_DOWN_TICK_MS = 30_000;
const INITIAL_DELAY_MS = 60_000;

interface RawNode extends RawGraceNode {
  metadata?: { name?: string; creationTimestamp?: Date | string };
  status?: {
    conditions?: Array<{ type?: string; status?: string; message?: string }>;
    addresses?: Array<{ type?: string; address?: string }>;
    nodeInfo?: { bootID?: string };
  };
}

/**
 * The "going down" key — shared by the down and shutting-down notices and by
 * both detectors, so one outage is announced once whichever speaks first. Per
 * boot as well as per day: a node shut down twice in a day is two outages,
 * while one that flaps on the same boot stays one notice a day. The bootID is
 * the one the node went down with — a node does not report a new one until it
 * is back.
 */
export function nodeDownDedupeKey(nodeName: string, bootId: string | null, now: Date): string {
  return `node-down:${nodeName}:${bootId ?? 'unknown-boot'}:${now.toISOString().slice(0, 10)}`;
}

/** What the watch needs to word one announcement. */
export interface DownAnnouncement {
  readonly nodeName: string;
  readonly bootId: string | null;
  readonly shuttingDown: boolean;
}

/** The facts for each node to announce, read off the same Node list. */
export function describeAnnouncements(
  items: ReadonlyArray<RawNode>,
  names: ReadonlyArray<string>,
): DownAnnouncement[] {
  const byName = new Map(items.map((n) => [n.metadata?.name, n]));
  return names.map((nodeName) => {
    const node = byName.get(nodeName);
    const ready = (node?.status?.conditions ?? []).find((c) => c.type === 'Ready');
    return {
      nodeName,
      bootId: node?.status?.nodeInfo?.bootID || null,
      shuttingDown: kubeletReportsShutdown(ready),
    };
  });
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

export interface FastDownPlan {
  /** Nodes to announce as down this tick. */
  readonly announce: readonly string[];
  /** The NotReady set to remember — joining nodes deliberately left out. */
  readonly nextSeen: ReadonlySet<string>;
  /** NotReady nodes held back by the join grace window this tick. */
  readonly suppressed: readonly string[];
}

/**
 * One tick's decision. Pure. A joining node is neither announced nor
 * remembered, so the first tick after its window closes treats a node that is
 * STILL NotReady as newly down — the alert is late, never lost. A node already
 * remembered as down (the operator was told) stays tracked: the window holds
 * back news, it does not reset what was already announced.
 */
export function planFastDownTick(
  previous: ReadonlySet<string> | null,
  notReady: ReadonlyArray<string>,
  joining: ReadonlyMap<string, unknown>,
): FastDownPlan {
  const held = (n: string) => joining.has(n) && !(previous?.has(n) ?? false);
  const tracked = notReady.filter((n) => !held(n));
  return {
    announce: newlyDown(previous, tracked),
    nextSeen: new Set(tracked),
    suppressed: notReady.filter(held),
  };
}

/**
 * Join grace for this tick. The creation-time half is free (it is on the Node
 * objects already in hand). The pending-peer half costs an API call, so it is
 * only fetched when it could change the outcome: some NotReady node would
 * otherwise be announced right now.
 */
async function joinGraceForTick(
  k8s: FastDownWatchDeps['k8s'],
  items: ReadonlyArray<RawNode>,
  previous: ReadonlySet<string> | null,
  notReady: ReadonlyArray<string>,
  now: Date,
): Promise<ReadonlyMap<string, JoinGraceVerdict>> {
  const graceMs = nodeJoinGraceMs();
  const byCreation = joinGraceIndex(items, [], now, graceMs);
  const wouldAnnounce = newlyDown(previous, notReady.filter((n) => !byCreation.has(n)));
  if (graceMs <= 0 || wouldAnnounce.length === 0) return byCreation;
  return joinGraceIndex(items, await listPendingPeerWindows(k8s), now, graceMs);
}

/**
 * Record that the shutdown of the node's CURRENT boot was announced, so the
 * startup notice says so and the reconciler does not word it again. Only the
 * row for that same boot: a node the reconciler has not recorded yet (or with
 * no bootID) is left alone — its startup notice then says no shutdown notice
 * was recorded, which errs toward the cautious wording.
 */
export async function markShutdownAnnounced(db: Database, nodeName: string, bootId: string | null): Promise<void> {
  if (!bootId) return;
  await db.update(nodeHealthState)
    .set({ rebootAnnounced: true })
    .where(and(eq(nodeHealthState.nodeName, nodeName), eq(nodeHealthState.bootId, bootId)));
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
  let seenNotReady: ReadonlySet<string> | null = null;
  // Suppressed nodes already logged, so a 30-minute join logs once, not 60x.
  let loggedSuppressed: ReadonlySet<string> = new Set();
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    const res = (await deps.k8s.core.listNode()) as { items?: RawNode[] };
    const items = res.items ?? [];
    const current = notReadyNames(items);
    const now = new Date();
    const joining = await joinGraceForTick(deps.k8s, items, seenNotReady, current, now);
    const plan = planFastDownTick(seenNotReady, current, joining);
    seenNotReady = plan.nextSeen;

    for (const nodeName of plan.suppressed) {
      const verdict = joining.get(nodeName);
      if (verdict && !loggedSuppressed.has(nodeName)) {
        log.info(`[node-down-watch] ${describeSuppression(nodeName, verdict, 'NotReady alert')}`);
      }
    }
    loggedSuppressed = new Set(plan.suppressed);

    for (const a of describeAnnouncements(items, plan.announce)) {
      const key = nodeDownDedupeKey(a.nodeName, a.bootId, new Date());
      if (a.shuttingDown) {
        log.warn(`[node-down-watch] ${a.nodeName} is shutting down (kubelet reported a graceful shutdown)`);
        await notifyAdminNodeShuttingDown(deps.db, { nodeName: a.nodeName }, key)
          .catch((err) => log.warn('[node-down-watch] notify failed:', (err as Error).message));
        await markShutdownAnnounced(deps.db, a.nodeName, a.bootId)
          .catch((err) => log.warn('[node-down-watch] could not record the shutdown notice:', (err as Error).message));
      } else {
        log.warn(`[node-down-watch] ${a.nodeName} went NotReady`);
        await notifyAdminNodeDown(deps.db, { nodeName: a.nodeName }, key)
          .catch((err) => log.warn('[node-down-watch] notify failed:', (err as Error).message));
      }
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
