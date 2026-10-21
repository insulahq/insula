/**
 * A scheduled run the platform could not start: its own cluster API was out
 * of reach (executor.ts clusterUnreachable). Production, a server being shut
 * down: the tenant was emailed that their task "did not run: connect
 * ETIMEDOUT".
 *
 *   - A run whose command was certainly never sent is tried once more after
 *     PLATFORM_FAULT_RETRY_DELAY_MS; the API server that went away is usually
 *     out of the Service's endpoints by then. Nothing else is retried: a
 *     connection reset during the exec handshake may have started it.
 *   - The tenant is never told: it is not their failure. The run is recorded
 *     as failed, its output saying why.
 *   - The operator is told — once a day for the whole cluster — unless a node
 *     outage explains it. A server node takes its API server down with it, and
 *     that node was announced already. Anything else (a firewall change, a
 *     broken kubeconfig, an API server down on its own) would otherwise stop
 *     every tenant's scheduled tasks with nobody hearing about it.
 */
import { eq, gt } from 'drizzle-orm';
import { nodeHealthState, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { formatGraceUntil, joinGraceIndex, nodeJoinGraceMs, parseK8sTime } from '../node-health/join-grace.js';
import { NODE_RECOVERY_SETTLE_MS, type RawOutageNode } from '../node-health/outage-hold.js';
import { CRON_PLATFORM_FAULT_RESOURCE } from '../notifications/action-path.js';
import type { CronJobRow } from './executor.js';

/**
 * How long a scheduled run waits before its one retry. With the exec's
 * ~130 s connect timeout before it, the two attempts stay inside the claim's
 * window (the job's own timeout + 5 min, scheduler.ts claimStaleBefore).
 */
export const PLATFORM_FAULT_RETRY_DELAY_MS = 30_000;

/**
 * How long after the first fault the operator notice is decided. A crashed
 * node is marked NotReady ~40 s after its last heartbeat, and the fast
 * down-watch records it within 30 s more: decided sooner, the outage that
 * explains the fault is not visible yet, and the operator hears of it twice.
 */
export const OUTAGE_EVIDENCE_DELAY_MS = 90_000;

/**
 * A node that went down explains an unreachable API only this long. The
 * kubernetes Service drops a dead API server's endpoint within seconds, so a
 * fault long into an outage has another cause — and a node left off for days
 * must not silence these notices for as long as it stays off.
 */
export const OUTAGE_EXPLAINS_FOR_MS = 15 * 60_000;

const NODE_LIST_TIMEOUT_MS = 10_000;

/**
 * The outage in the cluster's own Node list that explains a fault at `now`,
 * or null. Pure. A node that left Ready in the last OUTAGE_EXPLAINS_FOR_MS,
 * one back inside its settle window (node-health/outage-hold.ts), or one still
 * in its join window.
 */
export function outageFromNodes(nodes: readonly RawOutageNode[], now: Date): string | null {
  for (const node of nodes) {
    const name = node.metadata?.name;
    const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
    const since = parseK8sTime(ready?.lastTransitionTime);
    if (!name || !since) continue;
    const age = now.getTime() - since.getTime();
    if (ready?.status !== 'True') {
      if (age <= OUTAGE_EXPLAINS_FOR_MS) return `${name} went down at ${formatGraceUntil(since)}`;
    } else if (age <= NODE_RECOVERY_SETTLE_MS) {
      return `${name} came back at ${formatGraceUntil(since)} and is still settling`;
    }
  }
  const [joining] = [...joinGraceIndex(nodes, [], now, nodeJoinGraceMs()).keys()];
  return joining ? `${joining} is joining the cluster` : null;
}

/**
 * The node outage that explains an unreachable cluster API, or null. The
 * cluster's Node list when it answers; when it cannot be asked (it is what
 * failed), what the node-health detectors last recorded — a node seen leaving
 * Ready inside the same window.
 */
export async function explainingOutage(
  db: Database,
  listNodes: () => Promise<readonly RawOutageNode[] | null>,
  now: Date = new Date(),
): Promise<string | null> {
  const nodes = await listNodes();
  if (nodes) return outageFromNodes(nodes, now);
  const [down] = await db
    .select({ nodeName: nodeHealthState.nodeName, downSince: nodeHealthState.downSince })
    .from(nodeHealthState)
    .where(gt(nodeHealthState.downSince, new Date(now.getTime() - OUTAGE_EXPLAINS_FOR_MS)))
    .limit(1);
  return down?.downSince ? `${down.nodeName} went down at ${formatGraceUntil(down.downSince)} (as last recorded)` : null;
}

/** The cluster's Node list, or null when it does not answer within 10 s. Never rejects. */
export function clusterNodeList(kubeconfigPath?: string): () => Promise<readonly RawOutageNode[] | null> {
  return async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const list = createK8sClients(kubeconfigPath).core.listNode({}) as Promise<{ items?: RawOutageNode[] }>;
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), NODE_LIST_TIMEOUT_MS);
        timer.unref?.();
      });
      const answered = await Promise.race([list, timeout]);
      return answered ? answered.items ?? [] : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The UTC day this process already told the operator about. Notices are
 * decided one at a time, so jobs faulting in the same tick send one between
 * them (the dispatcher's own dedupe covers the other replicas).
 */
let announcedDay: string | null = null;
let decisions: Promise<void> = Promise.resolve();

/** Test seam. */
export function resetPlatformFaultNotices(): void {
  announcedDay = null;
}

/**
 * Tell the operator that a scheduled task did not run because the platform
 * could not reach its cluster — unless `explain` names an outage. Never throws.
 */
export function notifyOperatorOfPlatformFault(
  db: Database,
  job: CronJobRow,
  fault: string,
  explain: () => Promise<string | null>,
  now: Date = new Date(),
): Promise<void> {
  const decision = decisions.then(() => decide(db, job, fault, explain, now));
  decisions = decision;
  return decision;
}

async function decide(
  db: Database,
  job: CronJobRow,
  fault: string,
  explain: () => Promise<string | null>,
  now: Date,
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  if (announcedDay === day) return;
  try {
    const outage = await explain();
    if (outage) {
      console.warn(`[cron-scheduler] job ${job.id}: ${outage}, which explains it — the operator is not told again`);
      return;
    }
    const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, job.tenantId));
    const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
    await notifyAdminOperationalEvent(db, 'platform', {
      subsystem: 'Scheduled tasks',
      objectLabel: `${job.name} (${tenant?.name ?? job.tenantId})`,
      detail: `did not run: the platform ${fault}. No node outage explains it. `
        + 'The tenant was not told; their panel shows the run as failed.',
      severityLabel: 'not run',
      recommendedAction: 'Check that platform-api can reach the Kubernetes API: its log, the kubernetes Service endpoints, the cluster '
        + 'firewall. Other scheduled tasks that fail this way today are not announced again.',
    }, `cron-platform-fault:${day}`, CRON_PLATFORM_FAULT_RESOURCE);
    announcedDay = day;
  } catch (err) {
    console.warn('[cron-scheduler] could not tell the operator about a platform fault:', err instanceof Error ? err.message : err);
  }
}
