import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants, clusterNodes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

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
// Not yet covered (out of M6 scope — future revisit):
//   - PVC data migration across nodes. Longhorn with replicaCount=1
//     stays on the original node; access from the new worker is
//     cross-node block I/O (functional but slower). Real migration
//     needs a snapshot+restore flow against the new node's disk.
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
                'platform.phoenix-host.net/restarted-at': now,
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
    count += 1;
  }
  return count;
}

export interface MigrateToWorkerInput {
  readonly nodeName: string;
}

export interface MigrateToWorkerResult {
  readonly tenantId: string;
  readonly previousWorker: string | null;
  readonly currentWorker: string;
  readonly deploymentsRestarted: number;
}

export async function migrateTenantToWorker(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  input: MigrateToWorkerInput,
): Promise<MigrateToWorkerResult> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${tenantId}' not found`, 404, { tenant_id: tenantId });
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
      `Node '${input.nodeName}' is not tenant-capable (host_client_workloads=false).`,
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

  return {
    tenantId,
    previousWorker,
    currentWorker: input.nodeName,
    deploymentsRestarted,
  };
}
