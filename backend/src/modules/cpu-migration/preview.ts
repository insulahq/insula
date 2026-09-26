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

/** `resources.recommended.cpu` in cores, or null when the manifest is silent. */
export function recommendedCores(entryResources: unknown): number | null {
  const rec = (entryResources as { recommended?: { cpu?: string } } | null)?.recommended?.cpu;
  if (rec === undefined || rec === null || rec === '') return null;
  const n = Number(rec);
  return Number.isFinite(n) ? n : null;
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
    SELECT t.id, t.name, p.code AS plan_code, p.cpu_limit, t.cpu_limit_override
      FROM tenants t LEFT JOIN hosting_plans p ON p.id = t.plan_id
     ORDER BY t.name
  `);

  const deploymentRows = await db.execute<DeploymentRow>(sql`
    SELECT d.id, d.name, d.tenant_id, d.cpu_request, d.source,
           d.custom_spec, e.resources AS entry_resources, e.source_repo_id
      FROM deployments d
      LEFT JOIN catalog_entries e ON e.id = d.catalog_entry_id
     WHERE d.status <> 'deleted'
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
  `).catch(() => ({ rows: [] as Array<{ tenant_id: string; p95: string | null }> }));
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

    const deployments: CpuMigrationDeployment[] = (byTenant.get(t.id) ?? []).map((d) => {
      const currentMillis = cpuToMillis(d.cpu_request ?? undefined);
      const tier = d.source === 'custom'
        // A custom container has no catalog recommendation to derive from.
        // `high` is the safe default: `normal` would quietly starve an app
        // nobody sized.
        ? 'high' as const
        : deriveTier(recommendedCores(d.entry_resources));
      const proposedMillis = tierMillis(tier);
      reclaimable += reclaimFor(currentMillis, proposedMillis);
      return {
        id: d.id,
        name: d.name,
        currentMillis,
        proposedMillis,
        proposedTier: tier,
        blocker: blockerFor({
          source: d.source,
          thirdPartyCatalog: d.source === 'catalog'
            && d.source_repo_id !== null
            && d.source_repo_id !== officialRepoId,
          declaresOwnResources: customSpecPinsCpu(d.custom_spec),
        }),
      };
    });

    tenants.push({
      tenantId: t.id,
      tenantName: t.name,
      planCode: t.plan_code,
      currentMillis: deployments.reduce((s, d) => s + d.currentMillis, 0),
      proposedMillis: deployments.reduce((s, d) => s + d.proposedMillis, 0),
      proposedCeilingCores: ceiling,
      observedP95Millis: p95,
      tenantBlocker,
      migratesCleanly: tenantBlocker === null && deployments.every((d) => d.blocker === null),
      deployments,
    });
  }

  // Cluster totals, from the same reader the dashboard finding uses so the
  // two can never disagree about what "reserved" means.
  const { nodes } = await readCpuReservation(k8s, log);
  const allocatableMillis = nodes.reduce((s, n) => s + n.allocatableMillis, 0);
  const reservedMillis = nodes.reduce((s, n) => s + n.requestedMillis, 0);
  const anyUsage = nodes.some((n) => n.usedMillis !== null);
  const usedMillis = anyUsage
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
