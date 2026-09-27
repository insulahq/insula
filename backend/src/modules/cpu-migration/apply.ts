/**
 * Run one tenant's CPU-tier migration (ADR-062 R2).
 *
 * Paced and interruptible: one workload at a time, a health gate between
 * each, a stop that takes effect mid-wait, and the exact prior request stored
 * so a revert restores rather than recomputes.
 *
 * Every cluster effect is INJECTED. The orchestration — ordering, gating,
 * stopping, what happens when step 4 of 9 fails — is the part that is hard to
 * get right and impossible to rehearse on a live cluster, so it is testable
 * without one. The injected functions are thin; this is where the decisions
 * are.
 */

import { type CpuTier } from '@insula/api-contracts';
import { buildMigrationPlan, type DeploymentToRetier, type MigrationStep } from './plan.js';
import { assessLimitsCpuReadiness, type PodCpuLimitFact } from './tiered-namespace.js';
import { waitForHealthy, type WorkloadReadiness } from './health-gate.js';

export interface MigrationEffects {
  /** Store the exact prior value, then change the request and redeploy. */
  readonly retier: (deploymentId: string, from: string, to: string) => Promise<void>;
  /**
   * Replace a deployment's pods WITHOUT changing its spec, so they are
   * re-admitted and pick up the LimitRange ceiling. Needed when the request
   * already equals the tier value: the pod template would be identical and
   * Kubernetes would roll nothing.
   */
  readonly recreatePods: (deploymentId: string) => Promise<void>;
  /** Raise requests.cpu so a replacement pod fits beside the one it replaces. */
  readonly widenQuotaHeadroom: () => Promise<void>;
  readonly ensureLimitRange: (tier: CpuTier, burstCores: number) => Promise<void>;
  /** Verified, not assumed, before the quota gains limits.cpu. */
  readonly limitRangeExists: () => Promise<boolean>;
  readonly readWorkloads: () => Promise<readonly WorkloadReadiness[]>;
  readonly readPodCpuLimits: () => Promise<readonly PodCpuLimitFact[]>;
  /** Delete these pods; their controller recreates them under the LimitRange. */
  readonly deletePods: (podNames: readonly string[]) => Promise<void>;
  readonly applyQuotaLimits: (burstCores: number, tiers: readonly CpuTier[]) => Promise<void>;
  /** The PriorityClass the tenant quota's scopeSelector matches. */
  readonly quotaScopePriorityClass: string;
  readonly markTiered: () => Promise<void>;
  /** Operator-visible progress; also the surface the stop button writes to. */
  readonly report: (pct: number, text: string) => Promise<void>;
  readonly stopRequested: () => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface MigrationInput {
  readonly namespace: string;
  readonly deployments: readonly DeploymentToRetier[];
  readonly tier: CpuTier;
  readonly burstCores: number;
  readonly healthTimeoutMs?: number;
  readonly healthPollMs?: number;
}

export type MigrationOutcome =
  | { readonly status: 'completed'; readonly freedMillis: number; readonly stepsRun: number }
  | { readonly status: 'stopped'; readonly afterStep: string; readonly stepsRun: number }
  | { readonly status: 'failed'; readonly afterStep: string; readonly reason: string; readonly stepsRun: number };

const DEFAULT_HEALTH_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_HEALTH_POLL_MS = 3000;

/**
 * The tier values the quota's `requests.cpu` must cover — ONE PER CONTAINER,
 * not one per deployments row.
 *
 * The LimitRange applies `defaultRequest.cpu` to every container it admits,
 * so a row that schedules several containers consumes that many tier values.
 * Budgeting per row would under-provision the quota and the tenant's later
 * pods would fail admission against a ceiling we set ourselves.
 */
function quotaTiers(deployments: readonly DeploymentToRetier[]): CpuTier[] {
  const out: CpuTier[] = [];
  for (const d of deployments) {
    if (d.pinsOwnCpu || d.isComposeStack) continue;
    for (let i = 0; i < Math.max(1, d.containerCount); i += 1) out.push(d.proposedTier);
  }
  return out;
}

/**
 * ★ Partial is a real outcome, and it is SAFE — but only because of the order.
 *
 * If this stops or fails halfway, some workloads are re-tiered and some are
 * not. That state is stable and serviceable: a smaller CPU request is always
 * easier to schedule than the one it replaced, so a half-migrated tenant is
 * strictly better off than before it started. The tenant stays in `legacy`
 * mode — `markTiered` is the LAST step — so nothing reads the tier columns
 * for it, and the per-deployment prior values are stored, so a revert puts
 * back exactly what was there.
 *
 * This is why the quota ceiling goes on at the END. Adding limits.cpu first
 * and failing partway would leave a namespace whose quota demands a limit
 * that most of its pods do not declare — the armed trap in
 * assessLimitsCpuReadiness, with no obvious way back.
 */
export async function runTenantCpuMigration(
  fx: MigrationEffects,
  input: MigrationInput,
): Promise<MigrationOutcome> {
  const plan = buildMigrationPlan({
    namespace: input.namespace,
    deployments: input.deployments,
    defaultTier: input.tier,
  });
  const total = plan.steps.length;
  let done = 0;
  let freed = 0;
  const pct = () => Math.round((done / total) * 100);

  const stopHere = (step: MigrationStep): MigrationOutcome =>
    ({ status: 'stopped', afterStep: step.label, stepsRun: done });

  const failed = (step: MigrationStep, err: unknown): MigrationOutcome => ({
    status: 'failed',
    afterStep: step.label,
    reason: err instanceof Error ? err.message : String(err),
    stepsRun: done,
  });

  for (const step of plan.steps) {
    // Checked BEFORE each step, so a stop never lands mid-effect: the tenant
    // is always between two complete steps when we put the tools down.
    if (await fx.stopRequested()) return stopHere(step);
    await fx.report(pct(), step.label);

    // ★ EVERY step's effect is caught, not just the re-tier. An RBAC denial
    // on the LimitRange or a transient API error on the quota is exactly as
    // likely as one on a re-tier, and letting those reject the promise while
    // others return a typed outcome gives the caller two contracts to handle
    // — so one of them gets forgotten.
    try {
    switch (step.kind) {
      case 'widen_quota_headroom':
        await fx.widenQuotaHeadroom();
        break;

      case 'ensure_limit_range':
        await fx.ensureLimitRange(input.tier, input.burstCores);
        break;

      case 'recreate_deployment':
      case 'retier_deployment': {
        if (step.kind === 'retier_deployment') {
          await fx.retier(step.deploymentId!, step.fromCpuRequest!, step.toCpuRequest!);
        } else {
          await fx.recreatePods(step.deploymentId!);
        }
        // Settle before touching the next one. Without this a failure on the
        // first workload is discovered only after ten more were recreated on
        // top of it.
        const gate = await waitForHealthy(fx.readWorkloads, {
          timeoutMs: input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
          pollMs: input.healthPollMs ?? DEFAULT_HEALTH_POLL_MS,
          sleep: fx.sleep,
          now: fx.now,
          stopRequested: fx.stopRequested,
        });
        if (!gate.ok) {
          if (await fx.stopRequested()) return stopHere(step);
          const why = gate.timedOut
            ? `${step.deploymentName} did not become healthy in time`
            : gate.verdict.state === 'broken'
              ? `${gate.verdict.workload}: ${gate.verdict.reason}`
              : 'workloads did not settle';
          return { status: 'failed', afterStep: step.label, reason: why, stepsRun: done };
        }
        freed += step.freesMillis ?? 0;
        break;
      }

      case 'recreate_stragglers': {
        const stragglers = (await fx.readPodCpuLimits()).filter(
          (p) => p.priorityClassName === fx.quotaScopePriorityClass
            && p.containersWithoutCpuLimit.length > 0
            // Never delete a pod nothing will bring back. verify_limits_ready
            // then refuses and names it, which is the recoverable outcome.
            && p.hasController,
        );
        if (stragglers.length > 0) {
          await fx.deletePods(stragglers.map((p) => p.podName));
          const gate = await waitForHealthy(fx.readWorkloads, {
            timeoutMs: input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
            pollMs: input.healthPollMs ?? DEFAULT_HEALTH_POLL_MS,
            sleep: fx.sleep,
            now: fx.now,
            stopRequested: fx.stopRequested,
          });
          if (!gate.ok) {
            if (await fx.stopRequested()) return stopHere(step);
            return {
              status: 'failed',
              afterStep: step.label,
              reason: gate.timedOut
                ? 'replaced pods did not become healthy in time'
                : gate.verdict.state === 'broken'
                  ? `${gate.verdict.workload}: ${gate.verdict.reason}`
                  : 'workloads did not settle',
              stepsRun: done,
            };
          }
        }
        break;
      }

      case 'verify_limits_ready': {
        // Re-read rather than trusting that ensure_limit_range ran. That
        // coupling holds today only because buildMigrationPlan always emits
        // the step first; a later "skip if it already exists" optimisation
        // would silently make this check vacuous.
        const readiness = assessLimitsCpuReadiness(
          await fx.limitRangeExists(),
          await fx.readPodCpuLimits(),
          fx.quotaScopePriorityClass,
        );
        if (!readiness.ready) {
          // Stop SHORT of the quota rather than forcing it. Everything so far
          // is a pure improvement; adding limits.cpu now is the one step that
          // could take the tenant down later.
          return {
            status: 'failed',
            afterStep: step.label,
            reason: `${readiness.reason}${readiness.blockingPods.length ? ` (${readiness.blockingPods.join(', ')})` : ''}`,
            stepsRun: done,
          };
        }
        break;
      }

      case 'apply_quota_limits':
        await fx.applyQuotaLimits(input.burstCores, quotaTiers(input.deployments));
        break;

      case 'mark_tiered':
        await fx.markTiered();
        break;
    }
    } catch (err) {
      return failed(step, err);
    }
    done += 1;
  }

  await fx.report(100, 'Migration complete');
  return { status: 'completed', freedMillis: freed, stepsRun: done };
}
