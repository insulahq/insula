import type { DashboardAlert } from '@insula/api-contracts';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { countStalePodsByNode } from '../node-health/recovery.js';
import { alert } from './alerts.js';

/**
 * Alerts that can only be answered by the cluster, so they ride the SLOW
 * endpoint rather than the 30-second one.
 *
 * Two live here:
 *
 *   Volume fullness — Longhorn knows per-volume usage; the platform database
 *   does not. And it has to be per-volume: a cluster with 361 GB free can
 *   still hold a volume at 100%, and it is that volume's workload that stops
 *   writing. A cluster-wide percentage hides exactly the case worth alerting.
 *
 *   Orphaned pods — Failed / Evicted / ContainerStatusUnknown pods left on a
 *   node. They hold no compute but they do hold their records, and a node
 *   quietly accumulating them is usually a node that has been evicting.
 *   Counted with the SAME predicate the clean-up action uses, so the tile and
 *   the button can never disagree about how many there are.
 */

interface LonghornVolume {
  metadata?: { name?: string };
  status?: { actualSize?: number | string; state?: string };
  spec?: { size?: number | string };
}

const VOLUME_WARN_FRACTION = 0.85;
const VOLUME_CRITICAL_FRACTION = 0.95;

function toBytes(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}
const gib = (b: number): number => Math.round((b / 1073741824) * 10) / 10;

export async function buildVolumeAlert(k8s: K8sClients): Promise<DashboardAlert | null> {
  const res = await k8s.custom.listNamespacedCustomObject({
    group: 'longhorn.io',
    version: 'v1beta2',
    namespace: 'longhorn-system',
    plural: 'volumes',
  }) as { items?: LonghornVolume[] };

  const full = (res.items ?? [])
    .map((v) => {
      const capacity = toBytes(v.spec?.size);
      const used = toBytes(v.status?.actualSize);
      return {
        name: v.metadata?.name ?? '(unnamed)',
        used, capacity,
        fraction: capacity > 0 ? used / capacity : 0,
      };
    })
    // A DETACHED volume reporting 0/0 is an idle resting state, not a fault —
    // filtering on capacity keeps those out instead of dividing by zero.
    .filter((v) => v.capacity > 0 && v.fraction >= VOLUME_WARN_FRACTION)
    .sort((a, b) => b.fraction - a.fraction)
    .slice(0, 5);

  if (full.length === 0) return null;
  const worst = full[0];
  const pct = Math.round(worst.fraction * 100);

  return alert({
    categoryId: 'admin.cluster_storage_capacity',
    severity: worst.fraction >= VOLUME_CRITICAL_FRACTION ? 'critical' : 'warning',
    value: `${pct}%`,
    title: full.length === 1 ? 'Volume nearly full' : 'Volumes nearly full',
    subtitle: `${worst.name} · ${gib(worst.used)} of ${gib(worst.capacity)} GiB`,
    href: '/cluster/storage',
    detail: full.map((v) => [
      v.name,
      `${gib(v.used)} / ${gib(v.capacity)} GiB · ${Math.round(v.fraction * 100)}%`,
    ] as [string, string]),
    note: 'A full volume stops writes for that workload only — the cluster can still have room.',
  });
}

/** Failed / Evicted / ContainerStatusUnknown pods left behind on a node. */
export async function buildOrphanedPodAlert(k8s: K8sClients): Promise<DashboardAlert | null> {
  const byNode = await countStalePodsByNode(k8s);
  const entries = Object.entries(byNode)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return null;

  return alert({
    // The closest category that can actually fire for node-level debris.
    categoryId: 'admin.node_event',
    // Never critical: orphaned pods hold no compute and delete cleanly. They
    // are a symptom worth reading, not an outage.
    severity: 'warning',
    value: String(total),
    title: total === 1 ? 'Orphaned pod' : 'Orphaned pods',
    subtitle: entries.length === 1
      ? `${entries[0][1]} on ${entries[0][0]}`
      : `across ${entries.length} nodes · worst ${entries[0][0]}`,
    href: '/cluster/nodes',
    detail: entries.map(([node, n]) => [node, `${n} pod${n === 1 ? '' : 's'}`] as [string, string]),
    note: 'Failed, evicted or status-unknown pods. Clearing them is safe — Cluster → Nodes → Recovery.',
  });
}
