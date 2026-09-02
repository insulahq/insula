// Status reconciler integration for custom deployments.
//
// Called from the existing `deployments/status-reconciler.ts` loop
// for rows with `source='custom'`. The catalog reconciler resolves
// the catalog entry's component list to figure out what Deployment
// names to check; custom deployments have exactly ONE Deployment
// per row in Phase 1 (the `deployment.name` itself), so we can skip
// that resolver entirely.
//
// Side effects per tick:
//   1. Read the k8s Deployment by name + namespace.
//   2. Translate observed readyReplicas / Pod phases to a DB status.
//   3. Capture the first scheduled node (for the "Node" admin column).
//   4. Record image-audit rows from pod.containerStatuses.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { deployments, tenants } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { recordImageAudit } from './image-audit.js';
import { isNotFound } from '../../shared/k8s-errors.js';
import { notifyAdminCustomDeploymentFailed } from '../notifications/events.js';
import { isOomTermination } from '../../lib/container-termination.js';
import { formatQuotaExceededMessage } from '../deployments/k8s-deployer.js';

const STALE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

// Restarts after which a not-ready container is treated as crash-looping,
// independent of whether this snapshot caught it `waiting` or `terminated`.
// k8s enters CrashLoopBackOff around the 3rd restart; matching that avoids
// flagging a container that legitimately restarts once or twice during startup.
const CRASH_RESTART_THRESHOLD = 3;

type DbStatus = 'running' | 'stopped' | 'pending' | 'failed';

interface ReconcileOutcome {
  readonly status: DbStatus;
  readonly statusMessage: string | null;
  readonly node: string | null;
}

/**
 * Reconcile a single custom-deployment row against the cluster.
 * Returns the desired DB state; the caller persists it. Errors are
 * thrown so the parent reconciler can surface them in its
 * `errors[]` summary.
 */
export async function reconcileCustomRow(
  db: Database,
  k8s: K8sClients,
  row: typeof deployments.$inferSelect,
  namespace: string,
): Promise<ReconcileOutcome> {
  const k8sDeployment = await readDeploymentSafe(k8s, namespace, row.name);

  if (k8sDeployment === null) {
    // Deployment not found in the cluster — either we've just
    // created the DB row and the k8s apply is in flight, or
    // someone deleted the underlying object out-of-band.
    if (row.status === 'deploying' || row.status === 'pending') {
      const age = Date.now() - row.updatedAt.getTime();
      if (age > STALE_TIMEOUT_MS) {
        return {
          status: 'failed',
          statusMessage: 'k8s Deployment was not created within 60 minutes.',
          node: null,
        };
      }
      return { status: row.status as DbStatus, statusMessage: row.statusMessage, node: null };
    }
    return { status: 'failed', statusMessage: 'k8s Deployment is missing.', node: null };
  }

  const ready = k8sDeployment.status?.readyReplicas ?? 0;
  const desired = k8sDeployment.spec?.replicas ?? 1;

  // Capture host node + run audit in parallel with the status read —
  // both are read-only ops and don't depend on the reconcile outcome.
  //
  // The audit must not break reconciliation, but it must not fail SILENTLY
  // either: this was `.catch(() => 0)`, and it swallowed a unique-constraint
  // violation on every 15-second tick for weeks. The symptom surfaced far away
  // — a `:latest` container permanently showing "unknown" update status — with
  // nothing in the logs connecting the two. Log it; keep going.
  const [podObservation] = await Promise.all([
    readFirstPodObservation(k8s, namespace, row.name),
    recordImageAudit(db, k8s, row.id, namespace, row.name).catch((err: unknown) => {
      console.warn(
        `[custom-deployments] image audit failed for ${row.id} (${row.name}): `
        + `${err instanceof Error ? err.message : String(err)} — `
        + 'update status for moving tags will read "unknown" until this succeeds',
      );
      return 0;
    }),
  ]);

  // If the Deployment is at-or-above desired replicas, it's running.
  // If there are SOME ready replicas, it's progressing. Zero ready
  // and at least one Pod in CrashLoopBackOff / ImagePullBackOff is a
  // failure.
  let status: DbStatus;
  let statusMessage: string | null = null;
  if (ready >= desired && desired > 0) {
    status = 'running';
  } else if (podObservation.failureReason) {
    status = 'failed';
    statusMessage = podObservation.failureReason;
  } else if (desired === 0) {
    status = 'stopped';
  } else {
    status = 'pending';
    statusMessage = podObservation.pendingReason ?? null;

    // Every reason above is read off a POD. When the ReplicaSet is refused
    // permission to CREATE the pod — exceeded ResourceQuota, a LimitRange
    // floor/ceiling, Pod Security admission — no Pod object ever exists, so
    // both pod-derived reasons are null and this lands on bare `pending`
    // with NO message. The deployment then sits silent until the 60-minute
    // staleness timeout reports the uninformative "no progress".
    //
    // Observed on production 2026-09-02: a custom container was started
    // whose spec asked for the tenant's entire CPU allowance while a sibling
    // held part of it. The ReplicaSet logged FailedCreate every few seconds;
    // the panel showed no error, no timeout and no feedback of any kind.
    //
    // The catalog reconciler has always read this (k8s-deployer.ts, the
    // FailedCreate/ReplicaSet event scan) — this gives custom deployments
    // the same eyes, reusing its quota-message formatter verbatim.
    //
    // Reported as `failed`, not `pending`: admission refusals do not clear
    // on their own. Something has to change — the request, the quota, or a
    // neighbour — and the operator is the one who has to do it.
    if (!statusMessage) {
      const createFailure = await readReplicaCreateFailure(k8s, namespace, row.name);
      if (createFailure) {
        status = 'failed';
        statusMessage = createFailure;
      }
    }

    // Staleness escalation — same shape as the catalog reconciler.
    if (status === 'pending' && (row.status === 'pending' || row.status === 'deploying')) {
      const age = Date.now() - row.updatedAt.getTime();
      if (age > STALE_TIMEOUT_MS) {
        status = 'failed';
        statusMessage = `Timed out after 60 minutes: ${statusMessage ?? 'no progress'}`;
      }
    }
  }

  return {
    status,
    statusMessage,
    node: podObservation.node,
  };
}

interface PodObservation {
  readonly node: string | null;
  readonly failureReason: string | null;
  readonly pendingReason: string | null;
}

/**
 * Why a ReplicaSet could not CREATE a Pod, or null if it could.
 *
 * Pod-derived diagnostics have a blind spot: an admission refusal (exceeded
 * ResourceQuota, a LimitRange bound, Pod Security) means no Pod object is ever
 * created, so there is nothing to inspect. Kubernetes records it on the
 * ReplicaSet instead — as a `ReplicaFailure` condition and a `FailedCreate`
 * event — and that is the only place the reason exists.
 *
 * Reads the condition first (it is the current state, and survives after the
 * event's TTL expires), falling back to the event for older API behaviour.
 * Quota messages get the same operator-friendly formatting the catalog
 * reconciler already applies.
 *
 * Best-effort: a diagnostic read must never fail a reconcile tick, so any
 * error yields null and the caller keeps its existing verdict.
 */
export async function readReplicaCreateFailure(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
): Promise<string | null> {
  const describe = (raw: string): string =>
    raw.includes('exceeded quota') ? formatQuotaExceededMessage(raw) : raw;

  try {
    const rsList = await k8s.apps.listNamespacedReplicaSet({ namespace }) as unknown as {
      items?: Array<{
        metadata?: { name?: string };
        spec?: { replicas?: number };
        status?: { conditions?: Array<{ type?: string; status?: string; message?: string }> };
      }>;
    };
    // Only ReplicaSets this Deployment currently wants pods from. Scaled-down
    // historical RSs keep stale conditions forever and would resurrect an old
    // failure long after it stopped applying.
    const active = (rsList.items ?? []).filter(
      rs => (rs.metadata?.name ?? '').startsWith(`${deploymentName}-`) && (rs.spec?.replicas ?? 0) > 0,
    );
    for (const rs of active) {
      const cond = (rs.status?.conditions ?? []).find(
        c => c.type === 'ReplicaFailure' && c.status === 'True' && c.message,
      );
      if (cond?.message) return describe(cond.message);
    }
  } catch {
    // fall through to the event scan
  }

  try {
    const events = await k8s.core.listNamespacedEvent({ namespace }) as unknown as {
      items?: Array<{
        reason?: string;
        message?: string;
        involvedObject?: { kind?: string; name?: string };
      }>;
    };
    const failed = (events.items ?? []).find(
      e => e.reason === 'FailedCreate'
        && e.involvedObject?.kind === 'ReplicaSet'
        && (e.involvedObject?.name ?? '').startsWith(`${deploymentName}-`)
        && e.message,
    );
    return failed?.message ? describe(failed.message) : null;
  } catch {
    return null;
  }
}

export async function readFirstPodObservation(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
): Promise<PodObservation> {
  type PodListItem = {
    spec?: { nodeName?: string };
    status?: {
      phase?: string;
      containerStatuses?: Array<{
        name?: string;
        state?: {
          waiting?: { reason?: string; message?: string };
          terminated?: { reason?: string; message?: string; exitCode?: number };
        };
        lastState?: {
          terminated?: { reason?: string; message?: string; exitCode?: number };
        };
        ready?: boolean;
        restartCount?: number;
      }>;
      conditions?: Array<{ type?: string; status?: string; message?: string }>;
    };
  };
  let pods: { items?: PodListItem[] };
  try {
    pods = (await k8s.core.listNamespacedPod({
      namespace,
      labelSelector: `app=${deploymentName}`,
    } as Parameters<typeof k8s.core.listNamespacedPod>[0])) as unknown as { items?: PodListItem[] };
  } catch {
    return { node: null, failureReason: null, pendingReason: null };
  }

  let node: string | null = null;
  let failureReason: string | null = null;
  let pendingReason: string | null = null;
  for (const pod of pods.items ?? []) {
    if (!node && pod.spec?.nodeName) node = pod.spec.nodeName;
    for (const cs of pod.status?.containerStatuses ?? []) {
      const name = cs.name ?? 'container';
      const waitingReason = cs.state?.waiting?.reason;
      // A crash-looping container alternates between `terminated` (just exited)
      // and `waiting` (CrashLoopBackOff). The reconcile takes ONE snapshot, so
      // relying on the instantaneous reason misses the crash whenever it samples
      // the `terminated` half — the status then fell through to 'pending' and the
      // UI showed "Starting…" forever (reproduced on DEV 2026-08-23). Read the
      // termination from state OR lastState, and treat restartCount as the
      // deterministic crash-loop signal so detection no longer depends on timing.
      const terminated = cs.state?.terminated ?? cs.lastState?.terminated;
      const restarts = cs.restartCount ?? 0;

      if (isOomTermination(terminated)) {
        // Check OOM FIRST: an out-of-memory crash-loop shows waiting=CrashLoopBackOff
        // too, but "OOMKilled" is the actionable diagnosis (raise the memory limit),
        // so it must win over the generic backoff message. Classified via the shared
        // helper because the kubelet reports SOME cgroup OOM kills as
        // {exitCode:137, reason:"Error"} — see lib/container-termination.ts.
        failureReason = `${name}: OOMKilled (restart count ${restarts})`;
      } else if (waitingReason && (waitingReason.includes('Err') || waitingReason.includes('BackOff'))) {
        // Explicit CrashLoopBackOff / ImagePullBackOff / ErrImagePull.
        failureReason = `${name}: ${waitingReason} — ${cs.state?.waiting?.message ?? ''}`.trim();
      } else if (!cs.ready && restarts >= CRASH_RESTART_THRESHOLD) {
        // Sampled mid-crash (terminated) or between backoffs: a container that
        // has restarted this many times and still isn't ready is crash-looping,
        // whatever state this snapshot caught. Name the exit code/reason so the
        // operator has something to act on.
        const detail = terminated?.exitCode != null
          ? `last exit ${terminated.exitCode}${terminated.reason ? ` (${terminated.reason})` : ''}`
          : 'repeatedly restarting';
        failureReason = `${name}: CrashLoopBackOff — ${detail}, ${restarts} restarts`;
      } else if (waitingReason && !cs.ready) {
        // ContainerCreating / PodInitializing — genuinely still starting.
        pendingReason = `${name}: ${waitingReason}`;
      }
    }
  }
  return { node, failureReason, pendingReason };
}

interface K8sDeploymentLike {
  status?: { readyReplicas?: number };
  spec?: { replicas?: number };
}

async function readDeploymentSafe(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<K8sDeploymentLike | null> {
  try {
    return (await k8s.apps.readNamespacedDeployment({ name, namespace })) as unknown as K8sDeploymentLike;
  } catch (err) {
    if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return null;
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Apply the reconcile outcome to the DB row. Idempotent — no-op
 *  when nothing changed. */
export async function applyReconcileOutcome(
  db: Database,
  rowId: string,
  current: typeof deployments.$inferSelect,
  outcome: ReconcileOutcome,
): Promise<boolean> {
  const nodeChanged = outcome.node !== (current.currentNodeName ?? null);
  const statusChanged = outcome.status !== current.status;
  const messageChanged = outcome.statusMessage !== (current.statusMessage ?? null);
  if (!nodeChanged && !statusChanged && !messageChanged) return false;
  await db.update(deployments)
    .set({
      status: outcome.status,
      statusMessage: outcome.statusMessage,
      currentNodeName: outcome.node,
    })
    .where(eq(deployments.id, rowId));

  // Notify the operator when a deployment ENTERS the failed state. Fires on the
  // transition (was-not-failed -> failed) so a container that keeps restarting
  // for the same reason does not spam; the dedupeKey (id + reason) also re-alerts
  // only when the failure reason itself changes. Best-effort: a notification
  // hiccup must never break the reconcile tick.
  if (outcome.status === 'failed' && current.status !== 'failed') {
    try {
      const [t] = await db.select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, current.tenantId))
        .limit(1);
      const reason = outcome.statusMessage ?? 'no diagnostic reason reported';
      // dedupe_key is varchar(128): NEVER inline the full reason (it can exceed
      // that and make the delivery INSERT throw, which dispatchSafe swallows — the
      // notification then vanishes silently). Key on the deployment + a short hash
      // of the reason so identical repeats dedupe while a NEW failure reason (or a
      // recovery→failure) re-alerts.
      const reasonHash = createHash('sha1').update(reason).digest('hex').slice(0, 12);
      await notifyAdminCustomDeploymentFailed(
        db,
        current.tenantId,
        { tenantLabel: t?.name ?? current.tenantId, deploymentName: current.name, reason },
        `cdfail:${rowId}:${reasonHash}`,
      );
    } catch {
      // status is already persisted; the notification is advisory.
    }
  }
  return true;
}
