/**
 * What a tenant's CPU number MEANS on a tenant-facing screen (ADR-062).
 *
 * ★ One definition, because there were three.
 *
 * Every tenant surface — the header chip, the dashboard tile, the usage
 * page, the metrics modal — prints usage against `cpu.available`, and that
 * was the plan's `cpu_limit`: a RESERVATION. Under the tier model a tenant
 * does not have a CPU reservation. What they have is a share, which is not
 * a quantity usage can be measured against, and a burst ceiling, which is
 * exactly that quantity: the most their application may actually use.
 *
 * Printing "0.00 / 2.0" of a reservation is the reading this ADR exists to
 * prevent — it is not a number the tenant can act on, and it made a machine
 * at 20% look full. Against the ceiling the same chip says something true
 * and useful.
 *
 * Memory and storage are unchanged: both are real allowances a tenant
 * genuinely holds.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { hostingPlans } from '../../db/schema.js';
import { resolveTenantCpu } from '../cpu-migration/resolve.js';

export interface TenantDisplayLimits {
  readonly cpuLimit: number;
  readonly memoryLimitGi: number;
  readonly storageLimitGi: number;
  /**
   * Is `cpuLimit` a ceiling on USE (tiered) or a reservation (legacy)?
   *
   * The console tiles already branch on exactly this distinction — a
   * `consume` triad hides the reservation band and relabels the remainder
   * "Free" — so handing them the right word is all that is needed.
   */
  readonly cpuKind: 'reserve' | 'consume';
}

/**
 * ★ Every CPU field is REQUIRED, deliberately.
 *
 * They were optional, and TypeScript therefore accepted a caller whose
 * query had not selected them — which is exactly what the hourly metrics
 * scheduler did. `cpuSchedulingMode` was `undefined` at runtime for every
 * tenant, so every tenant resolved to `legacy`, and a tiered tenant using
 * 0.30 cores was measured against its old 0.25-core reservation and paged
 * an admin with a CRITICAL saturation alert. Hourly. Forever.
 *
 * Required means a caller that forgets a column fails to compile, which is
 * the only place this class of bug is cheap to find.
 */
interface TenantCpuRow {
  readonly planId: string | null;
  readonly cpuLimitOverride: string | number | null;
  readonly cpuSchedulingMode: string | null;
  readonly cpuTierOverride: 'normal' | 'high' | 'highest' | null;
  readonly cpuBurstCoresOverride: string | number | null;
  readonly memoryLimitOverride: string | number | null;
  readonly storageLimitOverride: string | number | null;
}

interface PlanRow {
  readonly cpuLimit: string | number | null;
  readonly cpuTier: 'normal' | 'high' | 'highest' | null;
  readonly cpuBurstCores: string | number | null;
  readonly memoryLimit: string | number | null;
  readonly storageLimit: string | number | null;
}

/** The synchronous half, for callers that already hold the plan row. */
export function tenantDisplayLimits(
  tenant: TenantCpuRow,
  plan: PlanRow | undefined,
): TenantDisplayLimits {
  const legacyCpu = Number(tenant.cpuLimitOverride ?? plan?.cpuLimit ?? 2);
  const resolved = resolveTenantCpu(
    plan ? { cpuLimit: plan.cpuLimit, cpuTier: plan.cpuTier, cpuBurstCores: plan.cpuBurstCores } : null,
    {
      cpuSchedulingMode: tenant.cpuSchedulingMode === 'tiered' ? 'tiered' : 'legacy',
      cpuLimitOverride: tenant.cpuLimitOverride,
      cpuTierOverride: tenant.cpuTierOverride,
      cpuBurstCoresOverride: tenant.cpuBurstCoresOverride,
    },
  );
  // ONE test for "is this tenant tiered", and it is the resolver's own
  // answer. A second, independent one here — `mode === 'tiered' &&
  // burstCores > 0` — is how three call sites came to disagree in the
  // first place. The resolver's tiered branch always floors burstCores at
  // 1 (ceilingCores), so the `??` below is a type guard, not a policy.
  const tiered = resolved.mode === 'tiered';
  return {
    cpuLimit: tiered ? (resolved.burstCores ?? legacyCpu) : legacyCpu,
    cpuKind: tiered ? 'consume' : 'reserve',
    memoryLimitGi: Number(tenant.memoryLimitOverride ?? plan?.memoryLimit ?? 4),
    storageLimitGi: Number(tenant.storageLimitOverride ?? plan?.storageLimit ?? 50),
  };
}

/** The same, fetching the plan. */
export async function resolveTenantDisplayLimits(
  db: Database,
  tenant: TenantCpuRow,
): Promise<TenantDisplayLimits> {
  const [plan] = tenant.planId
    ? await db.select().from(hostingPlans).where(eq(hostingPlans.id, tenant.planId))
    : [undefined];
  return tenantDisplayLimits(tenant, plan);
}
