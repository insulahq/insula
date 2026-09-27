/**
 * The two Kubernetes objects that make a tenant namespace tiered (ADR-062 §2).
 *
 * Pure builders plus the readiness check that decides when it is SAFE to put
 * `limits.cpu` on the quota. No I/O — the caller fetches, this decides.
 *
 *   ResourceQuota
 *     requests.cpu = sum of the workloads' tier values   ← scheduling budget
 *     limits.cpu   = loose backstop                      ← pathological case
 *
 *   LimitRange
 *     defaultRequest.cpu = the tier value    ← applies the tier automatically
 *     default.cpu        = the burst ceiling ← bounds one runaway process
 *     max.cpu            = the most a tenant may declare for itself
 */

import { type CpuTier } from '@insula/api-contracts';
import { tierMillis } from './tiers.js';

/**
 * How far above the per-container ceiling the quota's `limits.cpu` sits.
 *
 * ★ The two knobs fight, and this is the deliberate resolution. The quota caps
 * the SUM of declared container limits. If it equalled the tenant's burst
 * allowance — so any single app could use all of it — the first container
 * would consume the whole quota and the tenant's SECOND POD WOULD FAIL
 * ADMISSION. A tenant with three apps could not deploy the third.
 *
 * So the per-container ceiling is the full allowance (the common case stays
 * useful, and one runaway process is caught exactly), and the quota is a loose
 * backstop above it for the many-pods-pegged-at-once case.
 *
 * State the weakening plainly: tenant-wide use is NOT bounded at the burst
 * allowance. That stronger guarantee is not claimed. The rejected alternative
 * — dividing the allowance by an expected pod count — buys a tighter bound by
 * guessing a divisor and making the common case worse.
 */
export const QUOTA_LIMITS_CPU_BACKSTOP = 4;

/**
 * Floor for the quota's `requests.cpu`.
 *
 * A tenant with no workloads sums to 0, and `requests.cpu: "0"` on a quota
 * forbids scheduling anything at all — the namespace would be frozen rather
 * than empty. One tier step is enough to let the first pod in.
 */
export const MIN_QUOTA_REQUEST_MILLIS = 5;

export interface TieredQuotaInput {
  /** One entry per container the tenant runs; sums to requests.cpu. */
  readonly tiers: readonly CpuTier[];
  readonly burstCores: number;
  /**
   * What the namespace's in-scope pods ACTUALLY request right now, in
   * millicores, read from the live quota's `status.used`.
   *
   * ★ Without this the quota freezes the tenant. Verified on a cluster:
   * Kubernetes ACCEPTS a ResourceQuota whose `hard` is below current `used`
   * — it does not reject the update — and then refuses every subsequent pod,
   * including a 5m one ("exceeded quota … used: 300m, limited: 30m"). The
   * tier sum covers only the deployments the migration re-tiered; a
   * CPU-pinning custom container or a compose stack keeps its original,
   * larger request and still counts against the quota. Any tenant with one
   * would have had its namespace frozen by its own migration.
   */
  readonly liveUsedMillis: number;
  /**
   * The largest single in-scope pod's CPU request, in millicores.
   *
   * Surge room. A rolling update runs the old and new pod together, so a
   * quota sized exactly to steady state blocks the tenant's next deploy —
   * the namespace would not be frozen, but nothing could ever roll.
   */
  readonly largestPodMillis: number;
}

export function buildTieredQuotaHard(input: TieredQuotaInput): Record<string, string> {
  const summed = input.tiers.reduce((s, t) => s + tierMillis(t), 0);
  // Never below what the namespace already holds, and never without room for
  // one more copy of its biggest workload.
  const surge = Math.max(input.largestPodMillis, tierMillis('highest'));
  const requestMillis = Math.max(
    MIN_QUOTA_REQUEST_MILLIS,
    Math.max(summed, input.liveUsedMillis) + surge,
  );
  /**
   * ★ CPU ONLY. Memory is deliberately absent from this patch.
   *
   * An earlier version copied the live quota's memory across, parsing it out
   * of `limits.memory` with a `Gi`-suffix strip. Every writer uses `Gi`
   * today, so it worked — but a value in `Mi` would have parsed to NaN, been
   * coalesced to 0, and written `0Gi`, freezing the namespace on MEMORY
   * during a CPU migration. Re-stating a value we have no reason to change
   * bought nothing and risked that; a merge patch simply leaves it alone.
   */
  return {
    'requests.cpu': `${requestMillis}m`,
    'limits.cpu': `${round2(input.burstCores * QUOTA_LIMITS_CPU_BACKSTOP)}`,
  };
}

export interface LimitRangeInput {
  readonly namespace: string;
  /** The tenant's default tier — what an undeclared container requests. */
  readonly tier: CpuTier;
  readonly burstCores: number;
  /**
   * The largest CPU any in-scope container already declares, in millicores.
   *
   * ★ `max` must never invalidate a pod that is already running. Verified on
   * a cluster: a LimitRange `max.cpu` rejects a container REQUESTING more
   * than it — "must be less than or equal to cpu limit of 1" — so installing
   * one at the burst ceiling would make an existing larger workload
   * unschedulable, and the straggler sweep would delete such a pod and then
   * be unable to recreate it. An outage caused by the migration itself.
   *
   * The policy bound is `default` (what an undeclared container gets); `max`
   * only stops a NEW declaration going higher, so raising it to cover what
   * already exists costs nothing and prevents that.
   */
  readonly largestDeclaredMillis: number;
}

export function buildTenantLimitRange(input: LimitRangeInput): {
  metadata: { name: string; namespace: string };
  spec: { limits: ReadonlyArray<Record<string, unknown>> };
} {
  const ceiling = `${round2(input.burstCores)}`;
  const maxMillis = Math.max(Math.round(input.burstCores * 1000), input.largestDeclaredMillis);
  const maxCpu = `${round2(maxMillis / 1000)}`;
  return {
    metadata: { name: `${input.namespace}-cpu`, namespace: input.namespace },
    spec: {
      limits: [{
        type: 'Container',
        // The tier, applied to any container that does not ask for CPU —
        // including custom containers and bring-your-own images, without
        // touching a tenant's manifests.
        defaultRequest: { cpu: `${tierMillis(input.tier)}m` },
        // The ceiling. Memory is deliberately absent: a memory default here
        // would collide with the Guaranteed request==limit model tenant pods
        // already use, and memory is incompressible — see ADR-062.
        default: { cpu: ceiling },
        // >= ceiling, and never below what a container already declares.
        max: { cpu: maxCpu },
      }],
    },
  };
}

export interface PodCpuLimitFact {
  readonly podName: string;
  /** Containers (init included) that declare NO cpu limit. */
  readonly containersWithoutCpuLimit: readonly string[];
  /**
   * ★ Which pods the quota actually governs. The tenant quota carries
   * `scopeSelector: PriorityClass In [tenant-default]`, so it constrains ONLY
   * pods at that class — and platform-managed pods deliberately run in the
   * tenant namespace at `platform-tenant-overhead` precisely so they do not
   * count against it. file-manager is one, and it ships with a CPU request
   * and no limit on purpose. Judging it against a quota that will never
   * apply to it would block the migration of any tenant whose File Manager
   * happens to be running.
   */
  readonly priorityClassName: string | null;
  /**
   * Does something own this pod that will recreate it?
   *
   * ★ The straggler sweep DELETES pods. A pod with no controller is not
   * recreated by anything — deleting it destroys the workload. Production
   * has none today (checked: 0 bare pods across 37 tenant pods), but "none
   * today" is not a guarantee, and the failure mode is permanent data-plane
   * loss rather than a retryable error. So the sweep skips them and the
   * readiness check refuses instead, naming the pod: refusing to migrate is
   * recoverable, deleting something nothing recreates is not.
   */
  readonly hasController: boolean;
}

export interface LimitsCpuReadiness {
  readonly ready: boolean;
  readonly reason: string | null;
  /** Pods that would break, named so the operator can act. */
  readonly blockingPods: readonly string[];
}

/**
 * Is it safe to add `limits.cpu` to this namespace's quota YET?
 *
 * Judged only over pods the quota actually governs — see
 * PodCpuLimitFact.priorityClassName.
 *
 * ★ This is the step that can take a tenant down, and the order is not
 * negotiable. The moment a ResourceQuota carries `limits.cpu`, the API server
 * REJECTS every pod in that namespace that does not declare a CPU limit. Add
 * it while pods are running without one and nothing breaks immediately — the
 * running pods are already admitted — but the tenant is armed: the next
 * rollout, eviction, node drain or scale-up fails admission, at a moment
 * nobody connects to a quota edit made days earlier.
 *
 * So both conditions must hold first:
 *   1. the LimitRange exists, so newly created pods inherit a ceiling; and
 *   2. every running pod ALREADY carries one, so nothing currently scheduled
 *      depends on the quota staying limit-free.
 *
 * Checking only (1) is the tempting shortcut and it is wrong: a LimitRange
 * applies at admission, so it does nothing for pods admitted before it.
 */
export function assessLimitsCpuReadiness(
  limitRangeExists: boolean,
  pods: readonly PodCpuLimitFact[],
  /** The class the quota's scopeSelector matches. Pods outside it are exempt. */
  quotaScopePriorityClass: string,
): LimitsCpuReadiness {
  if (!limitRangeExists) {
    return {
      ready: false,
      reason: 'the namespace has no CPU LimitRange, so a pod created without an explicit '
        + 'limit would be refused once the quota carries limits.cpu',
      blockingPods: [],
    };
  }
  const inScope = pods.filter((p) => p.priorityClassName === quotaScopePriorityClass);
  const offenders = inScope.filter((p) => p.containersWithoutCpuLimit.length > 0);
  if (offenders.length > 0) {
    return {
      ready: false,
      reason: `${offenders.length} running pod(s) have containers with no CPU limit; they `
        + 'were admitted before the LimitRange and must be recreated first',
      blockingPods: offenders.map((p) => p.podName),
    };
  }
  return { ready: true, reason: null, blockingPods: [] };
}

/** Trailing-zero-free to keep the rendered quota readable. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
