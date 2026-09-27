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
  readonly memoryGi: number;
}

export function buildTieredQuotaHard(input: TieredQuotaInput): Record<string, string> {
  const summed = input.tiers.reduce((s, t) => s + tierMillis(t), 0);
  const requestMillis = Math.max(MIN_QUOTA_REQUEST_MILLIS, summed);
  return {
    'requests.cpu': `${requestMillis}m`,
    'limits.cpu': `${round2(input.burstCores * QUOTA_LIMITS_CPU_BACKSTOP)}`,
    'requests.memory': `${input.memoryGi}Gi`,
    'limits.memory': `${input.memoryGi}Gi`,
  };
}

export interface LimitRangeInput {
  readonly namespace: string;
  /** The tenant's default tier — what an undeclared container requests. */
  readonly tier: CpuTier;
  readonly burstCores: number;
}

export function buildTenantLimitRange(input: LimitRangeInput): {
  metadata: { name: string; namespace: string };
  spec: { limits: ReadonlyArray<Record<string, unknown>> };
} {
  const ceiling = `${round2(input.burstCores)}`;
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
        max: { cpu: ceiling },
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
