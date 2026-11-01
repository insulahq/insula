/**
 * Auto: take a tenant's pin off, and move nothing.
 *
 * "Auto" on the Placement card and in the bulk Change placement. It used to
 * write `tenants.node_name = null` and nothing else: the Deployments stayed
 * pinned to the old node and the volume stayed held to it by the node tag a
 * drain or a move had set, so the cluster went on placing the tenant by a pin
 * the platform no longer showed.
 *
 * Now Auto means, all at once:
 *  - the tenant has no primary node (`tenants.node_name` null);
 *  - its volume carries no platform node tag (volume-pin.ts
 *    `releaseTenantVolumes`), so Longhorn may place a copy anywhere;
 *  - on the Local tier its pods stay on one host with its data: they are
 *    pinned to the node holding the volume, and every later render does the
 *    same (pod-placement.ts `resolveAutoPlacement`). For a tenant that is where
 *    it belongs that is the node it runs on, so nothing restarts.
 * An HA tenant's pods keep their soft preference until their next render, which
 * drops it: restarting them to remove a preference would move nothing.
 */
import { eq } from 'drizzle-orm';
import type { UnpinTenantResult } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { resolveTenantDataNode } from '../tenant-placement/data-node.js';
import { HOSTNAME_LABEL } from '../tenant-placement/pod-placement.js';
import { releaseTenantVolumes, undoVolumeHold } from '../tenant-placement/volume-pin.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

/** What putting the cluster on Auto did. */
export interface AutoPlacement {
  readonly runsOn: string | null;
  readonly volumesReleased: string[];
}

/**
 * Put the tenant's cluster objects on Auto (see the header). Throws when the
 * volume or the Deployments cannot be changed, after putting the volumes back.
 */
export async function applyAutoPlacement(
  k8s: K8sClients,
  namespace: string,
  storageTier: string | null,
  previousPin: string | null,
): Promise<AutoPlacement> {
  const hold = await releaseTenantVolumes(k8s, namespace);
  const volumesReleased = hold.changed.map((v) => v.volumeName);
  if (storageTier === 'ha') return { runsOn: null, volumesReleased };

  // Mid-copy the volume has two replicas; the old pin says which one the
  // pods are on.
  const choice = await resolveTenantDataNode(k8s, {
    namespace,
    pvcName: `${namespace}-storage`,
    pinNode: previousPin,
    unambiguousOnly: true,
    logger: { warn: (msg) => console.warn(`[tenant-migration] auto: ${msg}`) },
  });
  if (!choice.node) return { runsOn: null, volumesReleased };
  try {
    await keepDeploymentsOn(k8s, namespace, choice.node);
  } catch (err) {
    const left = await undoVolumeHold(k8s, hold);
    throw new Error(`could not keep the pods on ${choice.node} with the data: ${err instanceof Error ? err.message : String(err)}`
      + (left.length > 0 ? `; and could not put back the volume node tags: ${left.join('; ')}` : ''));
  }
  return { runsOn: choice.node, volumesReleased };
}

/**
 * Pin the Deployments to `node` without restarting anything: only the ones at 0
 * replicas are changed (their next start goes to the data). A running one
 * already runs where the volume is attached, which is `node`; one that does not
 * is left as it is — Auto moves nothing.
 */
async function keepDeploymentsOn(k8s: K8sClients, namespace: string, node: string): Promise<void> {
  const list = await k8s.apps.listNamespacedDeployment({ namespace });
  for (const d of list.items ?? []) {
    const name = d.metadata?.name;
    if (!name || d.spec?.template?.spec?.nodeSelector?.[HOSTNAME_LABEL] === node) continue;
    if ((d.spec?.replicas ?? 1) > 0) {
      console.warn(`[tenant-migration] auto: ${namespace}/${name} runs pinned away from its data on ${node}; left as it is`);
      continue;
    }
    await k8s.apps.patchNamespacedDeployment({
      name,
      namespace,
      body: { spec: { template: { spec: { nodeSelector: { [HOSTNAME_LABEL]: node } } } } },
    } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
      STRATEGIC_MERGE_PATCH);
  }
}

export async function unpinTenant(db: Database, k8s: K8sClients, tenantId: string): Promise<UnpinTenantResult> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) {
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404, { tenant_id: tenantId });
  }
  // A storage operation owns the tenant's workloads and volume; changing their
  // placement under it would change what it restores, and where.
  if (tenant.storageLifecycleState !== 'idle' || tenant.activeStorageOpId) {
    throw new ApiError(
      'STORAGE_OP_IN_PROGRESS',
      `A ${tenant.storageLifecycleState} operation is in progress for this tenant; set it to Auto once that has finished`,
      409,
      { currentState: tenant.storageLifecycleState, activeOpId: tenant.activeStorageOpId ?? null },
    );
  }
  const previousPin = tenant.nodeName ?? null;
  const cluster = tenant.kubernetesNamespace
    ? await applyAutoPlacement(k8s, tenant.kubernetesNamespace, tenant.storageTier ?? null, previousPin)
    : { runsOn: null, volumesReleased: [] };
  // Last, so the row never says Auto while the cluster still holds the pin.
  await db.update(tenants).set({ nodeName: null, updatedAt: new Date() }).where(eq(tenants.id, tenantId));
  return { tenantId, previousPin, runsOn: cluster.runsOn, volumesReleased: cluster.volumesReleased };
}
