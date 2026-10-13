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
 *   An operation whose liveness lock a process holds is the exception:
 *   it may have been picked up again late (interrupted-ops.ts) and be
 *   working — its age then says nothing. Most interrupted operations
 *   never get this old: that leg picks them up within minutes. What
 *   reaches this one is what it left alone — a move, an operation of a
 *   kind it does not know, one given up as hung.
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
import { storageOperations, storageSnapshots, tenants } from '../../db/schema.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';
import { repinDeployments } from '../tenant-migration/repin.js';
import { settleTenantAfterFailure, unquiesceBestEffort, updateOp, whyWorkloadsStayStopped, withHold } from './service.js';
import { runExclusive } from '../../shared/exclusive-run.js';
import { opLockJob } from './op-lock.js';
import { PLATFORM_TENANT_OPS_NS } from './platform-ns.js';

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

/**
 * Remove what an ended operation left working on the tenant's volume: the
 * filesystem tool's Job, and the Job restoring a bundle into it. Workloads
 * started beside either would be writing to a volume that is being repaired or
 * overwritten. Also the attach each of them made for itself, which no pod can
 * get past. Best-effort, never throws.
 */
async function releaseVolumeFromHelpers(
  k8s: K8sClients,
  op: { readonly tenantId: string; readonly namespace: string; readonly params: Record<string, unknown> | null },
): Promise<void> {
  const batch = k8s.batch as unknown as {
    listNamespacedJob: (a: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }>;
    deleteNamespacedJob: (a: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
  };
  const writers: ReadonlyArray<readonly [string, string]> = [
    [PLATFORM_TENANT_OPS_NS, `platform.io/component=fsck,platform.io/tenant-id=${op.tenantId}`],
    [op.namespace, `platform.io/pre-resize-bundle,platform.io/tenant-id=${op.tenantId}`],
  ];
  for (const [namespace, labelSelector] of writers) {
    try {
      const list = await batch.listNamespacedJob({ namespace, labelSelector });
      for (const job of list.items ?? []) {
        if (job.metadata?.name) await batch.deleteNamespacedJob({ name: job.metadata.name, namespace, propagationPolicy: 'Background' }).catch(() => undefined);
      }
    } catch (err) {
      console.warn(`[quiesce-watchdog] could not list the helper Jobs of tenant ${op.tenantId} in ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const noted = (key: string): string | null => {
    const v = (op.params?.[key] as { volumeName?: unknown } | string | undefined);
    if (typeof v === 'string' && v) return v;
    return v && typeof v === 'object' && typeof v.volumeName === 'string' && v.volumeName ? v.volumeName : null;
  };
  const { releaseLeftoverMaintenanceAttach } = await import('./longhorn-revert.js');
  for (const volume of new Set([noted('volumeName'), noted('retainedVolumeName')].filter((v): v is string => v !== null))) {
    await releaseLeftoverMaintenanceAttach(k8s, volume).catch((err: unknown) => {
      console.warn(`[quiesce-watchdog] could not release the maintenance attach of ${volume}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  const checked = noted('fsckVolume');
  if (checked) {
    const { releaseFsckAttach } = await import('./service.js');
    await releaseFsckAttach(k8s, checked).catch(() => undefined);
  }
}

/**
 * End an operation nobody is working on: mark it failed, start the tenant's
 * workloads again from the replica counts written down when they were stopped,
 * and leave the tenant `failed` (visible, and clear-failed restores too). The
 * admins are told: nobody was watching it.
 *
 * The workloads are NOT started when the operation left the tenant's volume
 * without its files — a shrink ended between deleting the old volume and
 * restoring into the new one (`whyWorkloadsStayStopped`). The tenant then
 * stays stopped and the failure says how to bring the files back.
 *
 * Under the operation's lock, so that one a process is running after all — or
 * is picked up in the same moment — is never ended under its feet. False when
 * it was not ended: the lock is held, or the operation has ended meanwhile.
 * `lastError` may read the state the operation stopped in.
 */
export async function endAbandonedOperation(
  db: Database,
  k8s: K8sClients,
  opId: string,
  lastError: string | ((stoppedIn: string) => string),
): Promise<boolean> {
  const run = await runExclusive(db, opLockJob(opId), async () => {
    const [op] = await db
      .select({
        opType: storageOperations.opType,
        opState: storageOperations.state,
        params: storageOperations.params,
        snapshotId: storageOperations.snapshotId,
        createdAt: storageOperations.createdAt,
        tenantId: storageOperations.tenantId,
        tenantName: tenants.name,
        namespace: tenants.kubernetesNamespace,
        activeOpId: tenants.activeStorageOpId,
      })
      .from(storageOperations)
      .innerJoin(tenants, eq(tenants.id, storageOperations.tenantId))
      .where(and(eq(storageOperations.id, opId), notInArray(storageOperations.state, [...TERMINAL_OP_STATES])));
    if (!op) return false;
    console.warn(
      `[quiesce-watchdog] ${op.opType} op ${opId} stuck in '${op.opState}' — marking failed and restoring workloads (tenant ${op.tenantId})`,
    );
    // Failed first: a process that only stalled reads this before its next
    // step and stops (op-lock.ts).
    const hold = op.namespace
      ? await whyWorkloadsStayStopped(k8s, { opType: op.opType, stoppedIn: op.opState, params: op.params, namespace: op.namespace })
      : null;
    const why = withHold(typeof lastError === 'string' ? lastError : lastError(op.opState), hold);
    await updateOp(db, opId, { state: 'failed', completedAt: new Date(), lastError: why });
    if (op.snapshotId) {
      // The capture the operation was waiting for never arrived.
      await db.update(storageSnapshots)
        .set({ status: 'failed', lastError: why })
        .where(and(eq(storageSnapshots.id, op.snapshotId), eq(storageSnapshots.status, 'creating')))
        .catch(() => undefined);
    }
    if (op.namespace) {
      if (op.opType === 'relocate') {
        await settleAbandonedMove(db, k8s, op.tenantId, op.namespace, op.params);
      } else {
        const { settleInterruptedCaptures } = await import('./prebundle.js');
        await settleInterruptedCaptures(db, k8s, op.tenantId, op.createdAt).catch(() => 0);
        await releaseVolumeFromHelpers(k8s, { tenantId: op.tenantId, namespace: op.namespace, params: op.params });
      }
      // Only touches the tenant if it still points at THIS op — never
      // clobbers a newer, live operation.
      await settleTenantAfterFailure(db, k8s, { opId, tenantId: op.tenantId, namespace: op.namespace }, null, hold);
    } else if (op.activeOpId === opId) {
      await db.update(tenants)
        .set({ storageLifecycleState: 'failed', activeStorageOpId: null })
        .where(and(eq(tenants.id, op.tenantId), eq(tenants.activeStorageOpId, opId)));
    }
    const { notifyAdminOperationalEvent } = await import('../notifications/events.js');
    await notifyAdminOperationalEvent(db, 'integrity', {
      subsystem: 'Storage operations',
      objectLabel: op.tenantName,
      detail: `A ${op.opType} of this tenant had no process working on it and was ended as failed.`,
      severityLabel: hold ? 'failed — tenant left stopped' : 'failed',
      recommendedAction: hold
        ?? 'The tenant\'s workloads were started again. Check the tenant, then use Reset to idle on its Storage Operations card and start the operation again.',
    }, `storage-op-ended:${opId}`).catch((err: unknown) => {
      console.error(`[quiesce-watchdog] could not notify about ended op ${opId}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  });
  return run.ran && run.value;
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
    .select({ opId: storageOperations.id })
    .from(storageOperations)
    .where(and(
      notInArray(storageOperations.state, [...TERMINAL_OP_STATES]),
      or(
        and(ne(storageOperations.opType, 'relocate'), lt(storageOperations.createdAt, cutoff)),
        and(eq(storageOperations.opType, 'relocate'), lt(storageOperations.createdAt, relocateCutoff)),
      ),
    ));

  for (const { opId } of stale) {
    // Old, but somebody may be working on it: an operation picked up again
    // after its first process died holds its lock, and is then not ended. Its
    // lock is given up after six hours of its own, and then this rule applies.
    const ended = await endAbandonedOperation(db, k8s, opId, (stoppedIn) => (
      `Abandoned in state '${stoppedIn}' (platform-api likely restarted mid-operation); watchdog restored the tenant's workloads`
    )).catch((err: unknown) => {
      console.warn(`[quiesce-watchdog] could not end abandoned op ${opId}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    });
    if (ended) abandonedOps += 1;
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
