/**
 * Boot-time reconciliation: re-apply every existing tenant ResourceQuota
 * with the new shape (no SYSTEM_*_RESERVE padding, scopeSelector matching
 * `tenant-default` PriorityClass).
 *
 * Idempotent. Safe to run on every boot — quotas that already match the
 * target shape are left alone (server-side replace is a no-op for byte-
 * identical specs). Quotas whose scopeSelector field is immutable (set
 * to a different scope or unset) are deleted + recreated by
 * applyResourceQuota's existing fallback path.
 *
 * RBAC: platform-api ServiceAccount already has cluster-wide
 * list/get/create/replace/delete on resourcequotas (used by the original
 * applyResourceQuota path).
 */

import type { Database } from '../../db/index.js';
import { tenants, hostingPlans } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { applyResourceQuota, type TenantCpuModel } from './service.js';
import { resolveTenantCpu, type CpuSchedulingMode } from '../cpu-migration/resolve.js';
import { QUOTA_LIMITS_CPU_BACKSTOP } from '../cpu-migration/tiered-namespace.js';
import type { CpuTier } from '@insula/api-contracts';
import type { K8sClients } from './k8s-client.js';

interface ReconcileResult {
  readonly scanned: number;
  readonly reconciled: number;
  readonly skipped: number;
  readonly errors: ReadonlyArray<{ tenantId: string; error: string }>;
}

export async function reconcileAllTenantQuotas(
  db: Database,
  k8s: K8sClients,
  log: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void },
): Promise<ReconcileResult> {
  const rows = await db
    .select({
      id: tenants.id,
      namespace: tenants.kubernetesNamespace,
      planId: tenants.planId,
      cpuLimitOverride: tenants.cpuLimitOverride,
      memoryLimitOverride: tenants.memoryLimitOverride,
      storageLimitOverride: tenants.storageLimitOverride,
      cpuSchedulingMode: tenants.cpuSchedulingMode,
      cpuTierOverride: tenants.cpuTierOverride,
      cpuBurstCoresOverride: tenants.cpuBurstCoresOverride,
      cpuLimit: hostingPlans.cpuLimit,
      memoryLimit: hostingPlans.memoryLimit,
      storageLimit: hostingPlans.storageLimit,
      planCpuTier: hostingPlans.cpuTier,
      planCpuBurstCores: hostingPlans.cpuBurstCores,
    })
    .from(tenants)
    .leftJoin(hostingPlans, eq(hostingPlans.id, tenants.planId));

  // Tenants whose CPU model is being changed RIGHT NOW. One query, not one
  // per row: with 30 tenants the per-row version is 30 round trips to save
  // nothing.
  const midChange = await tenantsMidCpuChange(db);
  if (midChange.size > 0) {
    log.info(
      { tenants: [...midChange] },
      'quota-reconcile: leaving CPU keys alone for tenants with a migration in flight',
    );
  }

  let reconciled = 0;
  let skipped = 0;
  const errors: Array<{ tenantId: string; error: string }> = [];

  for (const c of rows) {
    const effectiveCpu = c.cpuLimitOverride ?? c.cpuLimit;
    const effectiveMemory = c.memoryLimitOverride ?? c.memoryLimit;
    const effectiveStorage = c.storageLimitOverride ?? c.storageLimit;
    if (!c.namespace || !effectiveCpu || !effectiveMemory || !effectiveStorage) {
      skipped++;
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await applyResourceQuota(k8s, c.namespace, {
        cpu: String(effectiveCpu),
        memory: String(effectiveMemory),
        storage: String(effectiveStorage),
      }, { cpuModel: cpuModelFor(c, midChange, log) });
      reconciled++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ tenantId: c.id, error: msg });
      log.warn(
        { tenantId: c.id, namespace: c.namespace, err: msg },
        'quota-reconcile: failed for tenant; will retry on next boot',
      );
    }
  }

  log.info(
    { scanned: rows.length, reconciled, skipped, errors: errors.length },
    'quota-reconcile: done (auto-applied scopeSelector + plan-exact limits)',
  );

  return { scanned: rows.length, reconciled, skipped, errors };
}

/**
 * Tenant ids with a CPU migration or revert in flight.
 *
 * ★ The window is real and it is not short. A migration installs the quota
 * ceiling several steps BEFORE it marks the tenant tiered, and a revert
 * removes the ceiling as its FIRST step and marks the tenant legacy as its
 * last — with every deployment restored and every capped pod rolled in
 * between. Both orderings are deliberate: they are what makes a crash
 * recoverable. But they mean the database and the cluster disagree on
 * purpose for minutes at a time, and a boot sweep that trusted the database
 * would undo the step the runner had just taken. Reverting a tenant across
 * an API restart would have left it legacy with a ceiling nothing removes,
 * and a legacy pod declares no CPU limit — so the quota would refuse every
 * deploy that tenant made from then on.
 *
 * 15 minutes matches the staleness rule the runner itself uses to decide a
 * task is dead (runner.ts): every step reports before it starts, so silence
 * that long means no process is driving it.
 */
async function tenantsMidCpuChange(db: Database): Promise<ReadonlySet<string>> {
  const rows = await db.execute<{ ref_id: string }>(sql`
    SELECT ref_id FROM tasks
     WHERE kind = 'cpu_migration'
       AND status IN ('running', 'queued')
       AND updated_at >= NOW() - INTERVAL '15 minutes'
       AND ref_id IS NOT NULL
  `);
  return new Set((rows.rows ?? []).map((r) => r.ref_id));
}

interface CpuModelRow {
  id: string;
  cpuSchedulingMode: string | null;
  cpuTierOverride: string | null;
  cpuBurstCoresOverride: string | null;
  cpuLimitOverride: string | null;
  cpuLimit: string | null;
  planCpuTier: string | null;
  planCpuBurstCores: string | null;
}

/**
 * What to tell `applyResourceQuota` about this tenant's CPU model.
 *
 * Restores a ceiling this sweep's own predecessor destroyed: it used to
 * write a CPU key set with no `limits.cpu` at all, so every boot sweep, plan
 * edit and tenant edit silently removed the burst ceiling the migration had
 * installed. On a production cluster fourteen of thirty namespaces had lost
 * theirs within two hours of being migrated. This hands them back on the
 * next boot, with no operator action.
 *
 * Only the ceiling. `requests.cpu` is sized by the migration from live pod
 * facts and is not reconstructible from the database — and it is a cap, not
 * a reservation, so a damaged namespace sitting at its plan value costs
 * nothing while it waits.
 */
function cpuModelFor(
  row: CpuModelRow,
  midChange: ReadonlySet<string>,
  log: { warn: (obj: object, msg?: string) => void },
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
  // quietly claiming the tenant is legacy would strip a ceiling it should
  // have kept.
  if (resolved.burstCores === null || !(resolved.burstCores > 0)) {
    log.warn(
      { tenantId: row.id, burstCores: resolved.burstCores },
      'quota-reconcile: tiered tenant with no usable burst ceiling; leaving its CPU keys alone',
    );
    return undefined;
  }
  return {
    mode: 'tiered',
    ceilingCores: Math.round(resolved.burstCores * QUOTA_LIMITS_CPU_BACKSTOP * 100) / 100,
  };
}
