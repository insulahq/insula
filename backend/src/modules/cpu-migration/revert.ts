/**
 * Put a tenant back exactly as it was (ADR-062 R2).
 *
 * The migration is only as safe as this is faithful. "Revert" here means
 * RESTORE — the stored prior request, character for character — never
 * recompute something equivalent. A recomputed value would silently hand the
 * tenant a different reservation during the very operation meant to undo a
 * change, and the operator would have no way to tell.
 */

import { type CpuTier } from '@insula/api-contracts';

export interface RevertibleDeployment {
  readonly id: string;
  readonly name: string;
  readonly currentCpuRequest: string;
  /** NULL when this deployment was never migrated. */
  readonly cpuRequestPreMigration: string | null;
}

export interface RevertStep {
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly toCpuRequest: string;
}

export interface RevertPlan {
  readonly steps: readonly RevertStep[];
  /** Never migrated, or already back — nothing to undo. */
  readonly untouched: readonly string[];
  /**
   * ★ Migrated, but the stored baseline cannot be honoured. Reported rather
   * than guessed: the operator has to know which deployments this revert
   * does NOT restore, instead of discovering later that one came back with a
   * number nobody chose.
   */
  readonly unrestorable: ReadonlyArray<{ name: string; reason: string }>;
}

export function buildRevertPlan(deployments: readonly RevertibleDeployment[]): RevertPlan {
  const steps: RevertStep[] = [];
  const untouched: string[] = [];
  const unrestorable: Array<{ name: string; reason: string }> = [];

  for (const d of deployments) {
    if (d.cpuRequestPreMigration === null) {
      untouched.push(d.name);
      continue;
    }
    if (d.cpuRequestPreMigration.trim() === '') {
      unrestorable.push({ name: d.name, reason: 'stored prior request is empty' });
      continue;
    }
    if (d.cpuRequestPreMigration === d.currentCpuRequest) {
      // Already back — a re-run of a revert must not churn pods.
      untouched.push(d.name);
      continue;
    }
    steps.push({
      deploymentId: d.id,
      deploymentName: d.name,
      toCpuRequest: d.cpuRequestPreMigration,
    });
  }

  return { steps, untouched, unrestorable };
}

export interface RevertEffects {
  /** Restore the request AND clear the stored baseline, together. */
  readonly restore: (deploymentId: string, toCpuRequest: string) => Promise<void>;
  readonly removeQuotaLimits: () => Promise<void>;
  readonly removeLimitRange: () => Promise<void>;
  /**
   * Roll every pod still carrying a CPU ceiling, and report how many.
   *
   * ★ Removing the LimitRange does NOT unthrottle anything already running.
   * A LimitRange default is baked into a pod's spec at ADMISSION; the pod
   * keeps it for life. Only deployments that were re-tiered get restored
   * above (they have a stored baseline) — a deployment that was merely
   * RECREATED, because its request already equalled its tier, has no
   * baseline and would never be touched. Its pods would stay capped forever
   * after a "clean" revert, silently throttled in a way legacy mode never
   * is, and nothing in the result would say so.
   */
  readonly rollPodsStillCapped: () => Promise<number>;
  readonly markLegacy: () => Promise<void>;
  readonly report: (pct: number, text: string) => Promise<void>;
}

export type RevertOutcome =
  | {
      readonly status: 'completed';
      readonly restored: number;
      readonly unrestorable: number;
      /** Pods rolled purely to shed a ceiling they were admitted with. */
      readonly uncapped: number;
    }
  | { readonly status: 'failed'; readonly reason: string; readonly restored: number };

/**
 * ★ The order is the mirror image of the migration.
 *
 * 1. The quota ceiling comes OFF FIRST. While `limits.cpu` is on the quota it
 *    caps the sum of declared container limits, so restoring a workload to
 *    its larger original request can be refused for exceeding a ceiling the
 *    migration itself installed. A revert must not be blocked by its own
 *    leftovers.
 * 2. The LimitRange comes off SECOND — before any pod is recreated, not
 *    after. An earlier version removed it last, reasoning that pods
 *    recreated mid-revert should still inherit "a sane ceiling". That was
 *    backwards: the whole point of reverting is to return to legacy, where
 *    there is NO ceiling. Leaving the range in place while pods are
 *    recreated re-applies the very cap being removed, and since a
 *    LimitRange default is baked in at admission those pods keep it for
 *    life.
 * 3. Then the restores, whose new pods are admitted with no ceiling.
 * 4. Then a sweep for anything still capped — the deployments that were
 *    recreated rather than re-tiered, which have no baseline to restore.
 */
export async function runTenantCpuRevert(
  fx: RevertEffects,
  plan: RevertPlan,
): Promise<RevertOutcome> {
  let restored = 0;
  const total = plan.steps.length + 4;
  const step = async (n: number, text: string) => fx.report(Math.round((n / total) * 100), text);

  let uncapped = 0;
  try {
    await step(0, 'Remove the namespace burst ceiling');
    await fx.removeQuotaLimits();

    await step(1, 'Remove the namespace CPU LimitRange');
    await fx.removeLimitRange();

    for (const s of plan.steps) {
      await step(restored + 2, `Restore ${s.deploymentName} to ${s.toCpuRequest}`);
      await fx.restore(s.deploymentId, s.toCpuRequest);
      restored += 1;
    }

    await step(total - 1, 'Release any pod still holding a CPU ceiling');
    uncapped = await fx.rollPodsStillCapped();

    await step(total, 'Return the tenant to legacy scheduling');
    await fx.markLegacy();
  } catch (err) {
    // A partially reverted tenant is still legacy-shaped and serviceable, but
    // the operator must be told how far it got — "revert failed" without a
    // count is unactionable.
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      restored,
    };
  }

  await fx.report(100, 'Revert complete');
  return { status: 'completed', restored, unrestorable: plan.unrestorable.length, uncapped };
}

/** Tier a reverted tenant reports until it is migrated again. */
export const REVERTED_TIER: CpuTier | null = null;
