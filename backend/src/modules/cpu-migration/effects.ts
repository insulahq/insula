/**
 * The cluster and database side of a CPU-tier migration (ADR-062 R2).
 *
 * Thin by design. Every decision — ordering, gating, stopping, what a partial
 * run means — lives in apply.ts/plan.ts/health-gate.ts where it is unit
 * tested without a cluster. This file only does what it is told, and is
 * exercised by the DEV end-to-end run.
 */

import { eq, and, ne, isNull } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { TENANT_DEFAULT_PRIORITY_CLASS } from '../k8s-provisioner/service.js';
import { deployments, tenants, tasks } from '../../db/schema.js';
import { type CpuTier } from '@insula/api-contracts';
import { buildTenantLimitRange, buildTieredQuotaHard, type PodCpuLimitFact } from './tiered-namespace.js';
import type { WorkloadReadiness } from './health-gate.js';
import * as taskService from '../tasks/service.js';
import { MERGE_PATCH, STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

const limitRangeName = (ns: string) => `${ns}-cpu`;
const quotaName = (ns: string) => `${ns}-quota`;

function is404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  return (err as { statusCode?: number })?.statusCode === 404;
}
function is409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  return (err as { statusCode?: number })?.statusCode === 409;
}

export async function ensureLimitRange(
  k8s: K8sClients, namespace: string, tier: CpuTier, burstCores: number,
): Promise<void> {
  // Read what the namespace already declares BEFORE installing the range, so
  // `max` cannot invalidate a pod that is running right now.
  const largestDeclaredMillis = await largestDeclaredCpuMillis(k8s, namespace);
  const body = buildTenantLimitRange({ namespace, tier, burstCores, largestDeclaredMillis });
  try {
    await k8s.core.createNamespacedLimitRange({ namespace, body } as never);
  } catch (err) {
    if (!is409(err)) throw err;
    await k8s.core.replaceNamespacedLimitRange({
      name: limitRangeName(namespace), namespace, body,
    } as never);
  }
}

/** Parse a Kubernetes CPU quantity ("2", "300m") into millicores. */
export function quantityToMillis(v: string | undefined | null): number {
  if (!v) return 0;
  const s = String(v).trim();
  if (s.endsWith('m')) return Math.round(Number(s.slice(0, -1)) || 0);
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

/**
 * The biggest CPU any live container in the namespace declares — request OR
 * limit, whichever is larger, since a LimitRange `max` constrains both.
 */
export async function largestDeclaredCpuMillis(
  k8s: K8sClients, namespace: string,
): Promise<number> {
  const list = await k8s.core.listNamespacedPod({ namespace }) as {
    items?: ReadonlyArray<{
      spec?: { containers?: ReadonlyArray<{ resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }>;
               initContainers?: ReadonlyArray<{ resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }> };
      status?: { phase?: string };
    }>;
  };
  let max = 0;
  for (const p of list.items ?? []) {
    const phase = p.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    for (const c of [...(p.spec?.containers ?? []), ...(p.spec?.initContainers ?? [])]) {
      max = Math.max(max, quantityToMillis(c.resources?.requests?.cpu), quantityToMillis(c.resources?.limits?.cpu));
    }
  }
  return max;
}

/** What a single in-scope POD requests at most — the surge allowance. */
export async function largestInScopePodMillis(
  k8s: K8sClients, namespace: string, priorityClass: string,
): Promise<number> {
  const list = await k8s.core.listNamespacedPod({ namespace }) as {
    items?: ReadonlyArray<{
      spec?: { priorityClassName?: string; containers?: ReadonlyArray<{ resources?: { requests?: Record<string, string> } }> };
      status?: { phase?: string };
    }>;
  };
  let max = 0;
  for (const p of list.items ?? []) {
    const phase = p.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    if ((p.spec?.priorityClassName ?? null) !== priorityClass) continue;
    const sum = (p.spec?.containers ?? [])
      .reduce((a, c) => a + quantityToMillis(c.resources?.requests?.cpu), 0);
    max = Math.max(max, sum);
  }
  return max;
}

export async function limitRangeExists(k8s: K8sClients, namespace: string): Promise<boolean> {
  try {
    await k8s.core.readNamespacedLimitRange({ name: limitRangeName(namespace), namespace } as never);
    return true;
  } catch (err) {
    if (is404(err)) return false;
    // ★ An unreadable API is NOT an absent LimitRange. Returning false would
    // be merely wrong; returning TRUE on an error would let the quota ceiling
    // go on over a namespace that may have none.
    throw err;
  }
}

export async function removeLimitRange(k8s: K8sClients, namespace: string): Promise<void> {
  try {
    await k8s.core.deleteNamespacedLimitRange({ name: limitRangeName(namespace), namespace } as never);
  } catch (err) {
    if (!is404(err)) throw err;
  }
}

/** Every pod in the namespace, with the two facts the readiness gate needs. */
export async function readPodCpuLimits(
  k8s: K8sClients, namespace: string,
): Promise<PodCpuLimitFact[]> {
  const list = await k8s.core.listNamespacedPod({ namespace }) as {
    items?: ReadonlyArray<{
      metadata?: { name?: string; ownerReferences?: ReadonlyArray<unknown>; deletionTimestamp?: string };
      spec?: {
        priorityClassName?: string;
        containers?: ReadonlyArray<{ name?: string; resources?: { limits?: Record<string, string> } }>;
        initContainers?: ReadonlyArray<{ name?: string; resources?: { limits?: Record<string, string> } }>;
      };
      status?: { phase?: string };
    }>;
  };
  const out: PodCpuLimitFact[] = [];
  for (const p of list.items ?? []) {
    // A finished pod cannot be refused by a quota it no longer needs.
    const phase = p.status?.phase;
    if (phase === 'Succeeded' || phase === 'Failed') continue;
    /**
     * ★ A TERMINATING pod still reports phase "Running".
     *
     * Found by the end-to-end run: the straggler sweep replaced a limitless
     * pod correctly, the replacement came up carrying its ceiling — and the
     * readiness check still refused, because the pod being replaced was
     * mid-termination and counted as one more pod without a limit. The
     * migration blocked on the corpse of the problem it had just fixed.
     *
     * A pod with a deletionTimestamp is leaving and will never be admitted
     * again, so it cannot be the reason a future pod is refused. It is the
     * question the check asks, so it is the pod the check must ignore.
     */
    if (p.metadata?.deletionTimestamp) continue;
    const all = [...(p.spec?.containers ?? []), ...(p.spec?.initContainers ?? [])];
    out.push({
      podName: p.metadata?.name ?? '(unnamed)',
      priorityClassName: p.spec?.priorityClassName ?? null,
      hasController: (p.metadata?.ownerReferences?.length ?? 0) > 0,
      containersWithoutCpuLimit: all
        .filter((c) => !c.resources?.limits?.cpu)
        .map((c) => c.name ?? '(unnamed)'),
    });
  }
  return out;
}

/**
 * Deployments AND StatefulSets.
 *
 * Tenant workloads are all Deployments today (checked on production: 67
 * Deployments, 0 StatefulSets). Listing both anyway costs one API call and
 * removes a silent failure: a StatefulSet the gate cannot see is one it never
 * waits for, so the migration would march on through a database that never
 * came back.
 */
export async function readWorkloads(
  k8s: K8sClients, namespace: string,
): Promise<WorkloadReadiness[]> {
  const [deploys, statefulSets] = await Promise.all([
    readWorkloadList(() => k8s.apps.listNamespacedDeployment({ namespace })),
    readWorkloadList(() => k8s.apps.listNamespacedStatefulSet({ namespace })),
  ]);
  return [...deploys, ...statefulSets];
}

async function readWorkloadList(
  fetch: () => Promise<unknown>,
): Promise<WorkloadReadiness[]> {
  const list = await fetch() as {
    items?: ReadonlyArray<{
      metadata?: { name?: string };
      spec?: { replicas?: number };
      status?: {
        readyReplicas?: number;
        conditions?: ReadonlyArray<{ type?: string; status?: string; message?: string; reason?: string }>;
      };
    }>;
  };
  return (list.items ?? []).map((d) => {
    const failure = (d.status?.conditions ?? [])
      .find((c) => c.type === 'ReplicaFailure' && c.status === 'True');
    return {
      name: d.metadata?.name ?? '(unnamed)',
      desiredReplicas: d.spec?.replicas ?? 0,
      readyReplicas: d.status?.readyReplicas ?? 0,
      failureMessage: failure ? (failure.message ?? failure.reason ?? 'ReplicaFailure') : null,
    };
  });
}

/**
 * Put the tiered numbers on the EXISTING tenant quota.
 *
 * A read-modify-write rather than a blind replace: the quota also carries
 * memory and a scopeSelector that is immutable after creation, so rebuilding
 * it from scratch would either lose the scope or force a delete/recreate that
 * leaves the namespace briefly unbounded.
 */
export async function applyQuotaLimits(
  k8s: K8sClients, namespace: string, burstCores: number, tiers: readonly CpuTier[],
  priorityClass: string,
): Promise<void> {
  const name = quotaName(namespace);
  const live = await k8s.core.readNamespacedResourceQuota({ name, namespace } as never) as {
    spec?: { hard?: Record<string, string> };
    status?: { used?: Record<string, string> };
  };
  // Ground truth, not a projection: `status.used` is what the API server
  // itself counts against this quota right now.
  const liveUsedMillis = quantityToMillis(live.status?.used?.['requests.cpu']);
  const largestPodMillis = await largestInScopePodMillis(k8s, namespace, priorityClass);
  const hard = buildTieredQuotaHard({ tiers, burstCores, liveUsedMillis, largestPodMillis });
  // MERGE_PATCH, not the client's default json-patch: the body is a merge
  // object, and the default would be rejected as a malformed op array.
  await k8s.core.patchNamespacedResourceQuota(
    { name, namespace, body: { spec: { hard: { ...live.spec?.hard, ...hard } } } } as never,
    MERGE_PATCH,
  );
}

/**
 * Raise `requests.cpu` so a replacement pod fits alongside the one it is
 * replacing. Never lowers it — this runs before anything shrinks.
 *
 * Only `requests.cpu` moves; `limits.cpu` is NOT added here. Adding it before
 * the pods carry limits is the armed trap assessLimitsCpuReadiness exists to
 * prevent, so the ceiling still waits for the end.
 */
export async function widenQuotaHeadroom(
  k8s: K8sClients, namespace: string, priorityClass: string,
): Promise<void> {
  const name = quotaName(namespace);
  const live = await k8s.core.readNamespacedResourceQuota({ name, namespace } as never) as {
    spec?: { hard?: Record<string, string> };
    status?: { used?: Record<string, string> };
  };
  const currentHard = quantityToMillis(live.spec?.hard?.['requests.cpu']);
  const used = quantityToMillis(live.status?.used?.['requests.cpu']);
  const largestPod = await largestInScopePodMillis(k8s, namespace, priorityClass);
  // Room for the biggest single pod to exist twice over, on top of what is
  // already held — one replacement in flight, with margin.
  const wanted = used + Math.max(largestPod, 100);
  if (wanted <= currentHard) return; // already roomy enough; do not touch it
  await k8s.core.patchNamespacedResourceQuota(
    { name, namespace, body: { spec: { hard: { 'requests.cpu': `${wanted}m` } } } } as never,
    MERGE_PATCH,
  );
}

/** Take the ceiling back off, leaving the legacy requests.cpu untouched. */
export async function removeQuotaLimits(
  k8s: K8sClients, namespace: string, legacyCpuCores: number,
): Promise<void> {
  const name = quotaName(namespace);
  // The same freeze applies in reverse. A revert RESTORES larger requests, so
  // `used` climbs as it runs; writing the legacy figure blindly can land
  // below it and leave the tenant unable to create a pod — during the
  // operation whose whole purpose is to put things back.
  const live = await k8s.core.readNamespacedResourceQuota({ name, namespace } as never) as {
    status?: { used?: Record<string, string> };
  };
  const usedMillis = quantityToMillis(live.status?.used?.['requests.cpu']);
  const legacyMillis = Math.round(legacyCpuCores * 1000);
  const restored = Math.max(legacyMillis, usedMillis);
  await k8s.core.patchNamespacedResourceQuota(
    {
      name, namespace,
      // null DELETES a key under RFC 7396 — the only way to drop limits.cpu
      // without rewriting the whole object, whose scopeSelector is immutable.
      body: { spec: { hard: { 'limits.cpu': null, 'requests.cpu': `${restored}m` } } },
    } as never,
    MERGE_PATCH,
  );
}

/**
 * Re-admit a deployment's pods WITHOUT changing what they ask for.
 *
 * ★ A rolling update, not a delete, and on a tight node that is the whole
 * difference between safe and an outage.
 *
 * Deleting the pod frees its request and then asks the ReplicaSet for a new
 * one — a single-replica tenant app is DOWN for the gap, and if the
 * replacement cannot be scheduled it stays down. Production runs at 98%
 * reserved with ~0.2 cores spare, so "cannot be scheduled" is a live
 * possibility, and the tenants being migrated are mostly single-replica
 * websites.
 *
 * Bumping a pod-template annotation instead makes Kubernetes roll the
 * deployment: the new pod is created FIRST and the old one is kept until it
 * is Ready. If the new pod cannot schedule, the rollout stalls with the old
 * pod still serving — the migration fails, the tenant stays up. That is the
 * failure we want.
 *
 * The annotation value is the TIER, not a timestamp, so re-running is a
 * genuine no-op rather than a fresh rollout each time.
 */
export async function recreatePods(
  k8s: K8sClients, namespace: string, deploymentName: string, tier: CpuTier,
): Promise<void> {
  await k8s.apps.patchNamespacedDeployment(
    {
      name: deploymentName,
      namespace,
      body: {
        spec: {
          template: {
            metadata: { annotations: { 'insula.host/cpu-tier': tier } },
          },
        },
      },
    } as never,
    STRATEGIC_MERGE_PATCH,
  );
}

/**
 * Roll every Deployment whose pods still declare a CPU limit, by clearing the
 * tier annotation. Returns how many were rolled.
 *
 * Called on revert AFTER the LimitRange is gone, so the replacement pods are
 * admitted with no ceiling at all — which is what legacy means.
 */
export async function rollPodsStillCapped(
  k8s: K8sClients, namespace: string, priorityClass: string,
): Promise<number> {
  const pods = await readPodCpuLimits(k8s, namespace);
  const capped = new Set<string>();
  for (const p of pods) {
    if (p.priorityClassName !== priorityClass) continue;
    // A pod with NO uncapped container is one every container of which
    // carries a limit — i.e. it was admitted under the LimitRange.
    if (p.containersWithoutCpuLimit.length === 0) capped.add(p.podName);
  }
  if (capped.size === 0) return 0;

  const list = await k8s.apps.listNamespacedDeployment({ namespace }) as {
    items?: ReadonlyArray<{ metadata?: { name?: string; annotations?: Record<string, string>;
      labels?: Record<string, string> }; spec?: { template?: { metadata?: { annotations?: Record<string, string> } } } }>;
  };
  let rolled = 0;
  for (const d of list.items ?? []) {
    const name = d.metadata?.name;
    if (!name) continue;
    const ann = d.spec?.template?.metadata?.annotations ?? {};
    // Only those this migration marked. Anything else declaring a CPU limit
    // did so on its own and is not ours to restart.
    if (!('insula.host/cpu-tier' in ann)) continue;
    await k8s.apps.patchNamespacedDeployment(
      {
        name, namespace,
        // null deletes the key under a strategic merge patch, which changes
        // the pod template and rolls the deployment.
        body: { spec: { template: { metadata: { annotations: { 'insula.host/cpu-tier': null } } } } },
      } as never,
      STRATEGIC_MERGE_PATCH,
    );
    rolled += 1;
  }
  return rolled;
}

/** Delete named pods; their controller recreates them under the LimitRange. */
export async function deletePods(
  k8s: K8sClients, namespace: string, podNames: readonly string[],
): Promise<void> {
  for (const name of podNames) {
    try {
      await k8s.core.deleteNamespacedPod({ name, namespace });
    } catch (err) {
      // Already gone is the outcome we wanted.
      if (!is404(err)) throw err;
    }
  }
}

/**
 * Record the exact prior request, then change it.
 *
 * Written BEFORE the change and only when not already set — a second
 * migration of a tenant that was never reverted must not overwrite the
 * original baseline with an already-tiered value, or the revert target
 * silently becomes the tier instead of what the tenant actually had.
 */
export async function storePriorRequest(
  db: Database, deploymentId: string, current: string,
): Promise<void> {
  await db.update(deployments)
    .set({ cpuRequestPreMigration: current })
    .where(and(
      eq(deployments.id, deploymentId),
      // isNull, NOT eq(col, null): Drizzle renders eq() as `= NULL`, which is
      // never true in SQL, so the baseline would silently never be stored and
      // the revert would have nothing to restore.
      isNull(deployments.cpuRequestPreMigration),
    ));
}

export async function clearPriorRequest(db: Database, deploymentId: string): Promise<void> {
  await db.update(deployments)
    .set({ cpuRequestPreMigration: null })
    .where(eq(deployments.id, deploymentId));
}

export async function setSchedulingMode(
  db: Database, tenantId: string, mode: 'legacy' | 'tiered',
): Promise<void> {
  await db.update(tenants)
    .set({
      cpuSchedulingMode: mode,
      cpuMigratedAt: mode === 'tiered' ? new Date() : null,
    })
    .where(eq(tenants.id, tenantId));
}

/** Deployments the migration may touch — `deleted` ones are not workloads. */
export async function listMigratableDeployments(db: Database, tenantId: string) {
  return db.select().from(deployments).where(and(
    eq(deployments.tenantId, tenantId),
    ne(deployments.status, 'deleted'),
  ));
}

// ─── the stop button ────────────────────────────────────────────────────────
//
// ★ DB-backed, not in-memory. Any replica may serve the POST that requests
// the stop, and a different one may be running the migration — an in-process
// flag would be set on a pod that is not the one looping.

export async function requestStop(db: Database, taskId: string): Promise<void> {
  await taskService.progress(db, taskId, { detailsPatch: { stopRequested: true } });
}

export async function isStopRequested(db: Database, taskId: string): Promise<boolean> {
  const [row] = await db.select({ details: tasks.details })
    .from(tasks).where(eq(tasks.id, taskId));
  return (row?.details as { stopRequested?: boolean } | null)?.stopRequested === true;
}

export const QUOTA_SCOPE_PRIORITY_CLASS = TENANT_DEFAULT_PRIORITY_CLASS;
