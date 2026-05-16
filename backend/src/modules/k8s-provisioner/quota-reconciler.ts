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
import { eq } from 'drizzle-orm';
import { applyResourceQuota } from './service.js';
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
      cpuLimit: hostingPlans.cpuLimit,
      memoryLimit: hostingPlans.memoryLimit,
      storageLimit: hostingPlans.storageLimit,
    })
    .from(tenants)
    .leftJoin(hostingPlans, eq(hostingPlans.id, tenants.planId));

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
      });
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
