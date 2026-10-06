/**
 * Mirror the per-node traffic counters into Prometheus.
 *
 * The firewall-reconciler DaemonSet owns an nft table on every node that counts
 * what the node exchanges with the OTHER nodes (by port class) and what its
 * backup shim sends off-site, and publishes the counters every 30 s to one
 * ConfigMap per node, `platform-system/node-traffic-<node>`. That DaemonSet is
 * host-network and its port is closed to the cluster by the host firewall, so
 * vmsingle cannot scrape it directly; the same "probe writes a ConfigMap,
 * platform-api reads it" pattern as security-probe avoids opening one.
 *
 * Each pass LISTs those ConfigMaps (one request) and sets
 * `platform_node_traffic_{bytes,packets}`. A snapshot older than STALE_MS is
 * dropped — a node that left the cluster leaves its ConfigMap behind, and its
 * frozen counters must not keep a flat line alive. A failed LIST leaves the
 * gauges as they were rather than blanking them.
 */
import { z } from 'zod';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { nodeTrafficBytes, nodeTrafficPackets } from '../../shared/metrics.js';

export const NODE_TRAFFIC_NAMESPACE = 'platform-system';
export const NODE_TRAFFIC_LABEL_SELECTOR = 'app.kubernetes.io/name=node-traffic';

/** Port classes of node-to-node traffic, in the order the panel shows them. */
export const NODE_TO_NODE_CLASSES = ['kubeapi', 'etcd', 'kubelet', 'tunnel', 'n2nother'] as const;
/** Every class the reconciler counts — node-to-node plus off-site backup. */
export const NODE_TRAFFIC_CLASSES = [...NODE_TO_NODE_CLASSES, 'backup'] as const;

/** Twice the publish interval plus slack: one missed write is not "gone". */
const STALE_MS = 5 * 60_000;

const counterSchema = z.object({
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  inPackets: z.number().nonnegative().optional(),
  outPackets: z.number().nonnegative().optional(),
});

export const nodeTrafficSnapshotSchema = z.object({
  version: z.literal(1),
  node: z.string().min(1),
  sampledAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'sampledAt must be a date-time'),
  epoch: z.string(),
  counters: z.record(z.string(), counterSchema),
});
export type NodeTrafficSnapshot = z.infer<typeof nodeTrafficSnapshotSchema>;

/** Decode `data.snapshot`; null when absent, malformed or an unknown version. */
export function parseNodeTrafficSnapshot(raw: string | undefined): NodeTrafficSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = nodeTrafficSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Fresh snapshots, one per node. Throws only when the LIST itself fails. */
export async function readNodeTrafficSnapshots(k8s: K8sClients, now: number = Date.now()): Promise<NodeTrafficSnapshot[]> {
  const list = await k8s.core.listNamespacedConfigMap({
    namespace: NODE_TRAFFIC_NAMESPACE,
    labelSelector: NODE_TRAFFIC_LABEL_SELECTOR,
  });
  const out: NodeTrafficSnapshot[] = [];
  for (const cm of list.items ?? []) {
    const snap = parseNodeTrafficSnapshot(cm.data?.snapshot);
    if (!snap) continue;
    if (now - Date.parse(snap.sampledAt) > STALE_MS) continue;
    out.push(snap);
  }
  return out;
}

/** Replace the exported series with these snapshots. */
export function publishNodeTraffic(snapshots: readonly NodeTrafficSnapshot[]): void {
  nodeTrafficBytes.reset();
  nodeTrafficPackets.reset();
  for (const snap of snapshots) {
    for (const cls of NODE_TRAFFIC_CLASSES) {
      const c = snap.counters[cls];
      if (!c) continue;
      nodeTrafficBytes.set({ node: snap.node, class: cls, direction: 'in' }, c.in);
      nodeTrafficBytes.set({ node: snap.node, class: cls, direction: 'out' }, c.out);
      if (c.inPackets !== undefined) nodeTrafficPackets.set({ node: snap.node, class: cls, direction: 'in' }, c.inPackets);
      if (c.outPackets !== undefined) nodeTrafficPackets.set({ node: snap.node, class: cls, direction: 'out' }, c.outPackets);
    }
  }
}

export interface NodeTrafficCollectorLog {
  warn(obj: unknown, msg?: string): void;
}

/**
 * Start the collector. Every replica runs it: each one's /metrics must carry
 * the series, or a scrape of a replica that skipped would read as a gap.
 */
export function startNodeTrafficCollector(
  k8s: K8sClients,
  log: NodeTrafficCollectorLog,
  intervalMs = 30_000,
): () => void {
  const pass = (): void => {
    readNodeTrafficSnapshots(k8s)
      .then(publishNodeTraffic)
      .catch((err: unknown) => {
        log.warn({ err: err instanceof Error ? err.message : String(err) },
          'node-traffic-collector: ConfigMap list failed; keeping the last values');
      });
  };
  pass();
  const timer = setInterval(pass, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
