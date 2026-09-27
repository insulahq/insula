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
  readonly markLegacy: () => Promise<void>;
  readonly report: (pct: number, text: string) => Promise<void>;
}

export type RevertOutcome =
  | { readonly status: 'completed'; readonly restored: number; readonly unrestorable: number }
  | { readonly status: 'failed'; readonly reason: string; readonly restored: number };

/**
 * ★ The order is the mirror image of the migration, and has to be.
 *
 * The quota ceiling comes OFF FIRST. `limits.cpu` on the quota caps the sum of
 * declared container limits; while it is in place, restoring a workload to a
 * larger request — and, via the LimitRange default, a limit — can be refused
 * for exceeding it. Removing the ceiling first means every restore lands in a
 * namespace that cannot reject it for a reason the revert itself created.
 *
 * The LimitRange comes off LAST, after the restores, for the same reason in
 * reverse: while pods are being recreated they should still inherit a sane
 * ceiling rather than briefly having none.
 */
export async function runTenantCpuRevert(
  fx: RevertEffects,
  plan: RevertPlan,
): Promise<RevertOutcome> {
  let restored = 0;
  const total = plan.steps.length + 3;
  const step = async (n: number, text: string) => fx.report(Math.round((n / total) * 100), text);

  try {
    await step(0, 'Remove the namespace burst ceiling');
    await fx.removeQuotaLimits();

    for (const s of plan.steps) {
      await step(restored + 1, `Restore ${s.deploymentName} to ${s.toCpuRequest}`);
      await fx.restore(s.deploymentId, s.toCpuRequest);
      restored += 1;
    }

    await step(total - 2, 'Remove the namespace CPU LimitRange');
    await fx.removeLimitRange();

    await step(total - 1, 'Return the tenant to legacy scheduling');
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
  return { status: 'completed', restored, unrestorable: plan.unrestorable.length };
}

/** Tier a reverted tenant reports until it is migrated again. */
export const REVERTED_TIER: CpuTier | null = null;
