/**
 * Quiesce watchdog — self-heals tenants left scaled to 0.
 *
 * The quiesce→act→unquiesce orchestrators recover their own failures
 * (catch-path unquiesce, persisted-snapshot fallback), but two shapes
 * still stranded tenants DOWN with no automatic path back up
 *
 *
 *   1. platform-api restarted mid-op — orchestration is fire-and-forget
 *      in-process, so the op row stays in a non-terminal state forever
 *      and nobody runs the unquiesce leg.
 *   2. Any historical failure that skipped the unquiesce (pre-fix
 *      releases, force-deleted pods, operator kubectl surgery) — the
 *      hold annotation (`insula.host/storage-quiesced`) is still on the
 *      Deployments while the DB thinks the tenant is idle.
 *
 * Two legs, both best-effort, run from the storage-lifecycle scheduler:
 *
 *   Leg A — stale in-flight ops: any storage_operations row in a
 *   non-terminal state older than ABANDONED_OP_MAX_AGE_MS is marked
 *   failed ("abandoned"), its tenant's workloads are restored from the
 *   op-persisted replica snapshot, and the tenant's lifecycle state is
 *   set to 'failed' (visible + actionable; clear-failed also restores).
 *
 *   Leg B — hold-annotation leftovers: one cluster-wide Deployment LIST
 *   finds hold-annotated Deployments; any belonging to an ACTIVE tenant
 *   with NO in-flight op gets unquiesced from that tenant's most recent
 *   op snapshot (or at minimum the holds cleared). Suspended/archived
 *   tenants are skipped — quiesced-at-0 is their designed state.
 */

import { and, desc, eq, lt, ne, notInArray, or } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { storageOperations, tenants } from '../../db/schema.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';
import { repinDeployments } from '../tenant-migration/repin.js';
import { unquiesceBestEffort } from './service.js';

/**
 * Ops legitimately run long (a destructive resize streams a full-PVC
 * bundle off-site), so the abandonment cutoff is generous. A genuinely
 * live op also keeps making progress writes; 6h with zero completion is
 * a dead orchestrator, not a slow one.
 */
const ABANDONED_OP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * A move (`relocate`, tenant-migration/stop-move-start.ts) keeps the tenant
 * down for its whole run, and a live one is done in about ten minutes: its
 * pods drain within 2, the volume detaches within 2, the workloads start
 * within 5. Waiting the general 6h would leave a tenant down for hours after a
 * restart mid-move.
 */
const ABANDONED_RELOCATE_MAX_AGE_MS = 30 * 60 * 1000;

const TERMINAL_OP_STATES = ['idle', 'failed'] as const;

export interface QuiesceWatchdogResult {
  readonly abandonedOps: number;
  readonly recoveredNamespaces: number;
}

/**
 * Make an abandoned move's pins agree before its workloads are started again.
 *
 * A move re-pins the Deployments one by one, and only once every workload is
 * at 0 and the volume has detached. A process that died part way through left
 * some pinned to the target and some to the source; started like that, pods on
 * two nodes would contend for the RWO volume. So when every Deployment is at
 * 0, pin them all — and the tenant row — to the move's target, completing the
 * move. When any is still running, the re-pin never began and the pins are
 * as they were: re-pinning a running Deployment would roll it across nodes,
 * which is exactly what the move exists to avoid. Never throws.
 */
async function settleAbandonedMove(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  namespace: string,
  params: Record<string, unknown> | null,
): Promise<void> {
  const target = params?.targetNode;
  if (typeof target !== 'string' || target === '') return;
  try {
    const list = await k8s.apps.listNamespacedDeployment({ namespace });
    if ((list.items ?? []).some((d) => (d.spec?.replicas ?? 1) > 0)) return;
    await repinDeployments(k8s, namespace, target, { restart: false });
    await db.update(tenants).set({ nodeName: target }).where(eq(tenants.id, tenantId));
  } catch (err) {
    console.warn(`[quiesce-watchdog] could not settle the pins of an abandoned move in ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function sweepAbandonedQuiesce(
  db: Database,
  k8s: K8sClients,
): Promise<QuiesceWatchdogResult> {
  let abandonedOps = 0;
  let recoveredNamespaces = 0;

  // ── Leg A: stale in-flight operations ────────────────────────────
  const cutoff = new Date(Date.now() - ABANDONED_OP_MAX_AGE_MS);
  const relocateCutoff = new Date(Date.now() - ABANDONED_RELOCATE_MAX_AGE_MS);
  const stale = await db
    .select({
      opId: storageOperations.id,
      opType: storageOperations.opType,
      opState: storageOperations.state,
      params: storageOperations.params,
      tenantId: storageOperations.tenantId,
      namespace: tenants.kubernetesNamespace,
      activeOpId: tenants.activeStorageOpId,
    })
    .from(storageOperations)
    .innerJoin(tenants, eq(tenants.id, storageOperations.tenantId))
    .where(and(
      notInArray(storageOperations.state, [...TERMINAL_OP_STATES]),
      or(
        and(ne(storageOperations.opType, 'relocate'), lt(storageOperations.createdAt, cutoff)),
        and(eq(storageOperations.opType, 'relocate'), lt(storageOperations.createdAt, relocateCutoff)),
      ),
    ));

  for (const op of stale) {
    abandonedOps += 1;
    console.warn(
      `[quiesce-watchdog] ${op.opType} op ${op.opId} stuck in '${op.opState}' — marking failed and restoring workloads (tenant ${op.tenantId})`,
    );
    await db.update(storageOperations)
      .set({
        state: 'failed',
        completedAt: new Date(),
        lastError: `Abandoned in state '${op.opState}' (platform-api likely restarted mid-operation); watchdog restored the tenant's workloads`,
      })
      .where(eq(storageOperations.id, op.opId));
    if (op.namespace) {
      if (op.opType === 'relocate') await settleAbandonedMove(db, k8s, op.tenantId, op.namespace, op.params);
      await unquiesceBestEffort(db, k8s, op.opId, op.namespace, null);
    }
    // Only touch the tenant pointer if it still references THIS op —
    // never clobber a newer, live operation.
    if (op.activeOpId === op.opId) {
      await db.update(tenants)
        .set({ storageLifecycleState: 'failed', activeStorageOpId: null })
        .where(eq(tenants.id, op.tenantId));
    }
  }

  // ── Leg B: hold-annotation leftovers ─────────────────────────────
  let deployments: Array<{ namespace: string }> = [];
  try {
    const list = await (k8s.apps as unknown as {
      listDeploymentForAllNamespaces: (a?: { labelSelector?: string }) => Promise<{
        items?: Array<{ metadata?: { namespace?: string; annotations?: Record<string, string> } }>;
      }>;
    }).listDeploymentForAllNamespaces({});
    deployments = (list.items ?? [])
      .filter((d) => d.metadata?.annotations?.[STORAGE_QUIESCED_ANNOTATION] === 'true')
      .flatMap((d) => (d.metadata?.namespace ? [{ namespace: d.metadata.namespace }] : []));
  } catch (err) {
    console.warn(`[quiesce-watchdog] cluster-wide Deployment list failed: ${err instanceof Error ? err.message : String(err)}`);
    return { abandonedOps, recoveredNamespaces };
  }

  const heldNamespaces = [...new Set(deployments.map((d) => d.namespace))];
  for (const ns of heldNamespaces) {
    const [tenant] = await db
      .select({
        id: tenants.id,
        status: tenants.status,
        lifecycleState: tenants.storageLifecycleState,
        activeOpId: tenants.activeStorageOpId,
      })
      .from(tenants)
      .where(eq(tenants.kubernetesNamespace, ns))
      .limit(1);
    // Unknown ns → not ours. Non-active tenant → quiesced by design
    // (suspend/archive). In-flight op → the orchestrator owns the hold.
    if (!tenant) continue;
    if (tenant.status !== 'active') continue;
    if (tenant.activeOpId != null) continue;
    if (tenant.lifecycleState !== 'idle' && tenant.lifecycleState !== 'failed') continue;

    const [latestOp] = await db
      .select({ id: storageOperations.id })
      .from(storageOperations)
      .where(eq(storageOperations.tenantId, tenant.id))
      .orderBy(desc(storageOperations.createdAt))
      .limit(1);
    console.warn(
      `[quiesce-watchdog] tenant ${tenant.id} (${ns}) has quiesce-held workloads with no in-flight op — restoring`,
    );
    if (latestOp) {
      await unquiesceBestEffort(db, k8s, latestOp.id, ns, null);
    } else {
      const { clearQuiesceHold } = await import('./quiesce.js');
      await clearQuiesceHold(k8s, ns);
    }
    recoveredNamespaces += 1;
  }

  return { abandonedOps, recoveredNamespaces };
}
