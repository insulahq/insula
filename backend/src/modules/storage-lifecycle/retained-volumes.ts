import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { RetainedVolume, RetainedSnapshot } from '@insula/api-contracts';

/**
 * Retained-volume discovery for the admin "restore from a retained volume"
 * flow.
 *
 * A tenant's `<ns>-storage` PVC is provisioned on the `longhorn-tenant`
 * StorageClass, which is `reclaimPolicy: Retain`. So when a destructive
 * **shrink** deletes the PVC and recreates it smaller, the OLD volume is
 * NOT destroyed — its PV transitions to `Released` and the Longhorn volume
 * stays detached with its snapshots intact. That detached volume is a
 * "retained volume": if a manual snapshot was taken before the shrink, the
 * admin can roll the tenant back onto it (see
 * docs/roadmap/RETAINED_VOLUME_RESTORE.md).
 *
 * This module is the read-only discovery half: list the retained volumes
 * for one tenant and the snapshots available on each. The
 * {@link classifyRetainedVolumes} core is pure so it can be unit-tested
 * without a cluster.
 */

// RetainedVolume / RetainedSnapshot live in @insula/api-contracts (the single
// source of truth for API types) and are re-exported here for internal use.
export type { RetainedVolume, RetainedSnapshot };

// ─── Raw K8s shapes (subset we read) ────────────────────────────────────

interface RawPv {
  readonly metadata?: { readonly name?: string };
  readonly spec?: {
    readonly claimRef?: { readonly namespace?: string };
    readonly capacity?: { readonly storage?: string };
    readonly storageClassName?: string;
  };
  readonly status?: { readonly phase?: string; readonly lastTransitionTime?: string };
}

interface RawLhVolume {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly size?: string | number };
  readonly status?: { readonly kubernetesStatus?: { readonly pvName?: string } };
}

interface RawLhSnapshot {
  readonly metadata?: { readonly name?: string };
  readonly spec?: { readonly volume?: string };
  readonly status?: {
    readonly readyToUse?: boolean;
    // Longhorn reports snapshot size as an int64 → a JSON number.
    readonly size?: string | number;
    readonly creationTime?: string;
  };
}

/** Longhorn's writable head snapshot — never a restore target. */
const VOLUME_HEAD = 'volume-head';

/**
 * Parse a K8s/Longhorn size into bytes. Accepts BOTH a quantity string
 * (`30Gi`, `"1024"`) AND a raw number — Longhorn returns `snapshots.longhorn.io`
 * `status.size` as an int64 (a JSON number), while PV `capacity.storage` and
 * Longhorn `volumes.longhorn.io` `spec.size` are quantity strings.
 */
function parseQuantityBytes(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : 0;
  const match = value.match(/^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!match) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  const num = parseFloat(match[1]);
  const unit = match[2] ?? '';
  const mul: Record<string, number> = {
    '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1000, M: 1000 ** 2, G: 1000 ** 3, T: 1000 ** 4,
  };
  return Math.round(num * (mul[unit] ?? 1));
}

function snapshotEpoch(s: RetainedSnapshot): number {
  if (!s.createdAt) return 0;
  const t = Date.parse(s.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pure core: from raw PV / Longhorn-volume / Longhorn-snapshot lists,
 * return the retained volumes for `namespace`. A retained volume is a
 * **Released** PV claim-reffed to this namespace, backed by a Longhorn
 * volume that is NOT the currently-bound one and carries ≥1 restorable
 * (non-`volume-head`) snapshot. Newest snapshot first within each volume;
 * volumes sorted newest-snapshot first.
 */
export function classifyRetainedVolumes(input: {
  readonly namespace: string;
  readonly boundVolumeName: string | null;
  readonly pvs: readonly RawPv[];
  readonly longhornVolumes: readonly RawLhVolume[];
  readonly snapshots: readonly RawLhSnapshot[];
}): RetainedVolume[] {
  const { namespace, boundVolumeName } = input;

  // pvName → Longhorn volume name. CSI convention is volume name == PV
  // name, but trust the volume CR's kubernetesStatus.pvName when present.
  const lhVolByPv = new Map<string, RawLhVolume>();
  const lhVolByName = new Map<string, RawLhVolume>();
  for (const v of input.longhornVolumes) {
    const name = v.metadata?.name;
    if (!name) continue;
    lhVolByName.set(name, v);
    const pv = v.status?.kubernetesStatus?.pvName;
    if (pv) lhVolByPv.set(pv, v);
  }

  // volume name → restorable snapshots.
  const snapsByVolume = new Map<string, RetainedSnapshot[]>();
  for (const s of input.snapshots) {
    const vol = s.spec?.volume;
    const name = s.metadata?.name;
    if (!vol || !name || name === VOLUME_HEAD) continue;
    const arr = snapsByVolume.get(vol) ?? [];
    arr.push({
      name,
      createdAt: s.status?.creationTime ?? null,
      sizeBytes: parseQuantityBytes(s.status?.size),
      readyToUse: s.status?.readyToUse === true,
    });
    snapsByVolume.set(vol, arr);
  }

  const out: RetainedVolume[] = [];
  for (const pv of input.pvs) {
    const pvName = pv.metadata?.name;
    if (!pvName) continue;
    if (pv.status?.phase !== 'Released') continue;
    if (pv.spec?.claimRef?.namespace !== namespace) continue;

    const lhVol = lhVolByPv.get(pvName) ?? lhVolByName.get(pvName);
    const longhornVolumeName = lhVol?.metadata?.name ?? pvName;
    // Never offer the volume the PVC is currently bound to — that's the
    // in-place revert path, not a retained restore.
    if (boundVolumeName && longhornVolumeName === boundVolumeName) continue;

    const snapshots = (snapsByVolume.get(longhornVolumeName) ?? [])
      .slice()
      .sort((a, b) => snapshotEpoch(b) - snapshotEpoch(a));
    if (snapshots.length === 0) continue;

    out.push({
      pvName,
      longhornVolumeName,
      sizeBytes: parseQuantityBytes(pv.spec?.capacity?.storage)
        || parseQuantityBytes(lhVol?.spec?.size),
      releasedAt: pv.status?.lastTransitionTime ?? null,
      snapshots,
    });
  }

  out.sort((a, b) => snapshotEpoch(b.snapshots[0]) - snapshotEpoch(a.snapshots[0]));
  return out;
}

/** Resolve a tenant to its namespace + canonical storage PVC name. */
async function resolveTenantNamespace(
  db: Database,
  tenantId: string,
): Promise<{ namespace: string; pvcName: string }> {
  const [t] = await db
    .select({ namespace: tenants.kubernetesNamespace })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!t?.namespace) throw new ApiError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`, 404);
  return { namespace: t.namespace, pvcName: `${t.namespace}-storage` };
}

/** The Longhorn volume the tenant's PVC is currently bound to, or null. */
async function readBoundVolume(k8s: K8sClients, namespace: string, pvcName: string): Promise<string | null> {
  try {
    const pvc = await k8s.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
    return (pvc as { spec?: { volumeName?: string } }).spec?.volumeName ?? null;
  } catch {
    return null;
  }
}

/**
 * List the retained (Released, detached) volumes a tenant could be
 * restored from, each with its available snapshots. Read-only.
 *
 * Security: only ever returns volumes whose PV `claimRef.namespace` is
 * THIS tenant's namespace — an admin can never address an arbitrary
 * cluster volume by guessing its name through this surface.
 */
export async function listRetainedVolumesForTenant(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
): Promise<readonly RetainedVolume[]> {
  const { namespace, pvcName } = await resolveTenantNamespace(db, tenantId);

  const [pvList, volList, snapList, boundVolumeName] = await Promise.all([
    k8s.core.listPersistentVolume({}) as Promise<{ items?: readonly RawPv[] }>,
    k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'volumes',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0])
      .catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhVolume[] }>,
    k8s.custom.listNamespacedCustomObject({
      group: 'longhorn.io', version: 'v1beta2',
      namespace: 'longhorn-system', plural: 'snapshots',
    } as unknown as Parameters<typeof k8s.custom.listNamespacedCustomObject>[0])
      .catch(() => ({ items: [] })) as Promise<{ items?: readonly RawLhSnapshot[] }>,
    readBoundVolume(k8s, namespace, pvcName),
  ]);

  return classifyRetainedVolumes({
    namespace,
    boundVolumeName,
    pvs: pvList.items ?? [],
    longhornVolumes: volList.items ?? [],
    snapshots: snapList.items ?? [],
  });
}
