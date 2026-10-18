/**
 * A Postgres instance on a node: does its data live on without that node?
 *
 * In the HA tier every CNPG instance's volume has ONE Longhorn replica, on
 * purpose: streaming replication between the instances is the redundancy
 * (platform-storage-policy/service.ts, cnpgDesiredReplicas). Counted by
 * Longhorn replicas alone, each instance's volume is always "the last
 * replica", so the drain refused every server that ran a database instance —
 * and the drain never even moves that pod (it is in a system namespace).
 *
 * An instance on the draining node is COVERED when its data is held by an
 * instance that stays up — Ready, on another node that is not cordoned itself,
 * every volume it mounts with a running replica on such a node:
 *
 *   - a replica is covered by the current PRIMARY, which holds everything;
 *   - the primary is covered by a standby it is STREAMING to right now, read
 *     from pg_stat_replication on the primary. A Ready pod alone proves only
 *     that Postgres answers, not that it is caught up — and the platform's
 *     replication is asynchronous. The primary can only be asked for the
 *     platform's own database (the API's DATABASE_URL points at it), so a
 *     primary of any other cluster is never covered.
 *
 * Covered, this node going down costs one instance, not the data: a replica
 * catches up when the node is back, a primary fails over. Anything short of
 * that — or facts that cannot be read — leaves `coveredBy` empty and the
 * last-replica guard holds.
 *
 * Removing the node is another matter: the instance's only copy goes with it,
 * and CNPG cannot start it anywhere else (deleteNode refuses — see there).
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** The platform's own database — the one cluster whose primary the API can ask about replication. */
export const PLATFORM_DB_CLUSTER = { namespace: 'platform', name: 'system-db' } as const;

export interface CnpgPvcFact {
  readonly namespace: string;
  readonly name: string;
  readonly cluster: string;
  /** The instance (pod) the volume belongs to, e.g. `system-db-2`. */
  readonly instance: string;
}

export interface CnpgPodFact {
  readonly namespace: string;
  readonly name: string;
  readonly cluster: string;
  readonly nodeName: string | null;
  readonly ready: boolean;
  readonly primary: boolean;
  /** Every PVC the pod mounts (data, and WAL when it has its own volume). */
  readonly claimNames: readonly string[];
}

export interface PostgresInstance {
  readonly kind: 'postgres';
  readonly cluster: string;
  readonly instance: string;
  /** This instance is the current primary: if its node goes down, Postgres fails over. */
  readonly primary: boolean;
  /** The instances that hold its data off this node. Empty = not covered. */
  readonly coveredBy: readonly string[];
}

/** What the cover check reads. */
export interface CnpgFacts {
  readonly pvcs: readonly CnpgPvcFact[];
  readonly pods: readonly CnpgPodFact[];
  /** Cordoned nodes: being drained, so about to go away — nothing there covers. */
  readonly cordonedNodes: ReadonlySet<string>;
  /**
   * Per cluster (`<namespace>/<name>`): the standbys its primary is streaming
   * to right now. A cluster missing here is unknown — its primary is not covered.
   */
  readonly streamingStandbys: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * The Postgres instance a volume on `drainNode` belongs to, with what covers
 * it — or null when the volume is not a CNPG instance volume. Pure.
 *
 * `healthyReplicaNodes(namespace, pvcName)` returns the nodes holding a
 * running Longhorn replica of that PVC's volume (empty when unknown).
 */
export function postgresInstanceOnNode(
  target: { readonly namespace: string; readonly pvcName: string },
  drainNode: string,
  facts: CnpgFacts,
  healthyReplicaNodes: (namespace: string, pvcName: string) => ReadonlySet<string>,
): PostgresInstance | null {
  const pvc = facts.pvcs.find((p) => p.namespace === target.namespace && p.name === target.pvcName);
  if (!pvc) return null;
  const sameCluster = facts.pods.filter((p) => p.namespace === pvc.namespace && p.cluster === pvc.cluster);
  const primaryPod = sameCluster.find((p) => p.primary);
  const isPrimary = primaryPod?.name === pvc.instance;

  const staysUp = (node: string | null): node is string =>
    node !== null && node !== drainNode && !facts.cordonedNodes.has(node);
  const holdsData = (pod: CnpgPodFact): boolean => pod.ready
    && staysUp(pod.nodeName)
    && pod.claimNames.length > 0
    && pod.claimNames.every((claim) => [...healthyReplicaNodes(pod.namespace, claim)].some(staysUp));

  let coveredBy: string[] = [];
  if (isPrimary) {
    const streaming = facts.streamingStandbys.get(`${pvc.namespace}/${pvc.cluster}`);
    coveredBy = sameCluster
      .filter((p) => p.name !== pvc.instance && streaming?.has(p.name) === true && holdsData(p))
      .map((p) => p.name)
      .sort();
  } else if (primaryPod && holdsData(primaryPod)) {
    coveredBy = [primaryPod.name];
  }
  return { kind: 'postgres', cluster: pvc.cluster, instance: pvc.instance, primary: isPrimary, coveredBy };
}

interface RawLabelled {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
}
interface RawCnpgPod extends RawLabelled {
  spec?: { nodeName?: string; volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }> };
  status?: { conditions?: Array<{ type?: string; status?: string }> };
}
interface RawNode {
  metadata?: { name?: string };
  spec?: { unschedulable?: boolean };
}

const CLUSTER_LABEL = 'cnpg.io/cluster';

/**
 * Read every CNPG instance PVC and instance pod, the cordoned nodes, and —
 * for the platform's own database — the standbys its primary streams to.
 * Throws on a Kubernetes list failure (the caller then treats every instance
 * as uncovered); a failed replication read only leaves that cluster unknown.
 */
export async function loadCnpgFacts(k8s: K8sClients, db: Database): Promise<CnpgFacts> {
  const [pvcList, podList, nodeList] = await Promise.all([
    k8s.core.listPersistentVolumeClaimForAllNamespaces({ labelSelector: CLUSTER_LABEL }) as Promise<{ items?: RawLabelled[] }>,
    k8s.core.listPodForAllNamespaces({ labelSelector: CLUSTER_LABEL }) as Promise<{ items?: RawCnpgPod[] }>,
    k8s.core.listNode() as Promise<{ items?: RawNode[] }>,
  ]);
  const pvcs: CnpgPvcFact[] = [];
  for (const p of pvcList.items ?? []) {
    const labels = p.metadata?.labels ?? {};
    const name = p.metadata?.name ?? '';
    const cluster = labels[CLUSTER_LABEL];
    if (!name || !cluster) continue;
    pvcs.push({
      namespace: p.metadata?.namespace ?? '',
      name,
      cluster,
      instance: labels['cnpg.io/instanceName'] ?? name.replace(/-wal$/, ''),
    });
  }
  const pods: CnpgPodFact[] = [];
  for (const p of podList.items ?? []) {
    const labels = p.metadata?.labels ?? {};
    const name = p.metadata?.name ?? '';
    const cluster = labels[CLUSTER_LABEL];
    // Instance pods only: CNPG's initdb/join Job pods carry the cluster label
    // and mount the same PVCs, but they are not instances.
    if (!name || !cluster || labels['cnpg.io/jobRole'] !== undefined) continue;
    pods.push({
      namespace: p.metadata?.namespace ?? '',
      name,
      cluster,
      nodeName: p.spec?.nodeName ?? null,
      ready: (p.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
      primary: labels['cnpg.io/instanceRole'] === 'primary' || labels.role === 'primary',
      claimNames: (p.spec?.volumes ?? [])
        .map((v) => v.persistentVolumeClaim?.claimName)
        .filter((c): c is string => typeof c === 'string' && c.length > 0),
    });
  }
  const cordonedNodes = new Set(
    (nodeList.items ?? []).filter((n) => n.spec?.unschedulable === true).map((n) => n.metadata?.name ?? ''),
  );
  const streamingStandbys = new Map<string, ReadonlySet<string>>();
  const platformKey = `${PLATFORM_DB_CLUSTER.namespace}/${PLATFORM_DB_CLUSTER.name}`;
  if (pods.some((p) => `${p.namespace}/${p.cluster}` === platformKey)) {
    const standbys = await readStreamingStandbys(db);
    if (standbys) streamingStandbys.set(platformKey, standbys);
  }
  return { pvcs, pods, cordonedNodes, streamingStandbys };
}

/**
 * The standbys the platform database's primary is streaming to now. CNPG
 * names each standby's connection after its instance (pod) name. Null when
 * the read fails.
 */
async function readStreamingStandbys(db: Database): Promise<ReadonlySet<string> | null> {
  try {
    const res = await db.execute(sql`select application_name from pg_stat_replication where state = 'streaming'`) as
      unknown as { rows?: Array<{ application_name?: string | null }> };
    return new Set((res.rows ?? []).map((r) => r.application_name ?? '').filter((n) => n.length > 0));
  } catch (err) {
    console.warn('[nodes] pg_stat_replication read failed — the primary counts as uncovered:', (err as Error).message);
    return null;
  }
}
