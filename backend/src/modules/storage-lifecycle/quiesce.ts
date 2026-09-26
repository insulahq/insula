import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH, MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  scaleDeploymentReplicas,
  STORAGE_QUIESCED_ANNOTATION,
  STORAGE_PREQUIESCE_REPLICAS_ANNOTATION,
} from '../../shared/scale-deployment.js';

// Deployment scaling goes through scaleDeploymentReplicas (raw /scale patch) —
// the typed SDK `patchNamespacedDeployment` serializer DROPS `replicas: 0`,
// so a strategic-merge PATCH to scale-to-0 returns 200 but applies a no-op
// and the Deployment stays at its old replica count. See
// shared/scale-deployment.ts. CronJob suspend / annotation patches still use a
// merge PATCH (their values are not falsy, so the serializer keeps them).
type DeploymentPatcher = { patchNamespacedDeployment: (a: { name: string; namespace: string; body: unknown }, o: unknown) => Promise<unknown> };
type CronJobPatcher = { patchNamespacedCronJob: (a: { name: string; namespace: string; body: unknown }, o: unknown) => Promise<unknown> };

async function scaleDeployment(_k8s: K8sClients, namespace: string, name: string, replicas: number): Promise<void> {
  await scaleDeploymentReplicas(namespace, name, replicas);
}

/**
 * Mark/unmark a Deployment as "held quiesced" so ensureFileManagerRunning
 * won't auto-start it mid-op. Without this, the reactive callers of
 * ensureFileManagerRunning (SFTP gateway, file routes) scale the file-manager
 * back to 1 within ~2s of quiesce scaling it to 0 — fighting quiesce and
 * hanging waitForQuiesced. RFC-7396 merge so `null` deletes the annotation.
 */
async function setQuiesceHold(
  k8s: K8sClients,
  namespace: string,
  name: string,
  held: boolean,
  // The replica count being scaled AWAY from. Recorded next to the hold in the
  // same patch so the two facts can never disagree, and so a tenant stranded at
  // 0 can be restored from the Deployment itself instead of from a guess about
  // which storage operation stranded it. Omitted on release (both are cleared).
  preQuiesceReplicas?: number,
): Promise<void> {
  const annotations: Record<string, string | null> = {
    [STORAGE_QUIESCED_ANNOTATION]: held ? 'true' : null,
    [STORAGE_PREQUIESCE_REPLICAS_ANNOTATION]:
      held && preQuiesceReplicas !== undefined ? String(preQuiesceReplicas) : null,
  };
  await (k8s.apps as unknown as DeploymentPatcher).patchNamespacedDeployment(
    { name, namespace, body: { metadata: { annotations } } },
    MERGE_PATCH,
  );
}

/**
 * Best-effort clear of the quiesce-hold across a namespace.
 *
 * Called by the cancel / clear-failed recovery valves and by quiesce-watchdog
 * Leg B when there is no replica snapshot to restore from, so a force-cancelled
 * op doesn't leave workloads permanently held.
 *
 * Sweeps EVERY held Deployment by default. It used to default to the single
 * name `file-manager`, but `quiesce()` stamps the hold on every Deployment it
 * scales down — so the recovery valves cleared one annotation and left the rest
 * behind. Those leftovers are individually inert (only ensureFileManagerRunning
 * reads the annotation), but they make watchdog Leg B re-report the namespace
 * as held on every sweep forever. Pass `name` to target one Deployment.
 */
export async function clearQuiesceHold(k8s: K8sClients, namespace: string, name?: string): Promise<void> {
  if (name !== undefined) {
    try { await setQuiesceHold(k8s, namespace, name, false); } catch { /* best-effort */ }
    return;
  }
  let held: string[] = [];
  try {
    const list = await (k8s.apps as unknown as {
      listNamespacedDeployment: (a: { namespace: string }) => Promise<{
        items?: Array<{ metadata?: { name?: string; annotations?: Record<string, string> } }>;
      }>;
    }).listNamespacedDeployment({ namespace });
    held = (list.items ?? [])
      .filter((d) => d.metadata?.annotations?.[STORAGE_QUIESCED_ANNOTATION] === 'true')
      .flatMap((d) => (d.metadata?.name ? [d.metadata.name] : []));
  } catch {
    // Can't list — fall back to the one Deployment that is always present and
    // is the only one whose auto-start the annotation actually gates.
    held = ['file-manager'];
  }
  for (const n of held) {
    try { await setQuiesceHold(k8s, namespace, n, false); } catch { /* best-effort */ }
  }
}

async function setCronJobSuspend(k8s: K8sClients, namespace: string, name: string, suspend: boolean): Promise<void> {
  await (k8s.batch as unknown as CronJobPatcher).patchNamespacedCronJob(
    { name, namespace, body: { spec: { suspend } } }, STRATEGIC_MERGE_PATCH,
  );
}

/**
 * Quiesce / unquiesce helpers — scale every platform-managed workload
 * in a tenant namespace to 0 (and back) so that we can safely destroy
 * and recreate the PVC without races against mid-write workloads.
 *
 * Scope: `label platform.io/managed=true`. This matches what the deployer
 * stamps on every Deployment/StatefulSet/CronJob/Job it creates (see
 * `deploymentLabels` in k8s-deployer.ts). CronJob `.spec.suspend` is
 * preferred over scale-to-0 because CronJobs don't expose a replica count;
 * we also suspend them by patching `.spec.suspend = true`.
 */

export interface QuiesceSnapshot {
  readonly deployments: ReadonlyArray<{ name: string; replicas: number }>;
  readonly cronJobs: ReadonlyArray<{ name: string; wasSuspended: boolean }>;
}

/**
 * Scale all platform-managed Deployments to 0 and suspend all
 * platform-managed CronJobs. Returns the prior state so `unquiesce`
 * can restore exactly.
 *
 * Idempotent: calling on an already-quiesced namespace is a no-op.
 * Jobs (one-shot) are NOT touched — their pods finish their own work,
 * and a running Job during a resize would just fail its own retry
 * logic which is acceptable for one-shots.
 */
export async function quiesce(
  k8s: K8sClients,
  namespace: string,
  // Persist the restore-snapshot. Invoked AFTER the current state is captured
  // but BEFORE anything is scaled down, so a force-cancel (or a crash)
  // mid-quiesce always has the data to bring the tenant's workloads back up.
  // The caller passes `(snap) => persistQuiesceSnapshot(db, opId, snap)`.
  persist?: (snap: QuiesceSnapshot) => Promise<void>,
): Promise<QuiesceSnapshot> {
  // ── PHASE 1: capture current state (read-only, NO mutation) ──
  // Capture every Deployment in the tenant namespace — tenant namespaces are
  // single-tenant dedicated, and every Deployment there (`platform.io/managed`
  // workloads, `platform.io/system` sidecars like file-manager, etc.) can hold
  // the tenant PVC's RWO lock. An earlier revision narrowed this to
  // `platform.io/managed=true` only, which left file-manager holding the PVC
  // and made `resize` fail with "PVC still exists after 60000ms".
  const depList = await (k8s.apps as unknown as {
    listNamespacedDeployment: (args: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string }; spec?: { replicas?: number } }> }>;
  }).listNamespacedDeployment({
    namespace,
  });
  const deployments: Array<{ name: string; replicas: number }> = [];
  for (const d of depList.items ?? []) {
    const name = d.metadata?.name;
    if (!name) continue;
    deployments.push({ name, replicas: d.spec?.replicas ?? 0 });
  }

  const cjList = await (k8s.batch as unknown as {
    listNamespacedCronJob: (args: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string }; spec?: { suspend?: boolean } }> }>;
  }).listNamespacedCronJob({
    namespace,
  });
  const cronJobs: Array<{ name: string; wasSuspended: boolean }> = [];
  for (const cj of cjList.items ?? []) {
    const name = cj.metadata?.name;
    if (!name) continue;
    cronJobs.push({ name, wasSuspended: cj.spec?.suspend ?? false });
  }

  const snap: QuiesceSnapshot = { deployments, cronJobs };

  // ── PHASE 2: persist the restore-snapshot BEFORE mutating anything ──
  // Closes the window where a force-cancel found the workloads scaled DOWN
  // with no record of their prior replica counts (the snapshot used to be
  // persisted by the caller only AFTER quiesce returned).
  if (persist) await persist(snap);

  // ── PHASE 3: apply the quiesce (mutations) ──
  for (const d of deployments) {
    if (d.replicas > 0) {
      // Hold BEFORE scaling so a racing ensureFileManagerRunning can't slip a
      // scale-to-1 in between the scale-down and the annotation. The pre-quiesce
      // count goes on in the SAME patch, so a crash between the two can never
      // leave a hold whose replica count is unknown.
      await setQuiesceHold(k8s, namespace, d.name, true, d.replicas);
      await scaleDeployment(k8s, namespace, d.name, 0);
    }
  }

  // CronJobs: suspend new triggers (existing Job children handled below).
  for (const cj of cronJobs) {
    if (!cj.wasSuspended) {
      await setCronJobSuspend(k8s, namespace, cj.name, true);
    }
  }

  // In-flight Jobs (typically CronJob-spawned children, e.g. wp-cron)
  // would otherwise keep their pods alive past our scale-to-0 step and
  // block waitForQuiesced from ever seeing 0 pods. Delete the Job
  // objects with propagation=Background so their pods terminate. These
  // are NOT recorded in QuiesceSnapshot — we don't restore them;
  // CronJobs will re-spawn them after unquiesce.
  const jobList = await (k8s.batch as unknown as {
    listNamespacedJob: (args: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string } }> }>;
  }).listNamespacedJob({
    namespace,
    labelSelector: 'platform.io/managed=true',
  });
  for (const j of jobList.items ?? []) {
    if (!j.metadata?.name) continue;
    try {
      await (k8s.batch as unknown as {
        deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
      }).deleteNamespacedJob({
        name: j.metadata.name, namespace, propagationPolicy: 'Background',
      });
    } catch {
      // already gone — ignore
    }
  }

  return snap;
}

/**
 * Wait until all pods matching `platform.io/managed=true` have actually
 * terminated. Scale-to-0 returns immediately but pods can take 30+s
 * to drain — proceeding before they're gone would mean the PVC's RWO
 * lock prevents our snapshot Job from mounting.
 *
 * Polls every 2 s, gives up after `timeoutMs` (default 120 s) and
 * throws; orchestrator treats that as a quiesce failure and rolls
 * back. Returns the number of pods remaining if successful (should be 0).
 *
 * Force-delete escalation: a PVC-mounting pod can get stuck `Terminating`
 * past its grace period when the Longhorn volume unmount stalls (common on
 * single-node clusters under churn). That keeps the PVC's RWO lock +
 * pvc-protection finalizer and would hang the op until `timeoutMs`. Since
 * quiesce already scaled the owning workload to 0, the pod will NOT be
 * recreated — so once it has had `forceDeleteAfterMs` (default 45 s) to drain
 * gracefully, we force-delete it (gracePeriodSeconds=0) to release the PVC
 * and let the op proceed. Set `forceDeleteAfterMs=0` to disable.
 */
export async function waitForQuiesced(
  k8s: K8sClients,
  namespace: string,
  timeoutMs = 120_000,
  forceDeleteAfterMs = 45_000,
): Promise<number> {
  const start = Date.now();
  // listPods returns the count and the pod-name+phase list for the
  // remaining pods. The names are surfaced in the timeout error so
  // operators can see WHICH workload didn't drain — the original
  // "1 pod(s) still running" was useless when triaging the
  // staging shrink failure.
  type RemainingPod = { name: string; phase: string; owner: string | null };
  // Only a pod that MOUNTS the tenant PVC can hold its RWO lock and block the
  // snapshot/detach. The earlier label filter excluded the file-manager
  // sidecar (which DOES mount the PVC), so it was broadened to "all pods" —
  // but that over-corrected: it then waited on pods that don't touch the PVC
  // at all, e.g. a cert-manager `cm-acme-http-solver` Challenge pod for a
  // tenant domain that can't pass HTTP-01 (it lingers forever). Quiesce hung
  // on it until the timeout and failed the whole resize. Filter by ACTUAL PVC
  // mount instead: file-manager is kept, the solver pod is ignored.
  const pvcName = `${namespace}-storage`;
  const listPods = async (): Promise<RemainingPod[]> => {
    const pods = await k8s.core.listNamespacedPod({ namespace });
    const items = (pods as { items?: Array<{
      metadata?: { name?: string; ownerReferences?: Array<{ kind?: string; name?: string }> };
      status?: { phase?: string };
      spec?: { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }> };
    }> }).items ?? [];
    const mountsTenantPvc = (p: { spec?: { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }> } }) =>
      (p.spec?.volumes ?? []).some((v) => v.persistentVolumeClaim?.claimName === pvcName);
    // Completed Jobs are a no-op for PVC lock — exclude them so we don't hang
    // forever on finished snapshot/restore Jobs.
    return items
      .filter((p) => p.status?.phase !== 'Succeeded' && p.status?.phase !== 'Failed')
      .filter(mountsTenantPvc)
      .map((p) => {
        const owner = p.metadata?.ownerReferences?.[0];
        return {
          name: p.metadata?.name ?? '?',
          phase: p.status?.phase ?? '?',
          owner: owner ? `${owner.kind ?? '?'}/${owner.name ?? '?'}` : null,
        };
      });
  };

  // Track when each lingering pod was first observed so we can force-delete
  // the ones that overstay the grace window. The owning workload is already
  // scaled to 0 (quiesce), so a force-delete never triggers a recreate.
  const firstSeen = new Map<string, number>();
  const forceDeleted = new Set<string>();
  const forceDeletePod = async (name: string): Promise<void> => {
    try {
      await (k8s.core as unknown as {
        deleteNamespacedPod: (a: { name: string; namespace: string; gracePeriodSeconds?: number }) => Promise<unknown>;
      }).deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 });
      console.warn(`[quiesce] force-deleted stuck pod ${namespace}/${name} (did not drain within ${forceDeleteAfterMs}ms after scale-to-0; releasing the tenant PVC lock)`);
    } catch { /* already gone — fine */ }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const remaining = await listPods();
    if (remaining.length === 0) return 0;
    const now = Date.now();
    for (const p of remaining) {
      if (!firstSeen.has(p.name)) firstSeen.set(p.name, now);
      if (forceDeleteAfterMs > 0
        && !forceDeleted.has(p.name)
        && now - (firstSeen.get(p.name) ?? now) >= forceDeleteAfterMs) {
        forceDeleted.add(p.name);
        await forceDeletePod(p.name);
      }
    }
    if (now - start > timeoutMs) {
      const detail = remaining
        .map((r) => `${r.name} (phase=${r.phase}${r.owner ? `, owner=${r.owner}` : ''})`)
        .join('; ');
      throw new Error(
        `quiesce: ${remaining.length} pod(s) still running after ${timeoutMs}ms in ns=${namespace}: ${detail}`,
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * A Deployment that genuinely no longer exists is not a restore failure — the
 * op itself may have removed it. Anything else is.
 *
 * `scaleDeploymentReplicas` throws with the HTTP status in the message (it is a
 * raw https request, not an SDK error object), and `setQuiesceHold` goes
 * through the SDK, so check both shapes.
 */
function isGone(err: unknown): boolean {
  if (err instanceof Error && /HTTP 404\b/.test(err.message)) return true;
  const code = (err as { statusCode?: number; code?: number; response?: { statusCode?: number } } | null);
  return code?.statusCode === 404 || code?.code === 404 || code?.response?.statusCode === 404;
}

/**
 * Restore pre-quiesce replica counts and unsuspend CronJobs.
 *
 * ORDER IS LOAD-BEARING — scale up FIRST, drop the hold annotation SECOND.
 *
 * The hold annotation (`insula.host/storage-quiesced`) is the ONLY marker
 * quiesce-watchdog Leg B uses to find namespaces stranded at 0 replicas. The
 * original order cleared it before the scale-up, so a scale-up that failed
 * (or a pod death in the microseconds between the two calls) left the tenant
 * DOWN with the evidence already erased: Leg B could not see it because the
 * annotation was gone, and Leg A could not see it because the op row had been
 * marked terminal. That is a tenant outage invisible to every recovery path
 * and to the operator — exactly the "it doesn't scale them back up" report.
 * On a failed scale-up we now KEEP the hold, so the watchdog still owns it.
 *
 * Failures are no longer swallowed. The old `catch { /* gone — ignore *\/ }`
 * assumed the only possible cause was a deleted Deployment, but it equally
 * absorbed a 409 conflict, a 5xx, a transient network error, and — the one
 * that actually matters here — a ResourceQuota rejection, which is a routine
 * way for a tenant at its memory ceiling to fail to come back up.
 *
 * Throws if any workload could not be restored, so the caller marks the op
 * FAILED rather than reporting success over a tenant that is still down. The
 * loop always completes first: one unrestorable workload must not stop the
 * rest of the namespace from coming back.
 */
/**
 * How long a restored workload gets to actually become available before the
 * restore is called a failure.
 *
 * Generous because the honest path can be slow: after a quiesce the Longhorn
 * volume has to re-attach, and kubelet's CSI attach backs off exponentially
 * (0.5s → 1s → 2s → 4s → 8s → 16s) against Longhorn's
 * `Aborted: volume is not ready for workloads` while the previous detach
 * settles. Measured on production: 11s in one cycle, 19s in another. An image
 * pull on a cold node is slower still.
 */
const RESTORE_AVAILABLE_TIMEOUT_MS = 5 * 60 * 1000;
const RESTORE_POLL_MS = 3000;

interface DeploymentStatusView {
  readonly desired: number;
  readonly available: number;
  /** ReplicaSet-level refusal to create pods at all — quota is the common one. */
  readonly replicaFailure: string | null;
}

async function readDeploymentStatus(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<DeploymentStatusView | null> {
  try {
    const dep = await (k8s.apps as unknown as {
      readNamespacedDeployment: (a: { name: string; namespace: string }) => Promise<{
        spec?: { replicas?: number };
        status?: { availableReplicas?: number; conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }> };
      }>;
    }).readNamespacedDeployment({ name, namespace });
    const cond = (dep.status?.conditions ?? []).find(
      (c) => c.type === 'ReplicaFailure' && c.status === 'True',
    );
    return {
      desired: dep.spec?.replicas ?? 0,
      available: dep.status?.availableReplicas ?? 0,
      replicaFailure: cond ? `${cond.reason ?? 'ReplicaFailure'}: ${(cond.message ?? '').slice(0, 300)}` : null,
    };
  } catch (err) {
    if (isGone(err)) return null;
    throw err;
  }
}

/**
 * Wait until every named Deployment has at least its target available replicas.
 *
 * ★ THIS IS THE FIX FOR "it doesn't scale them back up". `unquiesce` used to
 * verify its WRITE and not the OUTCOME: a PATCH to the `/scale` subresource
 * returning 200 only means the Deployment's spec changed. Whether a POD ever
 * runs is decided later, by the ReplicaSet, and that is where it fails:
 *
 *   • ResourceQuota is enforced at POD CREATE, not at scale. A terminating pod
 *     still counts against the quota, so a tenant near its memory ceiling
 *     routinely cannot fit its replacements yet — the production tenant that
 *     triggered this work sits at 844Mi of a 1Gi `limits.memory` quota, i.e.
 *     180Mi of headroom for a 4-workload restore. The ReplicaSet records
 *     `ReplicaFailure: FailedCreate: exceeded quota`, the Deployment stays at
 *     `availableReplicas: 0`, and the old code had already reported success.
 *   • the Longhorn volume may refuse to attach (`not ready for workloads`).
 *   • a stale CSI staging dir makes every mount fail forever
 *     (`mkdir …/globalmount: file exists`) — 18h38m of that is what started
 *     this.
 *
 * Because the old code then CLEARED the quiesce-hold annotation, the tenant was
 * left down with no marker any recovery path could see: the op row was terminal
 * so watchdog Leg A skipped it, and the annotation was gone so Leg B could not
 * find it either. Keeping the hold on an unverified restore is what makes the
 * watchdog able to own it.
 *
 * One shared deadline across all workloads, and the scale-ups are issued before
 * any waiting, so a 4-workload namespace takes as long as the slowest — not the
 * sum.
 */
async function waitForRestored(
  k8s: K8sClients,
  namespace: string,
  targets: ReadonlyArray<{ name: string; replicas: number }>,
  timeoutMs: number,
): Promise<{ restored: Set<string>; gone: Set<string>; failures: Map<string, string> }> {
  const restored = new Set<string>();
  const gone = new Set<string>();
  const failures = new Map<string, string>();
  if (targets.length === 0) return { restored, gone, failures };

  const deadline = Date.now() + timeoutMs;
  let pending = targets.filter((t) => t.replicas > 0);
  // replicas === 0 targets need no pod; nothing to wait for.
  for (const t of targets) if (t.replicas <= 0) restored.add(t.name);

  while (pending.length > 0) {
    const still: typeof pending = [];
    for (const t of pending) {
      let view: DeploymentStatusView | null;
      try {
        view = await readDeploymentStatus(k8s, namespace, t.name);
      } catch (err) {
        failures.set(t.name, `status read failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (view === null) { gone.add(t.name); continue; }
      if (view.available >= t.replicas) { restored.add(t.name); continue; }
      // A ReplicaFailure is terminal for this attempt — pods are being refused
      // outright, so waiting out the deadline only delays the report. Name the
      // reason: "exceeded quota" and "volume not ready" need different fixes.
      if (view.replicaFailure) {
        failures.set(t.name, `${view.available}/${t.replicas} available — ${view.replicaFailure}`);
        continue;
      }
      still.push(t);
    }
    pending = still;
    if (pending.length === 0) break;
    if (Date.now() >= deadline) {
      for (const t of pending) {
        const view = await readDeploymentStatus(k8s, namespace, t.name).catch(() => null);
        failures.set(
          t.name,
          `${view?.available ?? 0}/${t.replicas} available after ${Math.round(timeoutMs / 1000)}s`
          + (view?.replicaFailure ? ` — ${view.replicaFailure}` : ''),
        );
      }
      break;
    }
    await new Promise((r) => setTimeout(r, RESTORE_POLL_MS));
  }
  return { restored, gone, failures };
}

/**
 * Restore pre-quiesce replica counts and unsuspend CronJobs.
 *
 * ORDER IS LOAD-BEARING — scale up FIRST, confirm the workload is actually
 * AVAILABLE SECOND, drop the hold annotation THIRD.
 *
 * The hold annotation (`insula.host/storage-quiesced`) is the ONLY marker
 * quiesce-watchdog Leg B uses to find namespaces stranded at 0 replicas. An
 * earlier revision cleared it before the scale-up, so a scale-up that failed
 * left the tenant DOWN with the evidence already erased. That was fixed by
 * reordering — but the check was still "did the PATCH return 2xx", which a
 * quota-rejected or attach-blocked restore passes while no pod ever runs. The
 * hold is now held until `availableReplicas` actually reaches the target, so
 * "restored" means running, not requested. See `waitForRestored`.
 *
 * Failures are not swallowed. The old `catch { /* gone — ignore *\/ }` assumed
 * the only possible cause was a deleted Deployment, but it equally absorbed a
 * 409 conflict, a 5xx, a transient network error, and a ResourceQuota
 * rejection.
 *
 * Throws if any workload could not be restored, so the caller marks the op
 * FAILED rather than reporting success over a tenant that is still down. Every
 * workload is attempted first: one unrestorable workload must not stop the rest
 * of the namespace from coming back.
 */
export async function unquiesce(
  k8s: K8sClients,
  namespace: string,
  snap: QuiesceSnapshot,
  opts: { availableTimeoutMs?: number } = {},
): Promise<void> {
  const failures: string[] = [];
  // ── PHASE 1: issue every scale-up before waiting on any of them ──
  const scaled: Array<{ name: string; replicas: number }> = [];
  const goneEarly = new Set<string>();
  for (const d of snap.deployments) {
    if (d.replicas <= 0) { goneEarly.add(d.name); continue; }
    try {
      await scaleDeployment(k8s, namespace, d.name, d.replicas);
      scaled.push(d);
    } catch (err) {
      if (isGone(err)) { goneEarly.add(d.name); continue; }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[unquiesce] ${namespace}/${d.name} scale->${d.replicas} FAILED: ${msg} — leaving the quiesce-hold in place so the watchdog retries`,
      );
      failures.push(`${d.name}->${d.replicas}: ${msg}`);
    }
  }

  // ── PHASE 2: confirm they are actually RUNNING, not merely requested ──
  const { restored, gone, failures: notAvailable } = await waitForRestored(
    k8s,
    namespace,
    scaled,
    opts.availableTimeoutMs ?? RESTORE_AVAILABLE_TIMEOUT_MS,
  );
  for (const [name, why] of notAvailable) {
    console.error(
      `[unquiesce] ${namespace}/${name} scaled but NEVER BECAME AVAILABLE: ${why} — leaving the quiesce-hold in place so the watchdog retries`,
    );
    failures.push(`${name}: ${why}`);
  }

  // ── PHASE 3: drop the hold only where the workload is back or provably gone ──
  for (const d of snap.deployments) {
    const ok = restored.has(d.name) || gone.has(d.name) || goneEarly.has(d.name);
    if (!ok) continue; // Deliberately keep the hold: it is the watchdog's handle.
    try { await setQuiesceHold(k8s, namespace, d.name, false); } catch { /* gone — ignore */ }
  }

  for (const cj of snap.cronJobs) {
    if (cj.wasSuspended) continue;
    try {
      await setCronJobSuspend(k8s, namespace, cj.name, false);
    } catch (err) {
      if (isGone(err)) continue;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[unquiesce] ${namespace}/${cj.name} unsuspend FAILED: ${msg}`);
      failures.push(`cronjob ${cj.name}: ${msg}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `unquiesce: ${failures.length} workload(s) in ${namespace} could not be restored — the tenant is still scaled down: ${failures.join('; ')}`,
    );
  }
}
