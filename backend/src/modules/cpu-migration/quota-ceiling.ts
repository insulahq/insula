/**
 * What the DATABASE believes a tenant's CPU model is (ADR-062).
 *
 * `applyResourceQuota` reads the live quota and preserves what it finds,
 * which is right for a caller that holds no tenant row. A caller that DOES
 * hold one can say more: that a tiered tenant is missing its ceiling and
 * should get it back, or that a legacy tenant is carrying one it should not.
 * Both statements are only safe with the in-flight check below, so the two
 * live together rather than being re-derived per caller.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { CpuTier } from '@insula/api-contracts';
import type { TenantCpuModel } from '../k8s-provisioner/service.js';
import { resolveTenantCpu, type CpuSchedulingMode } from './resolve.js';
import { QUOTA_LIMITS_CPU_BACKSTOP } from './tiered-namespace.js';

/** The task kind the migration runner claims under. */
const TASK_KIND = 'cpu_migration';

/**
 * Tenant ids with a CPU migration or revert in flight.
 *
 * ★ The window is real and it is not short. A migration installs the quota
 * ceiling several steps BEFORE it marks the tenant tiered, and a revert
 * removes the ceiling as its FIRST step and marks the tenant legacy as its
 * last — with every deployment restored and every capped pod rolled in
 * between. Both orderings are deliberate: they are what makes a crash
 * recoverable. But they mean the database and the cluster disagree on
 * purpose for minutes at a time, and a writer that trusted the database
 * would undo the step the runner had just taken. Reverting a tenant across
 * an API restart would have left it legacy with a ceiling nothing removes,
 * and a legacy pod declares no CPU limit — so the quota would refuse every
 * deploy that tenant made from then on.
 *
 * 15 minutes matches the staleness rule the runner itself uses to decide a
 * task is dead: every step reports before it starts, so silence that long
 * means no process is driving it.
 */
export async function tenantsMidCpuChange(db: Database): Promise<ReadonlySet<string>> {
  const rows = await db.execute<{ ref_id: string }>(sql`
    SELECT ref_id FROM tasks
     WHERE kind = ${TASK_KIND}
       AND status IN ('running', 'queued')
       AND updated_at >= NOW() - INTERVAL '15 minutes'
       AND ref_id IS NOT NULL
  `);
  return new Set((rows.rows ?? []).map((r) => r.ref_id));
}

/** The columns this needs, from a tenant row left-joined to its plan. */
export interface TenantCpuRow {
  readonly id: string;
  readonly cpuSchedulingMode: string | null;
  readonly cpuTierOverride: string | null;
  readonly cpuBurstCoresOverride: string | number | null;
  readonly cpuLimitOverride: string | number | null;
  readonly cpuLimit: string | number | null;
  readonly planCpuTier: string | null;
  readonly planCpuBurstCores: string | number | null;
}

/**
 * The model to hand `applyResourceQuota`, or undefined for "say nothing".
 *
 * Undefined is not a failure — it is the instruction to leave the CPU keys
 * exactly as the cluster has them, which is correct whenever the database
 * cannot be trusted to describe the cluster.
 */
export function cpuModelForTenant(
  row: TenantCpuRow,
  midChange: ReadonlySet<string>,
  log?: { warn: (obj: object, msg?: string) => void },
): TenantCpuModel | undefined {
  if (midChange.has(row.id)) return undefined;
  if (row.cpuSchedulingMode !== 'tiered') return { mode: 'legacy' };

  const resolved = resolveTenantCpu(
    {
      cpuLimit: row.cpuLimit,
      cpuTier: row.planCpuTier as CpuTier | null,
      cpuBurstCores: row.planCpuBurstCores,
    },
    {
      cpuSchedulingMode: row.cpuSchedulingMode as CpuSchedulingMode,
      cpuLimitOverride: row.cpuLimitOverride,
      cpuTierOverride: row.cpuTierOverride as CpuTier | null,
      cpuBurstCoresOverride: row.cpuBurstCoresOverride,
    },
  );
  // A tiered tenant whose burst resolves to nothing usable. Saying so beats
  // both alternatives: writing `limits.cpu: "0"` freezes the namespace, and
  // quietly calling the tenant legacy would strip a ceiling it should keep.
  if (resolved.burstCores === null || !(resolved.burstCores > 0)) {
    log?.warn(
      { tenantId: row.id, burstCores: resolved.burstCores },
      'cpu-ceiling: tiered tenant with no usable burst ceiling; leaving its CPU keys alone',
    );
    return undefined;
  }
  return {
    mode: 'tiered',
    ceilingCores: Math.round(resolved.burstCores * QUOTA_LIMITS_CPU_BACKSTOP * 100) / 100,
  };
}
