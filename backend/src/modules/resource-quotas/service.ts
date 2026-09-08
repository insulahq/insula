import { eq, and, notInArray } from 'drizzle-orm';
import { resourceQuotas, tenants, hostingPlans, deployments } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { parseResourceValue } from '../../shared/resource-parser.js';
import { tenantNotFound } from '../../shared/errors.js';

export async function getResourceQuota(db: Database, tenantId: string) {
  const [quota] = await db
    .select()
    .from(resourceQuotas)
    .where(eq(resourceQuotas.tenantId, tenantId));

  if (!quota) {
    // Auto-create default quota for tenant
    const id = crypto.randomUUID();
    await db.insert(resourceQuotas).values({ id, tenantId });
    const [created] = await db.select().from(resourceQuotas).where(eq(resourceQuotas.id, id));
    return created;
  }

  return quota;
}

interface UpdateQuotaInput {
  readonly cpu_cores_limit?: number;
  readonly memory_gb_limit?: number;
  readonly storage_gb_limit?: number;
  readonly bandwidth_gb_limit?: number;
}

export async function updateResourceQuota(db: Database, tenantId: string, input: UpdateQuotaInput) {
  // Ensure quota exists
  await getResourceQuota(db, tenantId);

  const updateValues: Record<string, unknown> = {};
  if (input.cpu_cores_limit !== undefined) updateValues.cpuCoresLimit = String(input.cpu_cores_limit);
  if (input.memory_gb_limit !== undefined) updateValues.memoryGbLimit = input.memory_gb_limit;
  if (input.storage_gb_limit !== undefined) updateValues.storageGbLimit = input.storage_gb_limit;
  if (input.bandwidth_gb_limit !== undefined) updateValues.bandwidthGbLimit = input.bandwidth_gb_limit;

  if (Object.keys(updateValues).length > 0) {
    await db.update(resourceQuotas).set(updateValues).where(eq(resourceQuotas.tenantId, tenantId));
  }

  return getResourceQuota(db, tenantId);
}

// ─── Resource Availability ────────────────────────────────────────────────────

const DEFAULT_CPU_LIMIT = 2;     // cores
const DEFAULT_MEMORY_LIMIT = 4;  // Gi
const DEFAULT_STORAGE_LIMIT = 50; // Gi

/** Smallest units Kubernetes accepts — integer arithmetic here is lossless. */
const MILLI_PER_CORE = 1000;
const MIB_PER_GI = 1024;

interface ResourceAvailability {
  readonly cpuLimit: number;
  readonly memoryLimitGi: number;
  readonly storageLimitGi: number;
  readonly cpuUsed: number;
  readonly memoryUsedGi: number;
  readonly storageUsedGi: number;
  readonly cpuAvailable: number;
  readonly memoryAvailableGi: number;
  readonly storageAvailableGi: number;
}

export async function getTenantResourceAvailability(
  db: Database,
  tenantId: string,
): Promise<ResourceAvailability> {
  // 1. Fetch tenant record
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId));

  if (!tenant) {
    throw tenantNotFound(tenantId);
  }

  // 2. Fetch the hosting plan
  const [plan] = await db
    .select()
    .from(hostingPlans)
    .where(eq(hostingPlans.id, tenant.planId));

  // 3. Resolve effective limits: override > plan > default
  const cpuLimit = Number(tenant.cpuLimitOverride) || Number(plan?.cpuLimit) || DEFAULT_CPU_LIMIT;
  const memoryLimitGi = Number(tenant.memoryLimitOverride) || Number(plan?.memoryLimit) || DEFAULT_MEMORY_LIMIT;
  const storageLimitGi = Number(tenant.storageLimitOverride) || Number(plan?.storageLimit) || DEFAULT_STORAGE_LIMIT;

  // 4. Sum current usage from active deployments
  const excludedStatuses = ['deleted', 'failed'] as const;
  const activeDeployments = await db
    .select({
      cpuRequest: deployments.cpuRequest,
      memoryRequest: deployments.memoryRequest,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, tenantId),
        notInArray(deployments.status, [...excludedStatuses]),
      ),
    );

  // 5. Sum usage in INTEGER base units, never in cores/Gi floats.
  //
  // "100m" parses to 0.1, which has no exact binary representation, so
  // accumulating it drifts: 19 x 0.1 === 1.9000000000000006. Subtracting
  // that from the limit put `cpuAvailable` a few ulps below the true
  // remainder, and the tenant panel — which gates the deploy button on
  // `available >= required` while printing both via toFixed(2) — showed
  // "0.10 cores available (0.10 cores required) — Insufficient" and
  // refused to deploy. Milli-cores and MiB are the smallest units
  // Kubernetes accepts, so integers here are lossless.
  let cpuUsedMilli = 0;
  let memoryUsedMiB = 0;

  for (const dep of activeDeployments) {
    cpuUsedMilli += Math.round(parseResourceValue(dep.cpuRequest, 'cpu') * MILLI_PER_CORE);
    memoryUsedMiB += Math.round(parseResourceValue(dep.memoryRequest, 'memory') * MIB_PER_GI);
  }

  const cpuLimitMilli = Math.round(cpuLimit * MILLI_PER_CORE);
  const memoryLimitMiB = Math.round(memoryLimitGi * MIB_PER_GI);

  // Storage: estimate 1 Gi per active deployment (MVP approximation)
  const storageUsedGi = activeDeployments.length * 1;

  // One division at the end yields the correctly-rounded double for the
  // decimal value, so an exact fit compares equal on the client.
  return {
    cpuLimit,
    memoryLimitGi,
    storageLimitGi,
    cpuUsed: cpuUsedMilli / MILLI_PER_CORE,
    memoryUsedGi: memoryUsedMiB / MIB_PER_GI,
    storageUsedGi,
    cpuAvailable: Math.max(0, cpuLimitMilli - cpuUsedMilli) / MILLI_PER_CORE,
    memoryAvailableGi: Math.max(0, memoryLimitMiB - memoryUsedMiB) / MIB_PER_GI,
    storageAvailableGi: Math.max(0, storageLimitGi - storageUsedGi),
  };
}
