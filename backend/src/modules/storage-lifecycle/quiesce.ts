import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

// Scaling/suspending via a strategic-merge PATCH. The previous
// read-modify-replace on the `/scale` subresource
// (`replaceNamespacedDeploymentScale`) silently NO-OPs under
// @kubernetes/client-node v1.x — the serialized body drops `spec.replicas`,
// so the call returns 200 but the Deployment stays at its old replica count.
// That meant quiesce never actually scaled anything to 0 and every
// destructive resize hung at "Scaling workloads to zero" → waitForQuiesced
// timeout. patchNamespacedDeployment with the strategic-merge content-type
// (proven against the live cluster) applies correctly.
type DeploymentPatcher = { patchNamespacedDeployment: (a: { name: string; namespace: string; body: unknown }, o: unknown) => Promise<unknown> };
type CronJobPatcher = { patchNamespacedCronJob: (a: { name: string; namespace: string; body: unknown }, o: unknown) => Promise<unknown> };

async function scaleDeployment(k8s: K8sClients, namespace: string, name: string, replicas: number): Promise<void> {
  await (k8s.apps as unknown as DeploymentPatcher).patchNamespacedDeployment(
    { name, namespace, body: { spec: { replicas } } }, STRATEGIC_MERGE_PATCH,
  );
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
export async function quiesce(k8s: K8sClients, namespace: string): Promise<QuiesceSnapshot> {
  const deployments: Array<{ name: string; replicas: number }> = [];
  const cronJobs: Array<{ name: string; wasSuspended: boolean }> = [];

  // Scale every Deployment in the tenant namespace — tenant namespaces
  // are single-tenant dedicated, and every Deployment there
  // (`platform.io/managed` workloads, `platform.io/system` sidecars
  // like file-manager, etc.) can hold the tenant PVC's RWO lock. An
  // earlier revision narrowed this to `platform.io/managed=true` only,
  // which left file-manager holding the PVC and made `resize` fail
  // with "PVC still exists after 60000ms" when the subsequent delete
  // waited on a finalizer that couldn't release.
  const depList = await (k8s.apps as unknown as {
    listNamespacedDeployment: (args: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string }; spec?: { replicas?: number } }> }>;
  }).listNamespacedDeployment({
    namespace,
  });
  for (const d of depList.items ?? []) {
    const name = d.metadata?.name;
    if (!name) continue;
    const replicas = d.spec?.replicas ?? 0;
    deployments.push({ name, replicas });
    if (replicas > 0) {
      await scaleDeployment(k8s, namespace, name, 0);
    }
  }

  // CronJobs: suspend new triggers (existing Job children are handled
  // separately below).
  const cjList = await (k8s.batch as unknown as {
    listNamespacedCronJob: (args: { namespace: string; labelSelector?: string }) => Promise<{ items?: Array<{ metadata?: { name?: string }; spec?: { suspend?: boolean } }> }>;
  }).listNamespacedCronJob({
    namespace,
  });
  for (const cj of cjList.items ?? []) {
    const name = cj.metadata?.name;
    if (!name) continue;
    const wasSuspended = cj.spec?.suspend ?? false;
    cronJobs.push({ name, wasSuspended });
    if (!wasSuspended) {
      await setCronJobSuspend(k8s, namespace, name, true);
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

  return { deployments, cronJobs };
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
 */
export async function waitForQuiesced(
  k8s: K8sClients,
  namespace: string,
  timeoutMs = 120_000,
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const remaining = await listPods();
    if (remaining.length === 0) return 0;
    if (Date.now() - start > timeoutMs) {
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
