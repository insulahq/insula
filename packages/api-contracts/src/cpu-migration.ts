import { z } from 'zod';

/**
 * CPU tiers (ADR-062).
 *
 * A tenant CPU request stops being a core count and becomes a share. The
 * millicore value behind each tier is chosen in `cpu.weight` space, not
 * arbitrarily: measured on a live node, every request at or below ~25m
 * collapses to weight 1, so a ladder of "very small numbers" would be
 * indistinguishable to the kernel. These three land on weights 1 / 2 / 4.
 */
export const cpuTierSchema = z.enum(['normal', 'high', 'highest']);
export type CpuTier = z.infer<typeof cpuTierSchema>;

/** Millicores per tier. The bottom tier is free — weight 1 spans 1m–25m. */
export const CPU_TIER_MILLICORES: Readonly<Record<CpuTier, number>> = {
  normal: 5,
  high: 30,
  highest: 100,
};

/** The kernel share weight each tier actually resolves to, for display. */
export const CPU_TIER_WEIGHT: Readonly<Record<CpuTier, number>> = {
  normal: 1,
  high: 2,
  highest: 4,
};

/**
 * Why a tenant cannot be migrated without a human looking at it. `null` means
 * it can. These are the cases the platform genuinely cannot decide alone —
 * anything else would be a guess dressed as a recommendation.
 */
export const cpuMigrationBlockerSchema = z.enum([
  /** ADR-036 bring-your-own image declaring its own resources. */
  'custom_resources',
  /** Measured p95 already exceeds the ceiling the plan would grant. */
  'usage_exceeds_ceiling',
  /** Manifest came from a catalog repository that is not the Official one. */
  'third_party_catalog',
  /** No usage samples, so "does it fit" cannot be answered. */
  'no_usage_data',
]);
export type CpuMigrationBlocker = z.infer<typeof cpuMigrationBlockerSchema>;

export const cpuMigrationDeploymentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Millicores reserved today. */
  currentMillis: z.number(),
  /** Millicores the tier would reserve. */
  proposedMillis: z.number(),
  proposedTier: cpuTierSchema,
  blocker: cpuMigrationBlockerSchema.nullable(),
});
export type CpuMigrationDeployment = z.infer<typeof cpuMigrationDeploymentSchema>;

export const cpuMigrationTenantSchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  planCode: z.string().nullable(),
  /** Sum of today's reservations across the tenant's deployments, millicores. */
  currentMillis: z.number(),
  /** Sum after re-tiering, millicores. */
  proposedMillis: z.number(),
  /**
   * Millicores this tenant hands back — the sum of PER-DEPLOYMENT floors, the
   * same operation the cluster-wide `reclaimableMillis` is built from.
   *
   * Sent rather than derived in the UI on purpose. Flooring the tenant's
   * summed difference instead gives a different number whenever one
   * deployment's tier lands above its current request: A 500m→30m and B
   * 10m→30m is 470 by the aggregate's rule and 450 by the summed-then-floored
   * one. Two independent computations of "freed" is a divergence waiting to
   * happen on the one page whose value is being trustworthy.
   */
  reclaimableMillis: z.number(),
  /**
   * Millicores this tenant would GAIN, where a tier lands above the current
   * request. Zero for almost every tenant, but folding it into the freed
   * figure would render a net increase identically to no change.
   */
  increasedMillis: z.number(),
  /** Tenant-wide burst ceiling the plan would grant, in cores. */
  proposedCeilingCores: z.number(),
  /**
   * Measured p95 across the tenant, millicores, or null when unsampled.
   * Tenant-wide because the ceiling it is compared against is tenant-wide —
   * `usage_metrics` carries no per-deployment CPU rows at all.
   */
  observedP95Millis: z.number().nullable(),
  /** Set when the tenant as a whole cannot be migrated unattended. */
  tenantBlocker: cpuMigrationBlockerSchema.nullable(),
  /** True when every deployment migrates without a human decision. */
  migratesCleanly: z.boolean(),
  /**
   * Which model this tenant is actually on right now. The dry run describes
   * what WOULD happen; without this the panel cannot tell an un-migrated
   * tenant from a migrated one and would offer to migrate it again.
   */
  schedulingMode: z.enum(['legacy', 'tiered']),
  deployments: z.array(cpuMigrationDeploymentSchema),
});
export type CpuMigrationTenant = z.infer<typeof cpuMigrationTenantSchema>;

export const cpuMigrationPreviewSchema = z.object({
  /** Node allocatable CPU, millicores, summed across schedulable nodes. */
  allocatableMillis: z.number(),
  /** What every pod reserves today, millicores — platform included. */
  reservedMillis: z.number(),
  /** What is actually being used, millicores. Null when metrics are absent. */
  usedMillis: z.number().nullable(),
  /** Millicores the re-tier would hand back to the scheduler. */
  reclaimableMillis: z.number(),
  tenants: z.array(cpuMigrationTenantSchema),
  /** Tenants needing a human decision, for the headline count. */
  needsReviewCount: z.number(),
});
export type CpuMigrationPreview = z.infer<typeof cpuMigrationPreviewSchema>;

// ─── R2: applying the migration ─────────────────────────────────────────────

/**
 * Per-tenant, never fleet-wide. A single "migrate everything" button would be
 * a flag day across every tenant on an unknown cluster, which is exactly what
 * ADR-062 rules out — the operator moves one tenant, watches it, moves the
 * next.
 */
export const cpuMigrationApplySchema = z.object({
  /**
   * Proceed even though the dry run flagged this tenant for review. The
   * blockers stay reported; this records that a human looked and decided.
   */
  acknowledgeBlockers: z.boolean().optional().default(false),
}).strict();
export type CpuMigrationApplyInput = z.infer<typeof cpuMigrationApplySchema>;

export const cpuMigrationRunStatusSchema = z.enum([
  'running', 'completed', 'stopped', 'failed',
]);
export type CpuMigrationRunStatus = z.infer<typeof cpuMigrationRunStatusSchema>;

export const cpuMigrationRunSchema = z.object({
  taskId: z.string(),
  tenantId: z.string(),
  status: cpuMigrationRunStatusSchema,
  /** Human-readable step currently running, or the one it stopped after. */
  step: z.string().nullable(),
  progressPct: z.number().nullable(),
  /** Millicores handed back so far. Only meaningful once completed. */
  freedMillis: z.number().nullable(),
  reason: z.string().nullable(),
});
export type CpuMigrationRun = z.infer<typeof cpuMigrationRunSchema>;

export const cpuRevertResultSchema = z.object({
  tenantId: z.string(),
  status: z.enum(['completed', 'failed']),
  restored: z.number(),
  /**
   * Migrated deployments whose stored baseline could not be honoured. Named
   * rather than silently skipped — an operator must not discover later that
   * one came back with a number nobody chose.
   */
  unrestorable: z.number(),
  reason: z.string().nullable(),
});
export type CpuRevertResult = z.infer<typeof cpuRevertResultSchema>;
