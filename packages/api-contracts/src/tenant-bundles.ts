import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// ─── Enums (mirror DB enums from migration 0066) ─────────────────────────────

export const backupInitiatorSchema = z.enum(['tenant', 'admin', 'system', 'cluster']);
export type BackupInitiator = z.infer<typeof backupInitiatorSchema>;

export const backupSystemTriggerSchema = z.enum(['pre_resize', 'pre_archive', 'scheduled', 'manual']);
export type BackupSystemTrigger = z.infer<typeof backupSystemTriggerSchema>;

export const backupJobStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'partial',
  'failed',
  'expired',
]);
export type BackupJobStatus = z.infer<typeof backupJobStatusSchema>;

export const backupComponentNameSchema = z.enum(['files', 'mailboxes', 'config', 'secrets']);
export type BackupComponentName = z.infer<typeof backupComponentNameSchema>;

export const backupComponentStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'skipped',
  'failed',
]);
export type BackupComponentStatus = z.infer<typeof backupComponentStatusSchema>;

export const backupTargetKindSchema = z.enum(['hostpath', 's3', 'ssh']);
export type BackupTargetKind = z.infer<typeof backupTargetKindSchema>;

// ─── meta.json (canonical bundle manifest, schemaVersion=2) ──────────────────
//
// See docs/architecture/BACKUP_COMPONENT_MODEL.md and ADR-032.
// Restore code MUST reject schemaVersion values it does not recognize.
//
// v2 adds enough information for the import flow to fully restore a
// deleted tenant without first unzipping the config component:
//   - `tenant` block: account + subscription + node placement + overrides
//   - `domainsSummary[]`, `deploymentsSummary[]`: small previews so the
//     operator import-confirmation UI can show counts + names without
//     gunzipping db-rows.json.gz
//
// v1 bundles are NOT importable. The 2026-05-08 staging bundles were
// flushed when v2 shipped — see project_export_streaming_2026_05_08.md.

export const BACKUP_META_SCHEMA_VERSION = 2 as const;

export const backupMetaComponentFilesSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const backupMetaComponentMailboxesSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  mailboxCount: z.number().int().nonnegative(),
  addresses: z.array(z.string()),
});

export const backupMetaComponentConfigSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
});

export const backupMetaComponentSecretsSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  secretCount: z.number().int().nonnegative(),
  encryptionKeyId: z.string().regex(/^k\d+$/), // 'k1', 'k2', ...
});

export const backupMetaComponentsSchema = z.object({
  files: backupMetaComponentFilesSchema.optional(),
  mailboxes: backupMetaComponentMailboxesSchema.optional(),
  config: backupMetaComponentConfigSchema.optional(),
  secrets: backupMetaComponentSecretsSchema.optional(),
});

/**
 * Client account + subscription block carried in meta.json v2 so the
 * import flow can fully restore a deleted tenant without gunzipping
 * the config component.
 *
 * Field semantics:
 *   - `kubernetesNamespace` is captured but the import dialog can
 *     opt to derive a fresh one (typical when restoring across regions).
 *   - `nodeName` is captured so the operator can choose to pin
 *     to the same physical node, but the import dialog typically
 *     resets to "auto" so the scheduler picks an available node.
 *   - `*Override` fields are nullable; null = use plan default.
 */
export const backupMetaTenantSchema = z.object({
  name: z.string(),
  primaryEmail: z.string(),
  secondaryEmail: z.string().nullable(),
  status: z.string(), // tenant_status enum at capture time (active/suspended/archived)
  kubernetesNamespace: z.string(),
  regionId: uuidField,
  planId: uuidField,
  nodeName: z.string().nullable(),
  storageTier: z.string(), // 'local' | 'longhorn' | ...
  timezone: z.string().nullable(),
  storageLimitOverride: z.number().nullable(),
  cpuLimitOverride: z.number().nullable(),
  memoryLimitOverride: z.number().nullable(),
  maxSubUsersOverride: z.number().int().nullable(),
  maxMailboxesOverride: z.number().int().nullable(),
  monthlyPriceOverride: z.number().nullable(),
  emailSendRateLimit: z.number().int().nullable(),
  subscriptionExpiresAt: z.string().nullable(),
  // Counts for the import-preview UI; never load-bearing for restore
  // (config component carries authoritative rows).
  counts: z.object({
    mailboxes: z.number().int().nonnegative(),
    domains: z.number().int().nonnegative(),
    deployments: z.number().int().nonnegative(),
  }),
});
export type BackupMetaTenant = z.infer<typeof backupMetaTenantSchema>;

export const backupMetaDomainSummarySchema = z.object({
  name: z.string(),
  status: z.string(),
});
export type BackupMetaDomainSummary = z.infer<typeof backupMetaDomainSummarySchema>;

export const backupMetaDeploymentSummarySchema = z.object({
  name: z.string(),
  catalogEntryId: uuidField,
  replicas: z.number().int().nonnegative(),
  status: z.string(),
});
export type BackupMetaDeploymentSummary = z.infer<typeof backupMetaDeploymentSummarySchema>;

export const backupMetaV2Schema = z.object({
  schemaVersion: z.literal(BACKUP_META_SCHEMA_VERSION),
  backupId: z.string().min(1),
  tenantId: uuidField,
  capturedAt: z.string().datetime(),
  platformVersion: z.string(),
  initiator: backupInitiatorSchema,
  systemTrigger: backupSystemTriggerSchema.nullable(),
  label: z.string().nullable(),
  components: backupMetaComponentsSchema,
  nodePlacement: z
    .object({
      preferredNode: z.string().nullable(),
      preferredRegion: z.string().nullable(),
    })
    .nullable(),
  expiresAt: z.string().datetime().nullable(),
  retentionDays: z.number().int().positive(),
  description: z.string().nullable(),
  // v2 additions:
  // `tenant` is required on FRESH captures (orchestrator always writes
  // it); legacy v1 bundles promoted via `parseMeta` carry `tenant: null`
  // so verify / export / restore-cart still work. The IMPORT endpoint
  // refuses any bundle whose meta has `tenant: null`.
  tenant: backupMetaTenantSchema.nullable(),
  domainsSummary: z.array(backupMetaDomainSummarySchema),
  deploymentsSummary: z.array(backupMetaDeploymentSummarySchema),
});
export type BackupMetaV2 = z.infer<typeof backupMetaV2Schema>;

// Legacy aliases — keep the old type name working until every
// import site moves to BackupMetaV2 (single deploy cycle).
export const backupMetaV1Schema = backupMetaV2Schema;
export type BackupMetaV1 = BackupMetaV2;

// ─── Component info row (for admin UI listings) ──────────────────────────────

export const backupComponentInfoSchema = z.object({
  id: uuidField,
  component: backupComponentNameSchema,
  artifactName: z.string(),
  status: backupComponentStatusSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type BackupComponentInfo = z.infer<typeof backupComponentInfoSchema>;

// ─── Bundle summary + detail (admin/tenant list endpoints) ───────────────────

/**
 * Live status of the tenant this bundle belongs to. Computed at list
 * time via LEFT JOIN tenants on backup_jobs.tenant_id:
 *   - 'active' / 'suspended' / 'archived' → live row found
 *   - 'missing' → no row in tenants (tenant was deleted; bundle survives
 *     until its own retention sweep). Operator UI uses this to surface
 *     the "Restore from bundle" affordance with a different copy.
 */
export const bundleTenantStatusSchema = z.enum([
  'active',
  'suspended',
  'archived',
  'missing',
]);
export type BundleTenantStatus = z.infer<typeof bundleTenantStatusSchema>;

export const bundleSummarySchema = z.object({
  id: uuidField,
  tenantId: uuidField,
  tenantStatus: bundleTenantStatusSchema,
  /** name from tenants (null when tenantStatus='missing'). */
  tenantName: z.string().nullable(),
  initiator: backupInitiatorSchema,
  systemTrigger: backupSystemTriggerSchema.nullable(),
  status: backupJobStatusSchema,
  targetKind: backupTargetKindSchema,
  targetUri: z.string(),
  targetConfigId: uuidField.nullable(),
  label: z.string().nullable(),
  description: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  retentionDays: z.number().int().positive(),
  expiresAt: z.string().nullable(),
  exportMode: z.string().nullable(),
  exportArtifact: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BundleSummary = z.infer<typeof bundleSummarySchema>;

export const bundleDetailSchema = bundleSummarySchema.extend({
  components: z.array(backupComponentInfoSchema),
});
export type BundleDetail = z.infer<typeof bundleDetailSchema>;

export const bundleListResponseSchema = paginatedResponseSchema(bundleSummarySchema);
export type BundleListResponse = z.infer<typeof bundleListResponseSchema>;

// ─── Verify response (round-trip integrity report) ──────────────────────────
//
// POST /admin/tenant-bundles/{id}/verify reads every component back
// from the off-site target, decrypts secrets, decompresses config,
// and reports per-component health. No DB writes. Used by the admin
// panel "Verify" button + by integration tests to assert round-trip.

export const verifyBundleFilesComponentSchema = z.object({
  reachable: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});

export const verifyBundleConfigComponentSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  rowCounts: z.record(z.string(), z.number().int().nonnegative()),
  parseError: z.string().nullable(),
});

export const verifyBundleSecretsComponentSchema = z.object({
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  encryptionKeyId: z.string(),
  secretCount: z.number().int().nonnegative(),
  decryptError: z.string().nullable(),
});

export const verifyBundleResponseSchema = z.object({
  bundleId: z.string(),
  meta: z.object({
    schemaVersion: z.number().int(),
    capturedAt: z.string(),
    platformVersion: z.string(),
    initiator: backupInitiatorSchema,
    retentionDays: z.number().int(),
    expiresAt: z.string().nullable(),
  }),
  components: z.object({
    files: verifyBundleFilesComponentSchema.optional(),
    config: verifyBundleConfigComponentSchema.optional(),
    secrets: verifyBundleSecretsComponentSchema.optional(),
  }),
});
export type VerifyBundleResponse = z.infer<typeof verifyBundleResponseSchema>;

// ─── Create bundle (admin/system initiator) ─────────────────────────────────

const componentToggleSchema = z.object({
  files: z.boolean().default(true),
  mailboxes: z.boolean().default(true),
  config: z.boolean().default(true),
  secrets: z.boolean().default(true),
});

export const createBundleSchema = z
  .object({
    tenantId: uuidField,
    initiator: backupInitiatorSchema.default('admin'),
    systemTrigger: backupSystemTriggerSchema.nullable().optional(),
    label: z.string().max(255).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    retentionDays: z.number().int().positive().max(3650).optional(),
    components: componentToggleSchema.partial().optional(),
    targetConfigId: uuidField.nullable().optional(),
    // Optional GDPR-export wrapper (tenant initiator only).
    exportMode: z.literal('data_export').optional(),
    exportPassphrase: z.string().min(12).max(256).optional(),
    // When true, the route returns immediately with status='running'
    // and the orchestrator continues in the background. The caller
    // polls GET /admin/tenant-bundles/:id for per-component progress.
    // Default false preserves the synchronous behaviour the
    // integration harness depends on.
    async: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.exportMode === undefined ||
      (input.initiator === 'tenant' && !!input.exportPassphrase),
    { message: 'exportMode=data_export requires initiator=tenant and exportPassphrase' },
  );
export type CreateBundleInput = z.infer<typeof createBundleSchema>;

// ─── Schedule (per-tenant cron) ──────────────────────────────────────────────

export const tenantBackupScheduleFrequencySchema = z.enum(['daily', 'weekly', 'monthly']);
export type TenantBackupScheduleFrequency = z.infer<typeof tenantBackupScheduleFrequencySchema>;

export const tenantBackupScheduleSchema = z.object({
  tenantId: uuidField,
  enabled: z.boolean(),
  frequency: tenantBackupScheduleFrequencySchema,
  hourOfDayUtc: z.number().int().min(0).max(23),
  dayOfWeek: z.number().int().min(0).max(6).nullable(),
  dayOfMonth: z.number().int().min(1).max(28).nullable(),
  retentionDays: z.number().int().positive(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: backupJobStatusSchema.nullable(),
});
export type TenantBackupSchedule = z.infer<typeof tenantBackupScheduleSchema>;

export const updateTenantBackupScheduleSchema = z.object({
  enabled: z.boolean().optional(),
  frequency: tenantBackupScheduleFrequencySchema.optional(),
  hourOfDayUtc: z.number().int().min(0).max(23).optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  retentionDays: z.number().int().positive().optional(),
});
export type UpdateTenantBackupScheduleInput = z.infer<typeof updateTenantBackupScheduleSchema>;

/**
 * Per-tenant schedule summary, joined with the tenant's display name
 * for the global Tenant Backup admin page (operator never wants a
 * row that says "schedule for 4f3a-…-c2"). Returned by
 * GET /admin/backup-schedules.
 */
export const backupScheduleSummarySchema = tenantBackupScheduleSchema.extend({
  /** tenants.business_name for display. Nullable if the tenant row was
   * deleted but the schedule row hasn't been cascaded yet — operator
   * sees "(deleted)" so they can clean up. */
  businessName: z.string().nullable(),
});
export type BackupScheduleSummary = z.infer<typeof backupScheduleSummarySchema>;

export const listBackupSchedulesResponseSchema = z.object({
  data: z.array(backupScheduleSummarySchema),
});
export type ListBackupSchedulesResponse = z.infer<typeof listBackupSchedulesResponseSchema>;

// ─── Coverage report (BundleComponent registry + drift) ──────────────────────
//
// GET /admin/tenant-bundles/coverage returns the static registry of
// what each component claims to capture, plus a runtime drift report
// that compares declared coverage to the actual DB schema. Powers the
// operator "Coverage" tab on the Tenant Backup admin page.

export const componentOwnershipSchema = z.object({
  name: backupComponentNameSchema,
  description: z.string(),
  tables: z.array(z.string()),
  pvcs: z.array(z.string()),
  secretTypes: z.array(z.string()),
  externalResources: z.array(z.string()),
});
export type ComponentOwnership = z.infer<typeof componentOwnershipSchema>;

export const bundleCoverageResponseSchema = z.object({
  components: z.array(componentOwnershipSchema),
  drift: z.object({
    /** Tables claimed by no component AND not in the documented
     *  exclusion list — these are real coverage gaps. */
    orphanTables: z.array(z.object({ table: z.string() })),
    /** Tables intentionally outside any component, with the
     *  documented reason (audit logs, billing, transient state). */
    excludedTables: z.array(z.object({
      table: z.string(),
      reason: z.string(),
    })),
    ownedTableCount: z.number().int().nonnegative(),
    totalTenantTables: z.number().int().nonnegative(),
  }),
});
export type BundleCoverageResponse = z.infer<typeof bundleCoverageResponseSchema>;
