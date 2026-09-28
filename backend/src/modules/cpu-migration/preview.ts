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
import { deriveTier, tierMillis, ceilingCores, blockerFor, tenantUsageBlocker, reclaimFor } from './tiers.js';

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
  plan_code: string | null;
  cpu_scheduling_mode: 'legacy' | 'tiered';
  cpu_limit: string | null;
  cpu_limit_override: string | null;
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

/**
 * `resources.recommended.cpu` in cores, or null when the manifest is silent.
 *
 * ★ Parsed as a Kubernetes QUANTITY, not with a bare `Number()`. The field may
 * carry millicore notation — `catalog/service.ts:toCpuMilli` handles exactly
 * this shape for the same field — and `Number('50m')` is NaN. A bare parse
 * would return null for it, which deriveTier reads as "the manifest said
 * nothing" and answers `high`: a `50m` entry (normal, per the ADR) forced six
 * tiers up, and a `2000m` entry (highest) forced down. Silent, and wrong in
 * both directions.
 *
 * No entry in the Official catalog uses the notation today — every value is
 * decimal cores — so this is latent there. It is not latent for the community
 * catalog or any third-party repository, which the tier model explicitly
 * supports.
 */
export function recommendedCores(entryResources: unknown): number | null {
  const rec = (entryResources as { recommended?: { cpu?: string } } | null)?.recommended?.cpu;
  if (rec === undefined || rec === null || String(rec).trim() === '') return null;
  const millis = cpuToMillis(String(rec));
  return Number.isFinite(millis) && millis > 0 ? millis / 1000 : null;
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
    SELECT t.id, t.name, p.code AS plan_code, p.cpu_limit, t.cpu_limit_override,
           t.cpu_scheduling_mode
      FROM tenants t LEFT JOIN hosting_plans p ON p.id = t.plan_id
     ORDER BY t.name
  `);

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
    // The tenant override wins over the plan, and 0 is a real value — the
    // same precedence the quota itself is built from.
    const planLimit = t.cpu_limit_override !== null
      ? Number(t.cpu_limit_override)
      : (t.cpu_limit !== null ? Number(t.cpu_limit) : null);
    const ceiling = ceilingCores(planLimit);
    const p95 = p95ByTenant.has(t.id) ? p95ByTenant.get(t.id)! : null;
    const tenantBlocker = tenantUsageBlocker(p95, ceiling);

    let tenantReclaim = 0;
    let tenantIncrease = 0;
    const deployments: CpuMigrationDeployment[] = (byTenant.get(t.id) ?? []).map((d) => {
      // ★ The SAME function the apply runs on. Deriving the tier twice, once
      // here and once in the runner, is how the operator came to approve one
      // plan and get another — see describe.ts.
      const f = describeDeployment(d, officialRepoId);
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
      observedP95Millis: p95,
      tenantBlocker,
      migratesCleanly: tenantBlocker === null && deployments.every((d) => d.blocker === null),
      schedulingMode: t.cpu_scheduling_mode ?? 'legacy',
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
