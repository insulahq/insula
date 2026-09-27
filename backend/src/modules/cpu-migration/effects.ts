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
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

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
  const body = buildTenantLimitRange({ namespace, tier, burstCores });
  try {
    await k8s.core.createNamespacedLimitRange({ namespace, body } as never);
  } catch (err) {
    if (!is409(err)) throw err;
    await k8s.core.replaceNamespacedLimitRange({
      name: limitRangeName(namespace), namespace, body,
    } as never);
  }
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
      metadata?: { name?: string };
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
    const all = [...(p.spec?.containers ?? []), ...(p.spec?.initContainers ?? [])];
    out.push({
      podName: p.metadata?.name ?? '(unnamed)',
      priorityClassName: p.spec?.priorityClassName ?? null,
      containersWithoutCpuLimit: all
        .filter((c) => !c.resources?.limits?.cpu)
        .map((c) => c.name ?? '(unnamed)'),
    });
  }
  return out;
}

export async function readWorkloads(
  k8s: K8sClients, namespace: string,
): Promise<WorkloadReadiness[]> {
  const list = await k8s.apps.listNamespacedDeployment({ namespace }) as {
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
): Promise<void> {
  const name = quotaName(namespace);
  const live = await k8s.core.readNamespacedResourceQuota({ name, namespace } as never) as {
    spec?: { hard?: Record<string, string> };
  };
  const memoryGi = Number(String(live.spec?.hard?.['limits.memory'] ?? '0Gi').replace(/Gi$/, '')) || 0;
  const hard = buildTieredQuotaHard({ tiers, burstCores, memoryGi });
  // MERGE_PATCH, not the client's default json-patch: the body is a merge
  // object, and the default would be rejected as a malformed op array.
  await k8s.core.patchNamespacedResourceQuota(
    { name, namespace, body: { spec: { hard: { ...live.spec?.hard, ...hard } } } } as never,
    MERGE_PATCH,
  );
}

/** Take the ceiling back off, leaving the legacy requests.cpu untouched. */
export async function removeQuotaLimits(
  k8s: K8sClients, namespace: string, legacyCpuCores: number,
): Promise<void> {
  const name = quotaName(namespace);
  await k8s.core.patchNamespacedResourceQuota(
    {
      name, namespace,
      // null DELETES a key under RFC 7396 — the only way to drop limits.cpu
      // without rewriting the whole object, whose scopeSelector is immutable.
      body: { spec: { hard: { 'limits.cpu': null, 'requests.cpu': String(legacyCpuCores) } } },
    } as never,
    MERGE_PATCH,
  );
}

/** Replace a deployment's pods without changing its spec. */
export async function recreatePods(
  k8s: K8sClients, namespace: string, appLabel: string,
): Promise<void> {
  const list = await k8s.core.listNamespacedPod({
    namespace, labelSelector: `app=${appLabel}`,
  }) as { items?: ReadonlyArray<{ metadata?: { name?: string } }> };
  for (const p of list.items ?? []) {
    if (!p.metadata?.name) continue;
    try {
      await k8s.core.deleteNamespacedPod({ name: p.metadata.name, namespace });
    } catch (err) {
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
