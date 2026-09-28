/**
 * The cluster and database side of a CPU-tier migration (ADR-062 R2).
 *
 * Thin by design. Every decision — ordering, gating, stopping, what a partial
 * run means — lives in apply.ts/plan.ts/health-gate.ts where it is unit
 * tested without a cluster. This file only does what it is told, and is
 * exercised by the DEV end-to-end run.
 */

import { eq, and, ne, isNull, sql } from 'drizzle-orm';
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

/**
 * The ceiling the namespace's LimitRange currently imposes, in millicores,
 * or null when there is no LimitRange.
 *
 * What a re-apply compares against. It is NOT derivable from the tenant row
 * (that is the new value) nor from the quota (which carries the backstop,
 * a multiple of it) — only the LimitRange holds the figure pods are actually
 * admitted with.
 */
export async function readLimitRangeCeilingMillis(
  k8s: K8sClients, namespace: string,
): Promise<number | null> {
  try {
    const lr = await (k8s.core as unknown as {
      readNamespacedLimitRange: (a: { name: string; namespace: string }) => Promise<{
        spec?: { limits?: ReadonlyArray<{
          type?: string;
          default?: Record<string, string>;
          _default?: Record<string, string>;
        }> };
      }>;
    }).readNamespacedLimitRange({ name: limitRangeName(namespace), namespace });
    const container = (lr.spec?.limits ?? []).find((l) => l.type === 'Container');
    // ★ `_default`, because the client renames the reserved word — see
    // limitRangeDefault in preview.ts. Reading `.default` returned
    // undefined every time, so the re-apply could not tell which pods were
    // still admitted under the previous ceiling and swept none of them.
    const cpu = (container?.default ?? container?._default)?.cpu;
    return cpu ? quantityToMillis(cpu) : null;
  } catch (err) {
    if (is404(err)) return null;
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
      containerCpuLimitsMillis: all
        .map((c) => quantityToMillis(c.resources?.limits?.cpu))
        .filter((m) => m > 0),
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
  // The LIMIT axis needs the same treatment as the request axis: a quota
  // below `used` is accepted and then refuses every pod. Re-applying a
  // reduced ceiling is exactly when the pods still hold the larger one.
  const liveUsedLimitMillis = quantityToMillis(live.status?.used?.['limits.cpu']);
  const pods = await readPodCpuLimits(k8s, namespace);
  const largestPodLimitMillis = pods
    .filter((p) => p.priorityClassName === priorityClass)
    .reduce((mx, p) => Math.max(mx, p.containerCpuLimitsMillis.reduce((a, b) => a + b, 0)), 0);
  const hard = buildTieredQuotaHard({
    tiers, burstCores, liveUsedMillis, largestPodMillis,
    liveUsedLimitMillis, largestPodLimitMillis,
  });
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
/**
 * Make room in a TIERED namespace's quota for a workload about to be added.
 *
 * ★ The gap that made the tier model a one-way street.
 *
 * `applyQuotaLimits` sizes `requests.cpu` from what the namespace held at
 * migration plus one pod's worth of surge — a snapshot, and nothing ever
 * revisited it. Every migrated tenant was therefore left with about 100m of
 * room: three more small applications, and the fourth deploy is refused by a
 * quota the platform set itself, with an "exceeded quota" the tenant cannot
 * act on and the operator would not connect to a migration weeks earlier.
 *
 * Raises only. A tenant's total is still bounded — by memory, by the pod
 * count that implies, and by the burst ceiling on actual use — which is
 * what ADR-062 says should bound it. `requests.cpu` under the tier model is
 * a guard rail against runaway scheduling, not the product.
 */
export async function ensureTieredQuotaRoom(
  k8s: K8sClients, namespace: string, addingMillis: number,
): Promise<void> {
  const name = quotaName(namespace);
  let live: { spec?: { hard?: Record<string, string> }; status?: { used?: Record<string, string> } };
  try {
    live = await k8s.core.readNamespacedResourceQuota({ name, namespace } as never) as typeof live;
  } catch (err) {
    // No quota is not an error here: an unprovisioned namespace has nothing
    // to widen, and a read failure must not block a deploy that the quota
    // may well have allowed anyway.
    if (is404(err)) return;
    throw err;
  }
  // Tiered namespaces only. A legacy quota's requests.cpu IS the plan
  // allowance, and widening it would quietly sell CPU nobody bought.
  if (!live.spec?.hard?.['limits.cpu']) return;

  const currentHard = quantityToMillis(live.spec?.hard?.['requests.cpu']);
  const used = quantityToMillis(live.status?.used?.['requests.cpu']);
  // Room for the new workload on top of what is held, plus the same surge
  // the migration leaves so the next rolling update still fits.
  const wanted = used + Math.max(addingMillis, 0) + Math.max(addingMillis, 100);
  if (wanted <= currentHard) return;
  await k8s.core.patchNamespacedResourceQuota(
    { name, namespace, body: { spec: { hard: { ...live.spec?.hard, 'requests.cpu': `${wanted}m` } } } } as never,
    MERGE_PATCH,
  );
}

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
 * Release every workload still carrying a ceiling the PLATFORM gave it.
 *
 * ★ Ground truth, not bookkeeping. An earlier version rolled only
 * deployments carrying our tier annotation — but a straggler pod is DELETED
 * rather than annotated, so its replacement kept a hard CPU cap for life
 * after a revert that reported success and counted zero. Observed on DEV
 * exactly that way.
 *
 * The reliable test needs no marker: if a Deployment's pod TEMPLATE declares
 * no CPU limit but its running pods have one, that limit was injected by the
 * LimitRange at admission and is ours to remove. If the template declares
 * one, the tenant chose it and it is not ours to touch.
 *
 * Must run AFTER the LimitRange is gone, or the replacements are admitted
 * with the very ceiling being removed.
 */
export async function rollPodsStillCapped(
  k8s: K8sClients, namespace: string, priorityClass: string,
): Promise<number> {
  const pods = await readPodCpuLimits(k8s, namespace);
  const anyCapped = pods.some(
    (p) => p.priorityClassName === priorityClass && p.containersWithoutCpuLimit.length === 0,
  );
  if (!anyCapped) return 0;

  const list = await k8s.apps.listNamespacedDeployment({ namespace }) as {
    items?: ReadonlyArray<{
      metadata?: { name?: string };
      spec?: { template?: {
        metadata?: { annotations?: Record<string, string> };
        spec?: { containers?: ReadonlyArray<{ resources?: { limits?: Record<string, string> } }> };
      } };
    }>;
  };

  let rolled = 0;
  for (const d of list.items ?? []) {
    const name = d.metadata?.name;
    if (!name) continue;
    const tpl = d.spec?.template;
    const templateDeclaresLimit = (tpl?.spec?.containers ?? [])
      .some((c) => Boolean(c.resources?.limits?.cpu));
    if (templateDeclaresLimit) continue; // the tenant's own ceiling

    const live = await k8s.core.listNamespacedPod({
      namespace, labelSelector: `app=${name}`,
    }) as { items?: ReadonlyArray<{
      metadata?: { name?: string; deletionTimestamp?: string };
      status?: { phase?: string };
      spec?: { priorityClassName?: string; containers?: ReadonlyArray<{ resources?: { limits?: Record<string, string> } }> };
    }> };
    const capped = (live.items ?? []).filter((p) => {
      if (p.metadata?.deletionTimestamp) return false;
      if (p.status?.phase === 'Succeeded' || p.status?.phase === 'Failed') return false;
      if ((p.spec?.priorityClassName ?? null) !== priorityClass) return false;
      return (p.spec?.containers ?? []).some((c) => Boolean(c.resources?.limits?.cpu));
    });
    if (capped.length === 0) continue;

    const annotated = 'insula.host/cpu-tier' in (tpl?.metadata?.annotations ?? {});
    if (annotated) {
      // Clearing the marker changes the template, so Kubernetes ROLLS it —
      // the replacement is up before the old pod goes, no downtime.
      await k8s.apps.patchNamespacedDeployment(
        {
          name, namespace,
          body: { spec: { template: { metadata: { annotations: { 'insula.host/cpu-tier': null } } } } },
        } as never,
        STRATEGIC_MERGE_PATCH,
      );
    } else {
      // Nothing to change in the template, so there is nothing to roll:
      // replace the pods directly. The ceiling is already gone from the
      // namespace, so what comes back has none.
      for (const p of capped) {
        if (!p.metadata?.name) continue;
        try {
          await k8s.core.deleteNamespacedPod({ name: p.metadata.name, namespace });
        } catch (err) {
          if (!is404(err)) throw err;
        }
      }
    }
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
      // ★ First migration only. Re-applying a changed tier is not a new
      // migration, and restamping this would rewrite the date the panel
      // shows as "tiered since" every time an operator adjusts a ceiling.
      cpuMigratedAt: mode === 'tiered' ? sql`COALESCE(${tenants.cpuMigratedAt}, NOW())` : null,
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
