import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH, MERGE_PATCH } from '../../shared/k8s-patch.js';
import { scaleDeploymentReplicas, STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';

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
async function setQuiesceHold(k8s: K8sClients, namespace: string, name: string, held: boolean): Promise<void> {
  await (k8s.apps as unknown as DeploymentPatcher).patchNamespacedDeployment(
    { name, namespace, body: { metadata: { annotations: { [STORAGE_QUIESCED_ANNOTATION]: held ? 'true' : null } } } },
    MERGE_PATCH,
  );
}

/**
 * Best-effort clear of the quiesce-hold on the file-manager Deployment.
 * Called by the cancel / clear-failed recovery valves so a force-cancelled op
 * (which doesn't unquiesce) doesn't leave the file-manager permanently
 * unable to auto-start.
 */
export async function clearQuiesceHold(k8s: K8sClients, namespace: string, name = 'file-manager'): Promise<void> {
  try { await setQuiesceHold(k8s, namespace, name, false); } catch { /* best-effort */ }
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
      // scale-to-1 in between the scale-down and the annotation.
      await setQuiesceHold(k8s, namespace, d.name, true);
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
  // 2026-05-18 staging shrink failure.
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
 * Restore pre-quiesce replica counts and unsuspend CronJobs.
 *
 * Best-effort on each workload: if a Deployment was deleted between
 * quiesce and unquiesce (e.g. platform removed it as part of the op),
 * we skip silently. We don't want one missing workload to block the
 * other 99 % of the namespace from coming back up.
 */
export async function unquiesce(
  k8s: K8sClients,
  namespace: string,
  snap: QuiesceSnapshot,
): Promise<void> {
  for (const d of snap.deployments) {
    // Clear the quiesce-hold first so ensureFileManagerRunning can auto-start
    // the file-manager again once the op is done.
    try { await setQuiesceHold(k8s, namespace, d.name, false); } catch { /* gone — ignore */ }
    if (d.replicas === 0) continue;
    try {
      await scaleDeployment(k8s, namespace, d.name, d.replicas);
    } catch { /* gone — ignore */ }
  }
  for (const cj of snap.cronJobs) {
    if (cj.wasSuspended) continue;
    try {
      await setCronJobSuspend(k8s, namespace, cj.name, false);
    } catch { /* gone — ignore */ }
  }
}
