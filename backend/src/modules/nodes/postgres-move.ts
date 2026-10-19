/**
 * Delete moves the Postgres instances whose only copy is on the node it removes.
 *
 * In HA every CNPG instance keeps its one Longhorn replica on its own server
 * (postgres-cover.ts). Removing that server takes the copy with it, and CNPG
 * cannot start the instance anywhere else. So before the node goes, each such
 * instance is re-created elsewhere — CNPG's documented way to re-create an
 * instance's storage: delete its PVCs and its pod, and the operator joins a
 * fresh copy from the primary.
 *
 *   1. The node is cordoned first (deleteNode), so neither the new pod nor its
 *      new Longhorn replica can land on it again — Longhorn does not schedule
 *      replicas on a cordoned node.
 *   2. Nothing is touched unless the database cluster is WHOLE: CNPG reports it
 *      healthy and every instance is Ready. Re-creating one instance costs the
 *      cluster that copy until the new one is ready; with another instance
 *      already down — a re-creation still running, a standby that crashed —
 *      that would leave the primary alone with the data.
 *   3. A primary is switched over first, to a standby it is streaming to on
 *      another server, the way `kubectl cnpg promote` asks for it
 *      (status.targetPrimary). Writes pause briefly. CNPG may already have
 *      started one on its own — it switches a primary off a cordoned node.
 *   4. Only once the instance is a replica, the primary holds its data on
 *      another server, and the cluster is whole — re-read each time, never
 *      assumed — are its claims deleted: only those whose one copy is on this
 *      node (a claim CNPG already re-created elsewhere is never one of them),
 *      then its pod.
 *   5. Then wait until the cluster is whole again with no instance on this
 *      node and the old claims gone, before the next instance: two instances
 *      of one cluster are never re-created at once.
 *
 * Only a covered instance moves. One that nothing else holds — a
 * single-instance database — has no source to re-create it from; deleteNode
 * refuses it before anything changes. Every stall stops the delete with the
 * node cordoned and still in the cluster; pressing Delete again resumes, and
 * waits for a re-creation that is still running before it moves anything else.
 */
import { ApiError } from '../../shared/errors.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { PostgresInstance } from './postgres-cover.js';

const CNPG = { group: 'postgresql.cnpg.io', version: 'v1', plural: 'clusters' } as const;
const CLUSTER_LABEL = 'cnpg.io/cluster';
/** CNPG's phases (api/v1 cluster_types.go). */
const PHASE_SWITCHOVER = 'Switchover in progress';
const PHASE_HEALTHY = 'Cluster in healthy state';

export interface InstanceRef {
  readonly namespace: string;
  readonly cluster: string;
  readonly instance: string;
}

/**
 * The instance as deleteNode sees it now: what covers it and the Longhorn
 * volumes of it whose only copy is on the node; `'moved'` once no volume of
 * it keeps its only copy there; null when the facts cannot be read.
 */
export type CoverNow =
  | { readonly instance: PostgresInstance; readonly volumesHere: readonly string[] }
  | 'moved'
  | null;

export interface MoveOptions {
  readonly coverOf: (ref: InstanceRef) => Promise<CoverNow>;
  /** How long the cluster may take to be whole and the instance a replica. */
  readonly switchoverWaitMs?: number;
  /** How long the re-created instance may take to become Ready. */
  readonly rebuildWaitMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface RawCluster {
  metadata?: { resourceVersion?: string };
  spec?: { instances?: number };
  status?: { currentPrimary?: string; targetPrimary?: string; phase?: string; readyInstances?: number };
}
interface RawPvc {
  metadata?: { name?: string; uid?: string; labels?: Record<string, string> };
  spec?: { volumeName?: string };
}
interface RawPod {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { nodeName?: string };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}

const statusOf = (err: unknown): number | undefined =>
  (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;

/** RFC 3339 with microseconds — how CNPG writes targetPrimaryTimestamp. Pure. */
export function cnpgTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

/**
 * The status patch that asks CNPG to switch `instance` over to `target` — or
 * null when there is nothing to ask: it is not the primary (any more), or a
 * switchover or failover is already under way. Carries the resourceVersion,
 * so a concurrent change answers 409 instead of being overwritten. Pure.
 */
export function switchoverPatch(
  cluster: RawCluster, instance: string, target: string, nowMs: number,
): Record<string, unknown> | null {
  const s = cluster.status ?? {};
  if (s.currentPrimary !== instance) return null;
  if (s.targetPrimary !== s.currentPrimary) return null;
  return {
    metadata: { resourceVersion: cluster.metadata?.resourceVersion },
    status: {
      targetPrimary: target,
      targetPrimaryTimestamp: cnpgTimestamp(nowMs),
      phase: PHASE_SWITCHOVER,
      phaseReason: `Switching over to ${target}`,
    },
  };
}

/**
 * Whole: CNPG calls the cluster healthy, no switchover or failover is under
 * way, and as many instance pods are Ready as the cluster has instances. The
 * pods are the live count — CNPG's own status lags a pod that just went. Pure.
 */
export function clusterWhole(cluster: RawCluster, readyPods: number): boolean {
  const s = cluster.status ?? {};
  const want = cluster.spec?.instances ?? 1;
  return s.phase === PHASE_HEALTHY
    && s.currentPrimary !== undefined && s.targetPrimary === s.currentPrimary
    && (s.readyInstances ?? 0) >= want
    && readyPods >= want;
}

async function readCluster(k8s: K8sClients, ref: InstanceRef): Promise<RawCluster> {
  return await k8s.custom.getNamespacedCustomObject({
    ...CNPG, namespace: ref.namespace, name: ref.cluster,
  } as unknown as Parameters<typeof k8s.custom.getNamespacedCustomObject>[0]) as RawCluster;
}

/** The cluster's instance pods (not its Job pods): Ready ones, and those on `node`. */
async function instancePods(k8s: K8sClients, ref: InstanceRef, node: string): Promise<{ ready: number; onNode: string[] }> {
  const list = await k8s.core.listNamespacedPod({
    namespace: ref.namespace, labelSelector: `${CLUSTER_LABEL}=${ref.cluster}`,
  }) as { items?: RawPod[] };
  const pods = (list.items ?? []).filter((p) => p.metadata?.labels?.['cnpg.io/jobRole'] === undefined);
  return {
    ready: pods.filter((p) => (p.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')).length,
    onNode: pods.filter((p) => p.spec?.nodeName === node).map((p) => p.metadata?.name ?? ''),
  };
}

async function askSwitchover(k8s: K8sClients, ref: InstanceRef, cluster: RawCluster, target: string, nowMs: number): Promise<void> {
  const body = switchoverPatch(cluster, ref.instance, target, nowMs);
  if (!body) return;
  try {
    await (k8s.custom as unknown as {
      patchNamespacedCustomObjectStatus: (
        req: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown },
        mw: typeof MERGE_PATCH,
      ) => Promise<unknown>;
    }).patchNamespacedCustomObjectStatus({ ...CNPG, namespace: ref.namespace, name: ref.cluster, body }, MERGE_PATCH);
  } catch (err) {
    if (statusOf(err) !== 409) throw err; // 409: the cluster changed meanwhile — the next pass re-reads it
  }
}

/** The cluster's claims (data, WAL, tablespaces) with their uid and bound volume. */
async function clusterPvcs(k8s: K8sClients, ref: InstanceRef): Promise<Array<{ name: string; uid: string; volume: string; instance: string }>> {
  const list = await k8s.core.listNamespacedPersistentVolumeClaim({
    namespace: ref.namespace, labelSelector: `${CLUSTER_LABEL}=${ref.cluster}`,
  }) as { items?: RawPvc[] };
  return (list.items ?? [])
    .map((p) => ({
      name: p.metadata?.name ?? '',
      uid: p.metadata?.uid ?? '',
      volume: p.spec?.volumeName ?? '',
      instance: p.metadata?.labels?.['cnpg.io/instanceName'] ?? (p.metadata?.name ?? '').replace(/-wal$/, ''),
    }))
    .filter((p) => p.name !== '');
}

async function ignore404(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }
}

function stalled(node: string, ref: InstanceRef, message: string): ApiError {
  return new ApiError(
    'NODE_DELETE_DATABASE_MOVE_STALLED',
    `${message} The node '${node}' is cordoned and still in the cluster; nothing else was changed — press Delete ` +
    `again to continue.`,
    409,
    { node_name: node, instance: `${ref.namespace}/${ref.instance}` },
  );
}

const clusterState = (cluster: RawCluster | null, readyPods: number | null): string => cluster === null
  ? 'its cluster could not be read'
  : `the cluster reads "${cluster.status?.phase ?? '?'}", ${readyPods ?? '?'}/${cluster.spec?.instances ?? 1} instances Ready`;

/** Move one instance off `node`. False when there was nothing to move after all. */
async function moveOne(k8s: K8sClients, node: string, ref: InstanceRef, o: Required<MoveOptions>): Promise<boolean> {
  const label = `${ref.namespace}/${ref.instance}`;

  // 1) The cluster whole, the instance a replica, a primary on another server
  //    holding its data.
  const switchDeadline = o.now() + o.switchoverWaitMs;
  let lastSeen = 'its state could not be read';
  let volumesHere: readonly string[] = [];
  for (;;) {
    const cover = await o.coverOf(ref).catch(() => null);
    if (cover === 'moved') return false;
    const cluster = await readCluster(k8s, ref).catch(() => null);
    const pods = cluster ? await instancePods(k8s, ref, node).catch(() => null) : null;
    if (cover !== null && cluster !== null && pods !== null) {
      const covered = cover.instance.coveredBy.length > 0;
      const primary = cover.instance.primary || cluster.status?.currentPrimary === ref.instance
        || cluster.status?.targetPrimary === ref.instance;
      const whole = clusterWhole(cluster, pods.ready);
      if (whole && covered && !primary) {
        volumesHere = cover.volumesHere;
        break;
      }
      if (whole && covered && cover.instance.primary) {
        try {
          await askSwitchover(k8s, ref, cluster, cover.instance.coveredBy[0]!, o.now());
        } catch (err) {
          throw stalled(node, ref,
            `Asking PostgreSQL to switch ${label} over to ${cover.instance.coveredBy[0]} failed ` +
            `(${(err as Error).message.split('\n')[0]}); its copy on '${node}' was not touched.`);
        }
      }
      const target = cluster.status?.targetPrimary;
      const switching = target !== undefined && target !== cluster.status?.currentPrimary;
      const notWhole = `${clusterState(cluster, pods.ready)} — an instance is down or still being re-created, and ` +
        'moving this one now would leave too few copies of the data';
      lastSeen = primary
        ? `it is still the primary${switching ? ` (a switchover to ${target} is under way)` : !whole ? `, and ${notWhole}` : ''}`
        : !whole ? notWhole : 'no primary on another server holds its data right now';
    }
    if (o.now() >= switchDeadline) {
      throw stalled(node, ref,
        `Database instance ${label} could not be moved off '${node}' within ${Math.round(o.switchoverWaitMs / 1000)} s: ` +
        `${lastSeen}. Its copy there was not touched.`);
    }
    await o.sleep(o.pollMs);
  }

  // 2) Its claims whose one copy is here, then its pod. Read the cluster once
  //    more right before: a failover in between must not make this the
  //    instance whose data is deleted.
  const fresh = await readCluster(k8s, ref);
  if (fresh.status?.currentPrimary === ref.instance || fresh.status?.targetPrimary === ref.instance) {
    throw stalled(node, ref, `Database instance ${label} became the primary again while it was being moved.`);
  }
  const here = new Set(volumesHere);
  const claims = (await clusterPvcs(k8s, ref)).filter((c) => c.instance === ref.instance && here.has(c.volume));
  if (claims.length === 0) {
    throw stalled(node, ref, `No claim of database instance ${label} is bound to its copy on '${node}' any more.`);
  }
  for (const c of claims) {
    await ignore404(() => k8s.core.deleteNamespacedPersistentVolumeClaim({ name: c.name, namespace: ref.namespace }));
  }
  // Other instances of the cluster still on the node (each waits its turn).
  const othersHere = new Set((await instancePods(k8s, ref, node)).onNode.filter((n) => n !== ref.instance));
  await ignore404(() => k8s.core.deleteNamespacedPod({ name: ref.instance, namespace: ref.namespace }));

  // 3) Re-created: the old claims gone, no instance on this node, the cluster
  //    whole again — judged by the cluster, not by the instance's name. (Another
  //    instance waiting its turn on the node is not this one.)
  const oldUids = new Set(claims.map((c) => c.uid));
  const rebuildDeadline = o.now() + o.rebuildWaitMs;
  let state = '';
  for (;;) {
    const done = await (async () => {
      const left = (await clusterPvcs(k8s, ref)).some((c) => oldUids.has(c.uid));
      const cluster = await readCluster(k8s, ref);
      const pods = await instancePods(k8s, ref, node);
      state = clusterState(cluster, pods.ready);
      return !left && pods.onNode.every((n) => othersHere.has(n)) && clusterWhole(cluster, pods.ready);
    })().catch(() => false);
    if (done) return true;
    if (o.now() >= rebuildDeadline) {
      throw stalled(node, ref,
        `Database instance ${label} left '${node}' — its copy there was deleted and PostgreSQL is re-creating it on ` +
        `another server from the primary, which has not finished within ${Math.round(o.rebuildWaitMs / 60_000)} min ` +
        `(${state || 'its state could not be read'}; \`kubectl -n ${ref.namespace} get cluster ${ref.cluster}\` shows ` +
        `the progress — the re-creation does not need this node). Its old volume is now a leftover on the node: ` +
        `Delete lists it, to be ticked away with the node.`);
    }
    await o.sleep(o.pollMs);
  }
}

/**
 * Move every listed instance off `node`, one at a time. Returns the ones
 * moved (`namespace/instance`). Throws NODE_DELETE_DATABASE_MOVE_STALLED when
 * one does not get there in time.
 */
export async function movePostgresInstancesOff(
  k8s: K8sClients,
  node: string,
  refs: readonly InstanceRef[],
  opts: MoveOptions,
): Promise<string[]> {
  const o: Required<MoveOptions> = {
    switchoverWaitMs: 180_000,
    rebuildWaitMs: 900_000,
    pollMs: 5_000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    ...opts,
  };
  const moved: string[] = [];
  for (const ref of refs) {
    if (await moveOne(k8s, node, ref, o)) moved.push(`${ref.namespace}/${ref.instance}`);
  }
  return moved;
}
