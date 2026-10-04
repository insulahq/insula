/**
 * Move a RUNNING tenant to another node: stop it, let its volume go, re-pin it,
 * start it there.
 *
 * Re-pinning a running tenant's Deployments rolls them: the new pods land on
 * the target node while the old ones still run on the source, each new pod
 * waits on a Multi-Attach error for the RWO volume, and Longhorn (v1.12,
 * `cleanupForceDeletedPodResources`) deletes the source node's
 * VolumeAttachment as soon as ONE old pod is gone with a zero grace period —
 * while the tenant's other old pods still have the filesystem mounted: the
 * kernel reports the device offline and XFS shuts the filesystem down
 * mid-write.
 *
 * So a move that carries running pods to another node never lets them overlap:
 *   1. quiesce — every Deployment to 0 (the counts recorded on the op and on
 *      each Deployment first), CronJobs suspended;
 *   2. wait until no pod mounts the volume, then until Longhorn reports it
 *      DETACHED — the filesystem is unmounted cleanly on the source;
 *   3. pin every Deployment, and then the tenant row, to the target;
 *   4. attach the volume on the target so its data is copied there
 *      (tenant-placement/relocate.ts);
 *   5. unquiesce — the workloads start on the target, verified available.
 *
 * It runs as a storage operation (`relocate`): mustBeIdle keeps resize,
 * restore and fsck off the volume meanwhile, the Task Tracker chip and the
 * progress modal show it, and quiesce-watchdog brings the workloads back if
 * the process dies mid-move. Any failure starts the workloads again — on the
 * source when the re-pin had not begun, on the target once it is complete.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { MigrateToWorkerResult } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { storageOperations, tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { hasLiveLease } from '../file-manager/lease-annotations.js';
import { quiesce, unquiesce, waitForQuiesced, type QuiesceSnapshot } from '../storage-lifecycle/quiesce.js';
import {
  persistQuiesceSnapshot,
  unquiesceBestEffort,
  updateOp,
  waitForVolumeDetachedByPvc,
} from '../storage-lifecycle/service.js';
import { startDataRelocation } from '../tenant-placement/relocate.js';
import { repinDeployments } from './repin.js';

type DataRelocation = MigrateToWorkerResult['dataRelocation'];

const FILE_MANAGER = 'file-manager';

/** A pod that mounts the tenant's volume. */
export interface VolumeConsumer {
  readonly name: string;
  /** Node the pod is scheduled on; null while it is not scheduled. */
  readonly node: string | null;
  /** Kind of the pod's controller (`ReplicaSet`, `Job`, …); null for a bare pod. */
  readonly ownerKind: string | null;
  /** `platform.io/managed=true` — a tenant CronJob's Job, which quiesce deletes itself. */
  readonly managed: boolean;
}

export type MovePlan =
  /** Nothing running elsewhere: re-pin and restart in place (or nothing to restart). */
  | { readonly kind: 'restart' }
  /** Running pods on another node: stop, move, start. */
  | { readonly kind: 'stop-move-start'; readonly sourceNodes: readonly string[] }
  /** Something a stop would cut off holds the volume: refuse for now. */
  | { readonly kind: 'busy'; readonly holders: readonly string[] };

/**
 * How a move to `target` has to run. Pure.
 *
 * Only a pod scheduled on ANOTHER node makes the move cross nodes; a pod on the
 * target (a "make primary" where it already runs) restarts in place, where the
 * RWO volume is shared by every pod on that node. A backup, restore or other
 * Job holding the volume — or the file manager held by a platform task — would
 * be cut off by the stop, so the move waits for it instead.
 */
export function planTenantMove(
  consumers: readonly VolumeConsumer[],
  target: string,
  fileManagerLeased: boolean,
): MovePlan {
  const away = consumers.filter((c) => c.node !== null && c.node !== target);
  if (away.length === 0) return { kind: 'restart' };
  const holders = consumers
    .filter((c) => c.ownerKind !== 'ReplicaSet' && !c.managed)
    .map((c) => c.name);
  if (fileManagerLeased) holders.push(`${FILE_MANAGER} (held by a platform task)`);
  if (holders.length > 0) return { kind: 'busy', holders };
  return { kind: 'stop-move-start', sourceNodes: [...new Set(away.map((c) => c.node as string))].sort() };
}

export interface MoveFacts {
  readonly consumers: readonly VolumeConsumer[];
  readonly fileManagerLeased: boolean;
  /** Deployments with replicas > 0. */
  readonly runningDeployments: number;
}

/** The namespace's volume consumers and Deployments, read fresh. */
export async function readMoveFacts(k8s: K8sClients, namespace: string, now: number = Date.now()): Promise<MoveFacts> {
  const pvcName = `${namespace}-storage`;
  const [pods, deployments] = await Promise.all([
    k8s.core.listNamespacedPod({ namespace }),
    k8s.apps.listNamespacedDeployment({ namespace }),
  ]);
  const consumers: VolumeConsumer[] = (pods.items ?? [])
    // A finished pod holds no mount; a terminating one still does.
    .filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed')
    .filter((p) => (p.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === pvcName))
    .map((p) => {
      const owners = p.metadata?.ownerReferences ?? [];
      const owner = owners.find((o) => o.controller) ?? owners[0];
      return {
        name: p.metadata?.name ?? '?',
        node: p.spec?.nodeName || null,
        ownerKind: owner?.kind ?? null,
        managed: p.metadata?.labels?.['platform.io/managed'] === 'true',
      };
    });
  const items = deployments.items ?? [];
  const fm = items.find((d) => d.metadata?.name === FILE_MANAGER);
  return {
    consumers,
    fileManagerLeased: hasLiveLease(fm?.metadata?.annotations, now),
    runningDeployments: items.filter((d) => (d.spec?.replicas ?? 1) > 0).length,
  };
}

export type MoveOutcome =
  | { readonly ok: true; readonly message: string; readonly dataRelocation: DataRelocation }
  | { readonly ok: false; readonly error: string; readonly restored: boolean };

/** The side effects of one move, bound to its tenant and operation. */
export interface MoveSteps {
  readonly progress: (state: 'quiescing' | 'unquiescing', pct: number, message: string) => Promise<void>;
  readonly quiesce: () => Promise<QuiesceSnapshot>;
  readonly waitForPodsGone: () => Promise<unknown>;
  readonly waitForDetached: () => Promise<void>;
  readonly repin: (node: string) => Promise<unknown>;
  readonly recordPrimary: () => Promise<void>;
  /** Never throws: a failure is reported in the result. */
  readonly startCopy: () => Promise<DataRelocation>;
  readonly unquiesce: (snap: QuiesceSnapshot) => Promise<void>;
  /** Never throws: true when the workloads came back. */
  readonly restore: (snap: QuiesceSnapshot | null) => Promise<boolean>;
  readonly finish: (outcome: MoveOutcome) => Promise<void>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function successMessage(target: string, copy: DataRelocation): string {
  if (copy.started.length > 0) {
    return `Running on ${target}. Longhorn is copying the data there in the background; `
      + 'the placement view turns green once the copy is done.';
  }
  if (copy.error) {
    return `Running on ${target}. The data copy could not be started (${copy.error}); `
      + `Longhorn moves the data while the tenant runs on ${target}.`;
  }
  return `Running on ${target}.`;
}

/**
 * Stop → detach → re-pin → copy → start, in that order, restoring the
 * workloads on any failure. `sourceNodes` are the node(s) the tenant leaves.
 */
export async function runTenantMove(
  steps: MoveSteps,
  nodes: { readonly sourceNodes: readonly string[]; readonly target: string },
): Promise<void> {
  const { target } = nodes;
  const source = nodes.sourceNodes.join(', ');
  // A tenant already split across nodes is put back on ONE of them: any single
  // node keeps every pod on the same side of the RWO volume.
  const rollbackNode = nodes.sourceNodes[0] ?? target;
  let snap: QuiesceSnapshot | null = null;
  // Where the Deployments are pinned: the source until the re-pin starts, the
  // target once it completes, unknown when it failed part way.
  let pinned: 'source' | 'target' | 'mixed' = 'source';
  let doing = 'stopping the tenant';
  try {
    await steps.progress('quiescing', 5, `Stopping the tenant on ${source}`);
    snap = await steps.quiesce();

    doing = 'waiting for its pods to stop';
    await steps.progress('quiescing', 20, `Waiting for the tenant's pods on ${source} to stop`);
    await steps.waitForPodsGone();

    doing = 'waiting for its volume to detach';
    await steps.progress('quiescing', 35, `Waiting for the volume to detach from ${source}`);
    await steps.waitForDetached();

    doing = `pinning it to ${target}`;
    await steps.progress('quiescing', 50, `Pinning the tenant to ${target}`);
    pinned = 'mixed';
    await steps.repin(target);
    pinned = 'target';
    await steps.recordPrimary();

    doing = 'starting the data copy';
    await steps.progress('quiescing', 60, `Starting the data copy to ${target}`);
    const copy = await steps.startCopy();

    doing = `starting it on ${target}`;
    await steps.progress('unquiescing', 70, `Starting the tenant on ${target}`);
    await steps.unquiesce(snap);

    await steps.finish({ ok: true, message: successMessage(target, copy), dataRelocation: copy });
  } catch (err) {
    const cause = errText(err);
    if (pinned === 'mixed') {
      // Some Deployments may carry the new pin and some the old one; started
      // like that, half the pods would wait on the volume forever. Put them all
      // back where the data still is.
      pinned = await steps.repin(rollbackNode).then(() => 'source' as const, () => 'mixed' as const);
    }
    const restored = await steps.restore(snap);
    const where = pinned === 'target' ? target : pinned === 'source' ? rollbackNode : `${source} and ${target}`;
    const after = restored
      ? `The tenant was started again on ${where}.`
      : `Its workloads could not be started again on ${where}; the workload-health check keeps retrying.`;
    await steps.finish({ ok: false, restored, error: `Moving to ${target} failed while ${doing}: ${cause}. ${after}` });
  }
}

export interface BeginMoveInput {
  readonly tenantId: string;
  readonly namespace: string;
  readonly storageTier: string | null;
  readonly sourceNodes: readonly string[];
  readonly target: string;
  readonly triggeredByUserId: string | null;
}

function bindSteps(db: Database, k8s: K8sClients, input: BeginMoveInput, opId: string): MoveSteps {
  const { tenantId, namespace, target } = input;
  const ours = and(eq(tenants.id, tenantId), eq(tenants.activeStorageOpId, opId));
  return {
    progress: async (state, pct, message) => {
      await updateOp(db, opId, { state, progressPct: pct, progressMessage: message });
      await db.update(tenants).set({ storageLifecycleState: state }).where(ours);
    },
    quiesce: () => quiesce(k8s, namespace, (s) => persistQuiesceSnapshot(db, opId, s)),
    waitForPodsGone: () => waitForQuiesced(k8s, namespace),
    waitForDetached: () => waitForVolumeDetachedByPvc(k8s, namespace, `${namespace}-storage`),
    repin: (node) => repinDeployments(k8s, namespace, node, { restart: false }),
    recordPrimary: async () => {
      await db.update(tenants).set({ nodeName: target, updatedAt: sql`NOW()` }).where(eq(tenants.id, tenantId));
    },
    startCopy: () => startDataRelocation(k8s, namespace, target, input.storageTier),
    unquiesce: (snap) => unquiesce(k8s, namespace, snap),
    restore: (snap) => unquiesceBestEffort(db, k8s, opId, namespace, snap),
    finish: async (outcome) => {
      if (outcome.ok) {
        const [row] = await db.select({ params: storageOperations.params })
          .from(storageOperations).where(eq(storageOperations.id, opId));
        await updateOp(db, opId, {
          state: 'idle',
          progressPct: 100,
          progressMessage: outcome.message,
          completedAt: new Date(),
          params: { ...(row?.params ?? {}), dataRelocation: outcome.dataRelocation },
        });
      } else {
        await updateOp(db, opId, { state: 'failed', lastError: outcome.error, completedAt: new Date() });
      }
      // A failed move whose workloads did not come back stays visible as
      // `failed` (clear-failed restores); otherwise the tenant is free again.
      const state = outcome.ok || outcome.restored ? 'idle' : 'failed';
      await db.update(tenants).set({ storageLifecycleState: state, activeStorageOpId: null }).where(ours);
    },
  };
}

/**
 * Claim the tenant for a move and run it in the background. Returns the
 * storage operation's id. Refused with 409 while another storage operation
 * owns the tenant — the claim is one conditional UPDATE, so two clicks (or two
 * replicas) cannot both start one.
 */
export async function beginTenantMove(db: Database, k8s: K8sClients, input: BeginMoveInput): Promise<string> {
  const opId = randomUUID();
  const source = input.sourceNodes.join(', ');
  await db.transaction(async (tx) => {
    await tx.insert(storageOperations).values({
      id: opId,
      tenantId: input.tenantId,
      opType: 'relocate',
      state: 'quiescing',
      progressPct: 0,
      progressMessage: `Moving the tenant from ${source} to ${input.target}`,
      params: { sourceNodes: [...input.sourceNodes], targetNode: input.target },
      triggeredByUserId: input.triggeredByUserId,
    });
    const claimed = await tx.update(tenants)
      .set({ storageLifecycleState: 'quiescing', activeStorageOpId: opId })
      .where(and(
        eq(tenants.id, input.tenantId),
        isNull(tenants.activeStorageOpId),
        eq(tenants.storageLifecycleState, 'idle'),
      ))
      .returning({ id: tenants.id });
    if (claimed.length === 0) {
      const [cur] = await tx.select({ state: tenants.storageLifecycleState, opId: tenants.activeStorageOpId })
        .from(tenants).where(eq(tenants.id, input.tenantId));
      // Thrown inside the transaction: the op row above is rolled back with it.
      throw new ApiError(
        'STORAGE_OP_IN_PROGRESS',
        `A ${cur?.state ?? 'storage'} operation is already in progress for this tenant; move it once that has finished`,
        409,
        { currentState: cur?.state ?? null, activeOpId: cur?.opId ?? null },
      );
    }
  });
  // Puts the chip in the Task Tracker before the first step runs.
  await updateOp(db, opId, { progressPct: 0 }).catch(() => undefined);

  void runTenantMove(bindSteps(db, k8s, input, opId), { sourceNodes: input.sourceNodes, target: input.target })
    .catch((err) => { console.error(`[tenant-migration] move ${opId} (${input.namespace} → ${input.target}) could not record its outcome:`, err); });
  return opId;
}
