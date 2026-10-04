import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants, clusterNodes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { MigrateToWorkerResult } from '@insula/api-contracts';
import { startDataRelocation } from '../tenant-placement/relocate.js';
import { repinDeployments } from './repin.js';
import { beginTenantMove, planTenantMove, readMoveFacts } from './stop-move-start.js';

// M6: minimal tenant migration between workers.
//
// Flow:
//   1. Validate the target worker (must exist in cluster_nodes and
//      carry canHostTenantWorkloads=true).
//   2. A tenant with pods RUNNING on another node is stopped, moved and
//      started again on the target by a background storage operation
//      (stop-move-start.ts): re-pinning it in place would roll its pods
//      across nodes while the old ones still hold the RWO volume, and
//      Longhorn detaches it under them. The response carries the
//      operation's id.
//   3. Otherwise: pin every tenant Deployment to the target and restart
//      the running ones (they restart on the node their data is on), then
//      flip tenants.node_name so future Deployment creates pick the new
//      pin (via M5 plumbing).
//   4. Move the data: a volume nothing re-attaches (a stopped tenant) is
//      attached on the new node by the platform until the copy is done
//      (tenant-placement/relocate.ts).
//
// Not yet covered (out of M6 scope — future revisit):
//   - DNS record updates. PowerDNS lives in a separate project
//     (ADR-022); the admin runs the DNS update manually for now.

export interface MigrateToWorkerInput {
  readonly nodeName: string;
  /** Recorded on the move's storage operation; its Task Tracker chip is shown to this user. */
  readonly triggeredByUserId: string | null;
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

  // A storage operation (resize, restore, fsck, auto-heal, another move) holds
  // the tenant's workloads and volume; re-pinning under it — even a tenant it
  // has already scaled to 0 — would change what it restores, and where.
  if (tenant.storageLifecycleState !== 'idle' || tenant.activeStorageOpId) {
    const state = tenant.storageLifecycleState;
    throw new ApiError(
      'STORAGE_OP_IN_PROGRESS',
      state === 'failed'
        ? 'The last storage operation on this tenant failed; clear its failed storage state before moving it'
        : `A ${state} operation is in progress for this tenant; move it once that has finished`,
      409,
      { currentState: state, activeOpId: tenant.activeStorageOpId ?? null },
    );
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
  const namespace = tenant.kubernetesNamespace;

  const facts = await readMoveFacts(k8s, namespace);
  const plan = planTenantMove(facts.consumers, input.nodeName, facts.fileManagerLeased);
  if (plan.kind === 'busy') {
    throw new ApiError(
      'TENANT_STORAGE_BUSY',
      `The tenant's volume is in use by ${plan.holders.join(', ')}. Moving a running tenant stops it first, `
        + 'which would cut that off — move it once that has finished.',
      409,
      { holders: plan.holders },
    );
  }
  if (plan.kind === 'stop-move-start') {
    const moveOperationId = await beginTenantMove(db, k8s, {
      tenantId,
      namespace,
      storageTier: tenant.storageTier ?? null,
      sourceNodes: plan.sourceNodes,
      target: input.nodeName,
      triggeredByUserId: input.triggeredByUserId,
    });
    return {
      tenantId,
      previousWorker,
      currentWorker: input.nodeName,
      deploymentsRestarted: facts.runningDeployments,
      // Started by the operation once the volume has detached.
      dataRelocation: { started: [], skipped: [], error: null },
      moveOperationId,
    };
  }

  // Roll the Deployments first. If the k8s patch fails, the DB stays
  // consistent with the old state and the operator sees the error.
  // Only after every Deployment is successfully re-patched do we
  // commit the new pin to the DB — avoids the DB pointing at a
  // worker where no pods actually live.
  const deploymentsRestarted = await repinDeployments(k8s, namespace, input.nodeName, { restart: true });

  await db.update(tenants)
    .set({ nodeName: input.nodeName, updatedAt: sql`NOW()` })
    .where(eq(tenants.id, tenantId));

  const dataRelocation = await startDataRelocation(k8s, namespace, input.nodeName, tenant.storageTier ?? null);

  return {
    tenantId,
    previousWorker,
    currentWorker: input.nodeName,
    deploymentsRestarted,
    dataRelocation,
    moveOperationId: null,
  };
}
