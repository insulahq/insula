/**
 * Quiesce watchdog — self-heals tenants left scaled to 0.
 *
 * The quiesce→act→unquiesce orchestrators recover their own failures
 * (catch-path unquiesce, persisted-snapshot fallback), but two shapes
 * still stranded tenants DOWN with no automatic path back up
 * (operator report #7, 2026-08-26):
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

import { and, desc, eq, lt, notInArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { storageOperations, tenants } from '../../db/schema.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';
import { unquiesceBestEffort } from './service.js';

/**
 * Ops legitimately run long (a destructive resize streams a full-PVC
 * bundle off-site), so the abandonment cutoff is generous. A genuinely
 * live op also keeps making progress writes; 6h with zero completion is
 * a dead orchestrator, not a slow one.
 */
const ABANDONED_OP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const TERMINAL_OP_STATES = ['idle', 'failed'] as const;

export interface QuiesceWatchdogResult {
  readonly abandonedOps: number;
  readonly recoveredNamespaces: number;
}

export async function sweepAbandonedQuiesce(
  db: Database,
  k8s: K8sClients,
): Promise<QuiesceWatchdogResult> {
  let abandonedOps = 0;
  let recoveredNamespaces = 0;

  // ── Leg A: stale in-flight operations ────────────────────────────
  const cutoff = new Date(Date.now() - ABANDONED_OP_MAX_AGE_MS);
  const stale = await db
    .select({
      opId: storageOperations.id,
      opState: storageOperations.state,
      tenantId: storageOperations.tenantId,
      namespace: tenants.kubernetesNamespace,
      activeOpId: tenants.activeStorageOpId,
    })
    .from(storageOperations)
    .innerJoin(tenants, eq(tenants.id, storageOperations.tenantId))
    .where(and(
      notInArray(storageOperations.state, [...TERMINAL_OP_STATES]),
      lt(storageOperations.createdAt, cutoff),
    ));

  for (const op of stale) {
    abandonedOps += 1;
    console.warn(
      `[quiesce-watchdog] op ${op.opId} stuck in '${op.opState}' past ${ABANDONED_OP_MAX_AGE_MS / 3_600_000}h — marking failed and restoring workloads (tenant ${op.tenantId})`,
    );
    await db.update(storageOperations)
      .set({
        state: 'failed',
        completedAt: new Date(),
        lastError: `Abandoned in state '${op.opState}' (platform-api likely restarted mid-operation); watchdog restored the tenant's workloads`,
      })
      .where(eq(storageOperations.id, op.opId));
    if (op.namespace) {
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
