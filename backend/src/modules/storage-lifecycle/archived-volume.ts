/**
 * A storage volume on an archived tenant.
 *
 * Archiving a tenant copies its files off-site and deletes its volume. Until
 * the namespace-integrity sweep learned that (`volumeExpected`), it found the
 * volume "missing" within half an hour and created an empty one in its place —
 * for every tenant ever archived. Those volumes are still there: bound, never
 * mounted, counted against the node's schedulable storage, and of the size
 * the sweep picked, not the size a restore would ask for.
 *
 * This module tells such a volume from one that must be left alone, and
 * removes it. Removing a volume cannot be undone, so the test is not "looks
 * empty" but "was never written to":
 *
 *   - the claim was created after the tenant was archived (the tenant's own
 *     volume was created before, and is the one the archive deleted);
 *   - and more than an hour ago: whatever creates a claim in order to fill it
 *     — a restore, a recovery — has started doing so by then;
 *   - no pod references the claim;
 *   - the claim is not bound to a volume at all, or its Longhorn volume is
 *     detached, has never been referenced by a pod, and holds zero bytes —
 *     Longhorn's `actualSize` counts every block ever written, the
 *     filesystem's own included, and the filesystem is only made at the
 *     first mount.
 *
 * Anything else — a volume from before the archive, one a pod has mounted,
 * one on another storage driver, one that cannot be read — is kept.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { withTenantLock } from '../tenant-lifecycle/tenant-lock.js';

export type ArchivedVolume =
  /** The tenant has no storage claim, as an archived tenant should. */
  | { readonly kind: 'absent' }
  /** Never written to: safe to remove. Its PersistentVolume and Longhorn volume, both null when the claim is unbound. */
  | { readonly kind: 'unused'; readonly pv: string | null; readonly longhornVolume: string | null }
  /** Left alone, and why. */
  | { readonly kind: 'kept'; readonly why: string };

const LONGHORN_DRIVER = 'driver.longhorn.io';

/** A claim younger than this is not judged. */
export const MIN_CLAIM_AGE_MS = 60 * 60 * 1000;

function statusOf(err: unknown): number | undefined {
  return (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
}

async function readOrNull<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

interface Claim {
  readonly metadata?: { readonly creationTimestamp?: Date | string };
  readonly spec?: { readonly volumeName?: string };
}

interface LonghornVolume {
  readonly status?: {
    readonly state?: string;
    readonly actualSize?: number | string;
    readonly kubernetesStatus?: { readonly lastPodRefAt?: string };
  };
}

export const claimNameOf = (namespace: string): string => `${namespace}-storage`;

/** Look at an archived tenant's storage claim. Reads only. */
export async function inspectArchivedVolume(
  k8s: K8sClients,
  namespace: string,
  archivedAt: Date | null,
  nowMs: number = Date.now(),
): Promise<ArchivedVolume> {
  const name = claimNameOf(namespace);
  const claim = await readOrNull(() => k8s.core.readNamespacedPersistentVolumeClaim({ name, namespace }) as Promise<Claim>);
  if (!claim) return { kind: 'absent' };

  if (!archivedAt) return { kind: 'kept', why: 'the tenant has no recorded archive date' };
  const created = claim.metadata?.creationTimestamp ? new Date(claim.metadata.creationTimestamp).getTime() : Number.NaN;
  if (!(created > archivedAt.getTime())) return { kind: 'kept', why: 'the volume is older than the archive' };
  if (!(nowMs - created > MIN_CLAIM_AGE_MS)) return { kind: 'kept', why: 'the volume is less than an hour old' };

  const pods = await k8s.core.listNamespacedPod({ namespace }) as {
    items?: Array<{ spec?: { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }> } }>;
  };
  const mounted = (pods.items ?? []).some((p) => (p.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === name));
  if (mounted) return { kind: 'kept', why: 'a pod uses the volume' };

  const volume = claim.spec?.volumeName;
  if (!volume) return { kind: 'unused', pv: null, longhornVolume: null };

  const pv = await readOrNull(() => k8s.core.readPersistentVolume({ name: volume }) as Promise<{
    spec?: { csi?: { driver?: string; volumeHandle?: string } };
  }>);
  if (pv?.spec?.csi?.driver !== LONGHORN_DRIVER) return { kind: 'kept', why: 'the volume is not a Longhorn volume this check can read' };
  const handle = pv.spec.csi.volumeHandle ?? volume;
  const longhorn = await readOrNull(() => k8s.custom.getNamespacedCustomObject({
    group: 'longhorn.io', version: 'v1beta2', namespace: 'longhorn-system', plural: 'volumes', name: handle,
  }) as Promise<LonghornVolume>);
  if (!longhorn?.status) return { kind: 'kept', why: 'its Longhorn volume could not be read' };

  const { state, actualSize, kubernetesStatus } = longhorn.status;
  if (state !== 'detached') return { kind: 'kept', why: `its Longhorn volume is ${state ?? 'in an unknown state'}` };
  if ((kubernetesStatus?.lastPodRefAt ?? '') !== '') return { kind: 'kept', why: 'a pod has mounted the volume' };
  // `undefined` is not zero: a status without the field proves nothing.
  if (actualSize === undefined || actualSize === '' || Number(actualSize) !== 0) return { kind: 'kept', why: 'the volume has been written to' };
  return { kind: 'unused', pv: volume, longhornVolume: handle };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Remove a claim `inspectArchivedVolume` found unused — and its volume: the
 * tenant storage class retains a volume after its claim, for the tenant data
 * it normally holds. This one holds none.
 */
export async function removeUnusedVolume(
  k8s: K8sClients,
  namespace: string,
  volume: { readonly pv: string | null; readonly longhornVolume: string | null },
  timing: { readonly timeoutMs?: number; readonly pollMs?: number } = {},
): Promise<void> {
  const name = claimNameOf(namespace);
  await readOrNull(() => k8s.core.deleteNamespacedPersistentVolumeClaim({ name, namespace }));
  const deadline = Date.now() + (timing.timeoutMs ?? 60_000);
  while (await readOrNull(() => k8s.core.readNamespacedPersistentVolumeClaim({ name, namespace }))) {
    if (Date.now() >= deadline) throw new Error(`the storage claim ${name} was still there ${Math.round((timing.timeoutMs ?? 60_000) / 1000)} s after it was deleted`);
    await sleep(timing.pollMs ?? 1_000);
  }
  if (!volume.pv && !volume.longhornVolume) return;
  const { deleteOrphan } = await import('../orphaned-volumes/service.js');
  await deleteOrphan(k8s, { pvName: volume.pv, longhornVolumeName: volume.longhornVolume });
}

/**
 * Remove an archived tenant's storage volume when it was never written to.
 * True when one was removed.
 *
 * Under the tenant's lock, and decided again inside it: a restore from the
 * archive creates this very claim, and must not have it deleted from under
 * it. A tenant that is busy is left for the next sweep.
 */
export async function removeArchivedVolumeIfUnused(db: Database, k8s: K8sClients, tenantId: string): Promise<boolean> {
  try {
    // No waiting: this runs in a sweep over every tenant, and a tenant with
    // something going on is not one to tidy up behind.
    return await withTenantLock(db, tenantId, async () => {
      const [tenant] = await db
        .select({
          status: tenants.status,
          state: tenants.storageLifecycleState,
          namespace: tenants.kubernetesNamespace,
          archivedAt: tenants.archivedAt,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId));
      if (!tenant || tenant.status !== 'archived' || tenant.state !== 'idle') return false;
      const found = await inspectArchivedVolume(k8s, tenant.namespace, tenant.archivedAt);
      if (found.kind !== 'unused') return false;
      await removeUnusedVolume(k8s, tenant.namespace, found);
      return true;
    }, { waitMs: 0 });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'TENANT_BUSY') return false;
    throw err;
  }
}
