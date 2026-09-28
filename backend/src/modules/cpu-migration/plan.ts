/**
 * The ordered plan for migrating ONE tenant onto the tier model (ADR-062 R2).
 *
 * Pure. Produces the steps; apply.ts executes them. Keeping the ordering
 * decisions here is what lets "migrate the biggest over-reserver first" be a
 * test rather than a claim.
 */

import { type CpuTier } from '@insula/api-contracts';
import { tierMillis } from './tiers.js';

export interface DeploymentToRetier {
  readonly id: string;
  readonly name: string;
  /** Exactly what `deployments.cpu_request` holds today, e.g. "0.25" or "250m". */
  readonly currentCpuRequest: string;
  readonly proposedTier: CpuTier;
  /** True when this deployment pins its own CPU (ADR-036 custom container). */
  readonly pinsOwnCpu: boolean;
  /**
   * How many containers this row actually schedules. A compose stack is ONE
   * deployments row that deploys N services, each its own K8s Deployment, and
   * the LimitRange applies defaultRequest to every one of them — so budgeting
   * the quota for a single tier value would under-provision it N-fold.
   */
  readonly containerCount: number;
  /**
   * Compose-mode custom deployments cannot be re-tiered: cpu_request on the
   * row is an aggregate over services with no unambiguous per-service mapping
   * back, which is why dispatchCustomResources already refuses them with
   * NOT_SUPPORTED_FOR_COMPOSE.
   */
  readonly isComposeStack: boolean;
}

export type MigrationStepKind =
  /**
   * ★ FIRST, before any pod is touched.
   *
   * The legacy quota is provisioned with ZERO slack — `requests.cpu` is
   * exactly the tenant's plan allowance. Replacing a pod deletes it, and a
   * Terminating pod holds its full reservation for its grace period, so for
   * ~30s the old and new pod together exceed that quota and the ReplicaSet
   * is refused. The migration would then have caused precisely the outage
   * ADR-062 was written to prevent.
   *
   * Widening the quota first is purely permissive: it cannot break anything,
   * it removes the cause rather than tolerating it, and the final step
   * tightens `requests.cpu` back down to the tiered figure once the pods are
   * smaller.
   */
  | 'widen_quota_headroom'
  | 'ensure_limit_range'
  | 'retier_deployment'
  /**
   * ★ Same request, but the pods still have to be replaced.
   *
   * A LimitRange defaults a limit at ADMISSION, so a pod already running has
   * none and never gains one. Changing the request rewrites the pod template
   * and Kubernetes rolls the pods for us — but when the request is ALREADY
   * the tier value, the template is byte-identical, nothing rolls, and those
   * pods keep running with no limit forever. `verify_limits_ready` then
   * refuses the quota ceiling, every time, with no step in the plan able to
   * fix it: the migration is permanently stuck for that tenant.
   *
   * Not hypothetical. The platform's own default for a custom deployment is
   * `100m`, which is exactly CPU_TIER_MILLICORES.highest.
   *
   * So this step deletes the pods and lets the ReplicaSet recreate them from
   * the unchanged template — the recreation route this repo already prefers
   * over a rollout-restart annotation.
   */
  | 'recreate_deployment'
  /**
   * ★ Anything still without a ceiling, found from the CLUSTER.
   *
   * Every other step is driven by `deployments` rows. The readiness check is
   * driven by LIVE PODS. Those two sets are not the same, and wherever they
   * diverge the migration blocks forever: on DEV a deployment sat `stopped`
   * in the database while its pod was 1/1 in the cluster, so nothing in the
   * plan ever recreated it, it never gained a limit, and verify_limits_ready
   * refused every time.
   *
   * Rather than guess at every way the two can drift — a stale status, an
   * orphaned ReplicaSet, something applied by hand — this step asks the same
   * source the gate asks, and replaces whatever is still missing a ceiling.
   */
  | 'recreate_stragglers'
  | 'verify_limits_ready'
  | 'apply_quota_limits'
  | 'mark_tiered';

export interface MigrationStep {
  readonly kind: MigrationStepKind;
  readonly label: string;
  /** Present on retier_deployment only. */
  readonly deploymentId?: string;
  readonly deploymentName?: string;
  readonly fromCpuRequest?: string;
  readonly toCpuRequest?: string;
  /** Millicores this step hands back (negative = takes more). */
  readonly freesMillis?: number;
}

/** Parse the several shapes `deployments.cpu_request` has carried. */
export function cpuRequestToMillis(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === 'm' ? Math.round(n) : Math.round(n * 1000);
}

export interface BuildPlanInput {
  readonly namespace: string;
  readonly deployments: readonly DeploymentToRetier[];
  readonly defaultTier: CpuTier;
  /**
   * Does every pod have to be re-admitted?
   *
   * True on a first migration — the pods predate the LimitRange and carry no
   * ceiling at all, which is the whole reason `recreate_deployment` exists.
   * True again when a RE-APPLY changes the ceiling, because a LimitRange
   * stamps its default at admission and a running pod never picks up a new
   * one.
   *
   * False when re-applying a ceiling that did not move: the tier of a
   * workload whose request is unchanged has no cluster effect to deliver,
   * and recreating its pods would be an outage-shaped no-op. The straggler
   * sweep still catches anything genuinely out of step.
   */
  readonly readmitPods?: boolean;
}

export interface MigrationPlan {
  readonly steps: readonly MigrationStep[];
  readonly totalFreesMillis: number;
  /** Deployments deliberately left alone, with the reason. */
  readonly skipped: ReadonlyArray<{ name: string; reason: string }>;
}

/**
 * ★ Ordered biggest-saving first, and that is a safety property rather than a
 * cosmetic one.
 *
 * Migration is SELF-EASING: every retiered deployment reduces the namespace's
 * reservation, so each step makes the next one easier to schedule. On a
 * cluster tight enough that the first recreation is risky, doing the biggest
 * over-reserver first buys the most headroom at the moment headroom is
 * scarcest. Doing it last — the usual instinct of "start with something
 * small" — spends the whole migration in the tightest state.
 */
export function buildMigrationPlan(input: BuildPlanInput): MigrationPlan {
  const skipped: Array<{ name: string; reason: string }> = [];
  const retiers: MigrationStep[] = [];
  const recreates: MigrationStep[] = [];

  for (const d of input.deployments) {
    if (d.pinsOwnCpu) {
      // A value a human chose is not ours to overwrite, even when the tier
      // would be smaller. ADR-036 custom containers declare their own.
      skipped.push({ name: d.name, reason: 'declares its own CPU resources' });
      continue;
    }
    if (d.isComposeStack) {
      // One row, N services, no unambiguous per-service mapping back.
      skipped.push({ name: d.name, reason: 'compose stack — per-service CPU cannot be mapped' });
      continue;
    }
    const fromMillis = cpuRequestToMillis(d.currentCpuRequest);
    const toMillis = tierMillis(d.proposedTier);
    if (fromMillis === null) {
      // An unparseable current value means we cannot promise an exact revert,
      // and an exact revert is the whole safety story. Leave it.
      skipped.push({ name: d.name, reason: `unrecognised CPU request "${d.currentCpuRequest}"` });
      continue;
    }
    if (fromMillis === toMillis) {
      if (input.readmitPods === false) {
        // Re-apply with an unchanged ceiling: nothing about this deployment
        // needs to reach the cluster, so do not roll it.
        continue;
      }
      // Already the right size — but its pods still predate the LimitRange
      // and carry no limit. Replace them, or verify_limits_ready can never
      // pass. freesMillis is 0: this hands nothing back, it only re-admits.
      recreates.push({
        kind: 'recreate_deployment',
        label: `Recreate ${d.name} to apply the ceiling (${toMillis}m unchanged)`,
        deploymentId: d.id,
        deploymentName: d.name,
        fromCpuRequest: d.currentCpuRequest,
        toCpuRequest: d.currentCpuRequest,
        freesMillis: 0,
      });
      continue;
    }
    retiers.push({
      kind: 'retier_deployment',
      label: `Re-tier ${d.name} (${fromMillis}m → ${toMillis}m)`,
      deploymentId: d.id,
      deploymentName: d.name,
      fromCpuRequest: d.currentCpuRequest,
      toCpuRequest: `${toMillis}m`,
      freesMillis: fromMillis - toMillis,
    });
  }

  retiers.sort((a, b) => (b.freesMillis ?? 0) - (a.freesMillis ?? 0));

  const steps: MigrationStep[] = [
    {
      kind: 'widen_quota_headroom',
      label: 'Make room in the namespace quota for a pod replacement',
    },
    {
      kind: 'ensure_limit_range',
      label: 'Create the namespace CPU LimitRange',
    },
    ...retiers,
    // After the savings: these free nothing, so doing them first would spend
    // the tight part of the migration on pod churn that buys no headroom.
    ...recreates,
    {
      kind: 'recreate_stragglers',
      label: 'Replace any pod still running without a CPU ceiling',
    },
    {
      // Between the recreations and the quota edit, ALWAYS. The quota gains
      // limits.cpu only once every pod provably carries a limit.
      kind: 'verify_limits_ready',
      label: 'Verify every pod carries a CPU limit',
    },
    {
      kind: 'apply_quota_limits',
      label: 'Add the burst ceiling to the namespace quota',
    },
    {
      kind: 'mark_tiered',
      label: 'Switch the tenant to tiered scheduling',
    },
  ];

  return {
    steps,
    totalFreesMillis: retiers.reduce((s, r) => s + (r.freesMillis ?? 0), 0),
    skipped,
  };
}
