import { sql } from 'drizzle-orm';
import type { DashboardAlert } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { countStalePodsByNode } from '../node-health/recovery.js';
import { readPvcUsage, type PvcUsageReader } from './pvc-usage.js';
import { alert } from './alerts.js';

/**
 * Alerts that can only be answered by the cluster, so they ride the SLOW
 * endpoint rather than the 30-second one.
 *
 * Two live here:
 *
 *   Volume fullness — the kubelet knows per-volume usage; the platform
 *   database does not. And it has to be per-volume: a cluster with 361 GB free
 *   can still hold a volume at 100%, and it is that volume's workload that
 *   stops writing. A cluster-wide percentage hides exactly the case worth
 *   alerting. See pvc-usage.ts for why this reads the FILESYSTEM rather than
 *   Longhorn's `actualSize`, which measures the host cost of the snapshot
 *   chain and is not a fullness figure at all.
 *
 *   Orphaned pods — Failed / Evicted / ContainerStatusUnknown pods left on a
 *   node. They hold no compute but they do hold their records, and a node
 *   quietly accumulating them is usually a node that has been evicting.
 *   Counted with the SAME predicate the clean-up action uses, so the tile and
 *   the button can never disagree about how many there are.
 */

interface LonghornVolume {
  metadata?: { name?: string; creationTimestamp?: string };
  status?: {
    actualSize?: number | string;
    state?: string;
    robustness?: string;
    /**
     * Longhorn's own view of the Kubernetes objects behind the volume.
     * `pvStatus` empty with `lastPVCRefAt` set is a volume whose PVC has GONE
     * — the shape an orphan actually has on a live cluster, confirmed against
     * production rather than taken from the docs.
     */
    kubernetesStatus?: {
      pvcName?: string;
      namespace?: string;
      pvStatus?: string;
      lastPVCRefAt?: string;
      lastPodRefAt?: string;
    };
  };
  spec?: { size?: number | string };
}

/** namespace → the tenant that owns it, for alerts that must name a customer. */
export interface TenantRef { readonly id: string; readonly name: string }

export async function loadTenantsByNamespace(db: Database): Promise<Map<string, TenantRef>> {
  const rows = await db.execute<{ id: string; name: string; ns: string | null }>(sql`
    SELECT id, name, kubernetes_namespace AS ns FROM tenants WHERE kubernetes_namespace IS NOT NULL
  `);
  const out = new Map<string, TenantRef>();
  for (const r of rows as unknown as Array<{ id: string; name: string; ns: string | null }>) {
    if (r.ns) out.set(r.ns, { id: r.id, name: r.name });
  }
  return out;
}

const daysSince = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
};

const VOLUME_WARN_FRACTION = 0.85;
const VOLUME_CRITICAL_FRACTION = 0.95;

function toBytes(v: number | string | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}
const gib = (b: number): number => Math.round((b / 1073741824) * 10) / 10;

async function listVolumes(k8s: K8sClients): Promise<LonghornVolume[]> {
  const res = await k8s.custom.listNamespacedCustomObject({
    group: 'longhorn.io',
    version: 'v1beta2',
    namespace: 'longhorn-system',
    plural: 'volumes',
  }) as { items?: LonghornVolume[] };
  return res.items ?? [];
}

/**
 * `pvc-3f1a…` is a Longhorn-generated name. It tells an operator nothing, and
 * "Volume nearly full" without a customer beside it is an alert you cannot
 * act on — which is exactly what was reported. Prefer the tenant, fall back to
 * the PVC and namespace, and keep the volume id only as a last resort.
 */
interface Described { label: string; tenant: TenantRef | null; ns: string | null }

function describePvc(
  ns: string | null,
  pvcName: string | null,
  tenants: Map<string, TenantRef>,
  fallback: string,
): Described {
  const tenant = ns ? tenants.get(ns) ?? null : null;
  if (tenant) return { label: tenant.name, tenant, ns };
  if (pvcName) return { label: `${pvcName}${ns ? ` (${ns})` : ''}`, tenant: null, ns };
  return { label: fallback, tenant: null, ns };
}

function describeVolume(v: LonghornVolume, tenants: Map<string, TenantRef>): Described {
  const ks = v.status?.kubernetesStatus;
  return describePvc(ks?.namespace ?? null, ks?.pvcName ?? null, tenants, v.metadata?.name ?? '(unnamed)');
}

export async function buildVolumeAlert(
  k8s: K8sClients,
  tenants: Map<string, TenantRef> = new Map(),
  readUsage: PvcUsageReader = readPvcUsage,
): Promise<DashboardAlert | null> {
  const full = (await readUsage(k8s))
    .map((v) => ({
      ...describePvc(v.namespace, v.pvcName, tenants, v.pvcName),
      pvcName: v.pvcName,
      used: v.usedBytes,
      capacity: v.capacityBytes,
      fraction: v.fraction,
    }))
    .filter((v) => v.fraction >= VOLUME_WARN_FRACTION)
    .sort((a, b) => b.fraction - a.fraction)
    .slice(0, 5);

  if (full.length === 0) return null;
  const worst = full[0];
  const pct = Math.round(worst.fraction * 100);
  const tenantIds = new Set(full.map((v) => v.tenant?.id).filter(Boolean));

  return alert({
    categoryId: 'admin.cluster_storage_capacity',
    severity: worst.fraction >= VOLUME_CRITICAL_FRACTION ? 'critical' : 'warning',
    value: `${pct}%`,
    title: full.length === 1 ? 'Volume nearly full' : 'Volumes nearly full',
    // WHO, then how much. The volume id moves into the detail rows.
    subtitle: `${worst.label} · ${gib(worst.used)} of ${gib(worst.capacity)} GiB`,
    // /cluster/storage lists volumes but says nothing about the tenant behind
    // one. When a single tenant is responsible, go straight to them — that is
    // where the quota and the files are.
    href: tenantIds.size === 1 && worst.tenant ? `/tenants/${worst.tenant.id}` : '/cluster/storage',
    detail: full.map((v) => [
      v.label,
      `${gib(v.used)} / ${gib(v.capacity)} GiB · ${Math.round(v.fraction * 100)}%`,
    ] as [string, string]),
    note: 'A full volume stops writes for that workload only — the cluster can still have room.',
  });
}

/**
 * Longhorn volumes whose PVC is GONE.
 *
 * They are invisible everywhere else: not in `kubectl get pvc`, not on a
 * tenant's usage page, and the cluster storage page lists them beside live
 * ones without saying which is which. Meanwhile they hold their full
 * allocation on disk and are billed to nobody.
 *
 * The signature is Longhorn's own bookkeeping: `lastPVCRefAt` set means a PVC
 * was bound once, and `pvStatus` no longer `Bound` means it is not any more.
 * Requiring BOTH keeps a volume that is still being provisioned — empty
 * pvStatus, no lastPVCRefAt — out of the alert.
 */
export async function buildOrphanedVolumeAlert(
  k8s: K8sClients,
  tenants: Map<string, TenantRef> = new Map(),
): Promise<DashboardAlert | null> {
  const orphans = (await listVolumes(k8s))
    .filter((v) => {
      const ks = v.status?.kubernetesStatus;
      return Boolean(ks?.lastPVCRefAt) && ks?.pvStatus !== 'Bound';
    })
    .map((v) => {
      const ks = v.status?.kubernetesStatus;
      return {
        ...describeVolume(v, tenants),
        volume: v.metadata?.name ?? '(unnamed)',
        pvc: ks?.pvcName ?? null,
        size: toBytes(v.spec?.size),
        actual: toBytes(v.status?.actualSize),
        ageDays: daysSince(ks?.lastPVCRefAt),
      };
    })
    .sort((a, b) => b.actual - a.actual);

  if (orphans.length === 0) return null;
  const reclaimable = orphans.reduce((sum, o) => sum + o.actual, 0);
  const worst = orphans[0];

  return alert({
    categoryId: 'admin.cluster_storage_capacity',
    // Never critical: nothing is failing. It is disk nobody is accounting for.
    severity: 'warning',
    value: `${gib(reclaimable)} GiB`,
    title: orphans.length === 1 ? 'Orphaned volume' : 'Orphaned volumes',
    subtitle: worst.ageDays == null
      ? `${worst.label} · PVC gone`
      : `${worst.label} · PVC gone ${worst.ageDays}d ago`,
    href: '/cluster/storage',
    detail: orphans.slice(0, 5).map((o) => [
      o.pvc ? `${o.label} · ${o.pvc}` : o.label,
      `${gib(o.actual)} GiB on disk${o.ageDays == null ? '' : ` · ${o.ageDays}d`}`,
    ] as [string, string]),
    note: 'These volumes have no PVC and no workload, but still occupy disk. Confirm the data is not needed, then delete them in Longhorn.',
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
