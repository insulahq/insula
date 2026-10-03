import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants, clusterNodes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { MigrateToWorkerResult } from '@insula/api-contracts';
import { startDataRelocation } from '../tenant-placement/relocate.js';

// M6: minimal tenant migration between workers.
//
// Flow:
//   1. Validate the target worker (must exist in cluster_nodes and
//      carry canHostTenantWorkloads=true).
//   2. Flip tenants.node_name in the DB so future Deployment
//      creates pick the new pin (via M5 plumbing).
//   3. Trigger a rollout-restart on every tenant Deployment in the
//      tenant's namespace so the scheduler re-evaluates with the
//      new nodeSelector.
//
//   4. Move the data: a restarted pod re-attaches the volume on the new
//      node and Longhorn's data locality copies it there; a volume nothing
//      re-attaches (a stopped tenant) is attached on the new node by the
//      platform until the copy is done (tenant-placement/relocate.ts).
//
// Not yet covered (out of M6 scope — future revisit):
//   - DNS record updates. PowerDNS lives in a separate project
//     (ADR-022); the admin runs the DNS update manually for now.
//   - Progress tracking via provisioning_tasks. Current flow is
//     synchronous — the request holds open until all rollouts are
//     triggered. For large tenants that's fine (Deployments don't
//     wait for ready; kubectl just patches the annotation).

/**
 * Re-pin every Deployment in the tenant's namespace to the new
 * worker AND force a new ReplicaSet via a fresh restart annotation.
 * Combined in one patch so pods that restart also pick up the new
 * nodeSelector — pure rollout-restart alone would land pods on the
 * SAME node because the pod template's nodeSelector is unchanged.
 */
async function repinAndRestart(k8s: K8sClients, namespace: string, nodeName: string): Promise<number> {
  // Every Deployment is re-pinned; only the RUNNING ones restart. A file
  // manager idle at 0 replicas counted as "restarted", and a stopped tenant's
  // Move back reported restarted workloads that would carry its data — none.
  let count = 0;
  const now = new Date().toISOString();

  const res = await k8s.apps.listNamespacedDeployment({ namespace });
  for (const deploy of res.items ?? []) {
    const name = deploy.metadata?.name;
    if (!name) continue;
    await k8s.apps.patchNamespacedDeployment({
      name,
      namespace,
      body: {
        spec: {
          template: {
            metadata: {
              annotations: {
                'insula.host/restarted-at': now,
              },
            },
            spec: {
              nodeSelector: { 'kubernetes.io/hostname': nodeName },
            },
          },
        },
      },
    } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0],
      STRATEGIC_MERGE_PATCH);
    if ((deploy.spec?.replicas ?? 1) > 0) count += 1;
  }
  return count;
}

export interface MigrateToWorkerInput {
  readonly nodeName: string;
}


export async function migrateTenantToWorker(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  input: MigrateToWorkerInput,
): Promise<MigrateToWorkerResult> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) {
    throw new ApiError('TENANT_NOT_FOUND', `Tenant '${tenantId}' not found`, 404, { tenant_id: tenantId });
  }

  const [targetNode] = await db.select()
    .from(clusterNodes)
    .where(eq(clusterNodes.name, input.nodeName))
    .limit(1);
  if (!targetNode) {
    throw new ApiError('NODE_NOT_FOUND', `Node '${input.nodeName}' not found`, 404, { node_name: input.nodeName });
  }
  if (!targetNode.canHostTenantWorkloads) {
    throw new ApiError(
      'NODE_NOT_TENANT_CAPABLE',
      `Node '${input.nodeName}' is not tenant-capable (can_host_tenant_workloads=false).`,
      409,
      { node_name: input.nodeName },
    );
  }

  const previousWorker = tenant.nodeName ?? null;

  // Roll the Deployments first. If the k8s patch fails, the DB stays
  // consistent with the old state and the operator sees the error.
  // Only after every Deployment is successfully re-patched do we
  // commit the new pin to the DB — avoids the DB pointing at a
  // worker where no pods actually live.
  const deploymentsRestarted = await repinAndRestart(k8s, tenant.kubernetesNamespace, input.nodeName);

  await db.update(tenants)
    .set({ nodeName: input.nodeName, updatedAt: sql`NOW()` })
    .where(eq(tenants.id, tenantId));

  const dataRelocation = await startDataRelocation(k8s, tenant.kubernetesNamespace, input.nodeName, tenant.storageTier ?? null);

  return {
    tenantId,
    previousWorker,
    currentWorker: input.nodeName,
    deploymentsRestarted,
    dataRelocation,
  };
}
