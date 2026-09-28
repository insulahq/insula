/**
 * The CPU migration dry run (ADR-062, R1).
 *
 * Read-only. Answers, for every tenant: what it reserves today, what the tier
 * model would reserve instead, the burst ceiling its plan would grant, and
 * whether a human has to look at it first.
 *
 * This is the release that makes the migration adoptable. Nobody opts into a
 * scheduling-model change described in an ADR; an operator shown six
 * reserved-and-unused cores on their own cluster will act. So the numbers here
 * have to be the operator's own, and they have to be right.
 */

import { eq, sql } from 'drizzle-orm';
import type { CpuMigrationPreview, CpuMigrationTenant, CpuMigrationDeployment } from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { catalogRepositories } from '../../db/schema.js';
import { DEFAULT_CATALOG_URL } from '../catalog/service.js';
import { describeDeployment } from './describe.js';
import { readCpuReservation, cpuToMillis } from '../dashboard/cpu-reservation.js';
import { tierMillis, ceilingCores, blockerFor, tenantUsageBlocker, reclaimFor } from './tiers.js';
import { resolveTenantCpu, DEFAULT_TIER } from './resolve.js';
import { CPU_TIER_MILLICORES, type CpuTier } from '@insula/api-contracts';

interface DeploymentRow extends Record<string, unknown> {
  id: string;
  name: string;
  tenant_id: string;
  cpu_request: string | null;
  source: 'catalog' | 'custom';
  custom_spec: unknown;
  entry_resources: unknown;
  source_repo_id: string | null;
}

interface TenantRow extends Record<string, unknown> {
  id: string;
  name: string;
  kubernetes_namespace: string | null;
  plan_code: string | null;
  cpu_scheduling_mode: 'legacy' | 'tiered';
  cpu_limit: string | null;
  cpu_limit_override: string | null;
  cpu_tier: CpuTier | null;
  cpu_tier_override: CpuTier | null;
  cpu_burst_cores: string | null;
  cpu_burst_cores_override: string | null;
}

/** What a namespace's LimitRange actually imposes. */
interface AppliedCpu {
  readonly ceilingCores: number;
  readonly tier: CpuTier | null;
}

/** Millicores back to the tier that produces them, or null if it is none of them. */
function tierForMillis(millis: number): CpuTier | null {
  const hit = (Object.entries(CPU_TIER_MILLICORES) as Array<[CpuTier, number]>)
    .find(([, m]) => m === millis);
  return hit ? hit[0] : null;
}

/**
 * The ceiling and default tier every tenant namespace currently enforces.
 *
 * ONE list call for the whole cluster. Per-tenant reads would be thirty
 * round trips on a page an operator refreshes while watching a migration.
 * A failure here must not fail the dry run — the report is still true
 * without it, it just cannot say whether a change is pending — so it warns
 * and returns empty.
 */
async function readAppliedCeilings(
  k8s: K8sClients,
  log?: { warn?: (o: unknown, m: string) => void },
): Promise<Map<string, AppliedCpu>> {
  const out = new Map<string, AppliedCpu>();
  try {
    const list = await (k8s.core as unknown as {
      listLimitRangeForAllNamespaces: () => Promise<{
        items?: ReadonlyArray<{
          metadata?: { name?: string; namespace?: string };
          spec?: { limits?: ReadonlyArray<{
            type?: string;
            default?: Record<string, string>;
            defaultRequest?: Record<string, string>;
          }> };
        }>;
      }>;
    }).listLimitRangeForAllNamespaces();
    for (const lr of list.items ?? []) {
      const ns = lr.metadata?.namespace;
      // The tier LimitRange specifically — a namespace may carry others.
      if (!ns || lr.metadata?.name !== `${ns}-cpu`) continue;
      const container = (lr.spec?.limits ?? []).find((l) => l.type === 'Container');
      const ceiling = cpuToMillis(container?.default?.cpu);
      if (!ceiling) continue;
      out.set(ns, {
        ceilingCores: Math.round((ceiling / 1000) * 100) / 100,
        tier: tierForMillis(cpuToMillis(container?.defaultRequest?.cpu)),
      });
    }
  } catch (err) {
    log?.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      'cpu-migration: could not read namespace LimitRanges — the report cannot say whether a tier change is pending',
    );
  }
  return out;
}

/**
 * A custom deployment "declares its own resources" when its spec pins CPU on
 * any service. Those are the operator's numbers (ADR-036) and not ours to
 * overwrite with a tier.
 */
export function customSpecPinsCpu(spec: unknown): boolean {
  if (!spec || typeof spec !== 'object') return false;
  const services = (spec as { services?: unknown }).services;
  const list = Array.isArray(services) ? services : Object.values(services ?? {});
  return list.some((s) => {
    const r = (s as { resources?: { cpuRequest?: unknown; cpu?: unknown } } | null)?.resources;
    return Boolean(r && (r.cpuRequest !== undefined || r.cpu !== undefined));
  });
}

export async function buildCpuMigrationPreview(
  db: Database,
  k8s: K8sClients,
  log?: { warn?: (o: unknown, m: string) => void },
): Promise<CpuMigrationPreview> {
  const officialRepo = await db
    .select({ id: catalogRepositories.id })
    .from(catalogRepositories)
    .where(eq(catalogRepositories.url, DEFAULT_CATALOG_URL));
  const officialRepoId = officialRepo[0]?.id ?? null;

  const tenantRows = await db.execute<TenantRow>(sql`
    SELECT t.id, t.name, t.kubernetes_namespace, p.code AS plan_code,
           p.cpu_limit, p.cpu_tier, p.cpu_burst_cores,
           t.cpu_limit_override, t.cpu_tier_override, t.cpu_burst_cores_override,
           t.cpu_scheduling_mode
      FROM tenants t LEFT JOIN hosting_plans p ON p.id = t.plan_id
     ORDER BY t.name
  `);

  // What each namespace ENFORCES today, in one call rather than one per
  // tenant. A tenant whose database row and LimitRange disagree has a change
  // waiting to be applied, and nothing else in the platform can see it.
  const appliedByNamespace = await readAppliedCeilings(k8s, log);

  // Same 15-minute staleness rule the apply guard uses: a run that has not
  // reported in that long is a dead process, not an active migration, and
  // showing a Stop button for it would be a lie.
  const runningRows = await db.execute<{ ref_id: string }>(sql`
    SELECT ref_id FROM tasks
     WHERE kind = 'cpu_migration' AND status IN ('running', 'queued')
       AND updated_at >= NOW() - INTERVAL '15 minutes'
  `).catch(() => ({ rows: [] as Array<{ ref_id: string }> }));
  const runningTenantIds = new Set((runningRows.rows ?? []).map((r) => r.ref_id));

  const deploymentRows = await db.execute<DeploymentRow>(sql`
    SELECT d.id, d.name, d.tenant_id, d.cpu_request, d.source,
           d.custom_spec, e.resources AS entry_resources, e.source_repo_id
      FROM deployments d
      LEFT JOIN catalog_entries e ON e.id = d.catalog_entry_id
     -- Only deployments that actually hold a reservation. A 'stopped'
     -- deployment has had its pod torn down, so counting its cpu_request
     -- would inflate currentMillis/reclaimableMillis against the
     -- reservedMillis in the same payload — which is read from live pods.
     -- Two numbers presented side by side must answer the same question.
     WHERE d.status = 'running'
     ORDER BY d.name
  `);

  /**
   * Tenant p95 over 7 days of hourly samples.
   *
   * ★ Tenant-level because `usage_metrics.deployment_id` is NULL on every CPU
   * row — a per-deployment p95 does not exist to be read. The ceiling this is
   * compared against is tenant-wide anyway, so this is also the granularity
   * at which the question is meaningful.
   */
  const p95Rows = await db.execute<{ tenant_id: string; p95: string | null }>(sql`
    SELECT tenant_id,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95
      FROM usage_metrics
     WHERE "metricType" = 'cpu_cores'
       AND resolution = 'hourly'
       AND measurement_timestamp > now() - interval '7 days'
     GROUP BY tenant_id
  `).catch((err: unknown) => {
    // NOT silent. This feeds tenantUsageBlocker for EVERY tenant, so a broken
    // query renders as "no usage data, all tenants need review" — plausible
    // output with nothing distinguishing it from the genuine case.
    log?.warn?.(
      { err: err instanceof Error ? err.message : String(err) },
      'cpu-migration: tenant p95 query failed — every tenant will report as unsampled',
    );
    return { rows: [] as Array<{ tenant_id: string; p95: string | null }> };
  });
  const p95ByTenant = new Map<string, number>();
  for (const r of p95Rows.rows ?? []) {
    if (r.p95 !== null) p95ByTenant.set(r.tenant_id, Number(r.p95) * 1000);
  }

  const byTenant = new Map<string, DeploymentRow[]>();
  for (const d of deploymentRows.rows ?? []) {
    const list = byTenant.get(d.tenant_id) ?? [];
    list.push(d);
    byTenant.set(d.tenant_id, list);
  }

  const tenants: CpuMigrationTenant[] = [];
  let reclaimable = 0;

  for (const t of tenantRows.rows ?? []) {
    /**
     * ★ The SAME resolver the runner uses.
     *
     * This used to be `ceilingCores(cpu_limit_override ?? cpu_limit)`, which
     * ignores `cpu_burst_cores` and `cpu_burst_cores_override` completely —
     * so an operator who set a burst on a plan saw the derived number here
     * and got the configured one when they applied it. Deriving the same
     * quantity twice is the defect describe.ts was written to remove; it had
     * survived on the ceiling axis.
     */
    const resolved = resolveTenantCpu(
      { cpuLimit: t.cpu_limit, cpuTier: t.cpu_tier, cpuBurstCores: t.cpu_burst_cores },
      {
        cpuSchedulingMode: 'tiered',
        cpuLimitOverride: t.cpu_limit_override,
        cpuTierOverride: t.cpu_tier_override,
        cpuBurstCoresOverride: t.cpu_burst_cores_override,
      },
    );
    const ceiling = resolved.burstCores ?? ceilingCores(null);
    const tier = resolved.tier ?? DEFAULT_TIER;
    const applied = t.kubernetes_namespace
      ? appliedByNamespace.get(t.kubernetes_namespace) ?? null
      : null;
    const mode = t.cpu_scheduling_mode ?? 'legacy';
    // Only meaningful for a tiered tenant: a legacy one has no LimitRange
    // and is not "pending", it is un-migrated.
    const pendingCpuChange = mode === 'tiered' && applied !== null
      && (applied.ceilingCores !== ceiling || applied.tier !== tier);
    const p95 = p95ByTenant.has(t.id) ? p95ByTenant.get(t.id)! : null;
    const tenantBlocker = tenantUsageBlocker(p95, ceiling);

    let tenantReclaim = 0;
    let tenantIncrease = 0;
    const deployments: CpuMigrationDeployment[] = (byTenant.get(t.id) ?? []).map((d) => {
      // ★ The SAME function the apply runs on. Deriving the tier twice, once
      // here and once in the runner, is how the operator came to approve one
      // plan and get another — see describe.ts.
      const f = describeDeployment(d, officialRepoId, tier);
      // Accumulated per DEPLOYMENT, then summed — the tenant row and the
      // cluster headline are therefore the same operation at two scopes, and
      // the columns add up to the total by construction rather than by luck.
      const freed = reclaimFor(f.currentMillis, f.proposedMillis);
      tenantReclaim += freed;
      tenantIncrease += Math.max(0, f.proposedMillis - f.currentMillis);
      reclaimable += freed;
      return {
        id: f.id,
        name: f.name,
        currentMillis: f.currentMillis,
        proposedMillis: f.proposedMillis,
        proposedTier: f.proposedTier,
        blocker: f.blocker,
      };
    });

    tenants.push({
      tenantId: t.id,
      tenantName: t.name,
      planCode: t.plan_code,
      currentMillis: deployments.reduce((s, d) => s + d.currentMillis, 0),
      proposedMillis: deployments.reduce((s, d) => s + d.proposedMillis, 0),
      reclaimableMillis: tenantReclaim,
      increasedMillis: tenantIncrease,
      proposedCeilingCores: ceiling,
      proposedTier: tier,
      appliedCeilingCores: applied?.ceilingCores ?? null,
      appliedTier: applied?.tier ?? null,
      pendingCpuChange,
      observedP95Millis: p95,
      tenantBlocker,
      migratesCleanly: tenantBlocker === null && deployments.every((d) => d.blocker === null),
      schedulingMode: mode,
      migrationRunning: runningTenantIds.has(t.id),
      deployments,
    });
  }

  // Cluster totals, from the same reader the dashboard finding uses so the
  // two can never disagree about what "reserved" means.
  const { nodes } = await readCpuReservation(k8s, log);
  const allocatableMillis = nodes.reduce((s, n) => s + n.allocatableMillis, 0);
  const reservedMillis = nodes.reduce((s, n) => s + n.requestedMillis, 0);
  // ★ One unmeasured node makes the CLUSTER figure unknown, not smaller.
  // Folding an unmeasured node in as 0 understates usage — and understated
  // usage widens the reserved-versus-used gap, which is the single number
  // this whole report exists to state honestly. `sumUsage` in
  // dashboard/admin-service.ts already establishes this rule for the same
  // measurement; an earlier revision here did the opposite.
  const usedMillis = nodes.every((n) => n.usedMillis !== null)
    ? nodes.reduce((s, n) => s + (n.usedMillis ?? 0), 0)
    : null;

  return {
    allocatableMillis,
    reservedMillis,
    usedMillis,
    reclaimableMillis: reclaimable,
    tenants,
    needsReviewCount: tenants.filter((t) => !t.migratesCleanly).length,
  };
}
