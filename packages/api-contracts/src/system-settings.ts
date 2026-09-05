import { z } from 'zod';
import { MIN_TRASH_RETENTION_DAYS, MAX_TRASH_RETENTION_DAYS } from './file-trash.js';

/**
 * PATCH /admin/system-settings.
 *
 * Moved here from backend/src/modules/system-settings/routes.ts. While it lived
 * in the backend, the admin panel typed the request body as
 * `Partial<SystemSettings>` — the RESPONSE type — so `id`, `updatedAt` and a
 * `currencySymbol` field the backend had already replaced with `currency` were
 * all assignable. Nothing sent them in practice, but the type permitted it and
 * the schema is not `.strict()`, so they would have been dropped in silence.
 */
export const updateSystemSettingsSchema = z.object({
  platformName: z.string().min(1).max(255).optional(),
  adminPanelUrl: z.string().url().max(500).optional().nullable(),
  tenantPanelUrl: z.string().url().max(500).optional().nullable(),
  supportEmail: z.string().email().max(255).optional().nullable(),
  supportUrl: z.string().url().max(500).optional().nullable(),
  ingressBaseDomain: z.string().max(255).optional().nullable(),
  // R16: platform APEX / brand domain (distinct from ingressBaseDomain's
  // CNAME-target role). PR-1 plumbing — apex consumers repoint in PR-2.
  platformDomain: z.string().max(255).optional().nullable(),
  apiRateLimit: z.number().int().min(1).max(10000).optional(),
  // On-server tenant volume-snapshot retention (hours). 1h..720h (30d).
  snapshotExpiryHours: z.number().int().min(1).max(720).optional(),
  // Off-site backup-bundle retention (grace window) for a DELETED tenant, in
  // days (migration 0071). 1..3650 days (10y). Read by the
  // tenant-bundles-cleanup lifecycle hook to floor each retained bundle's
  // expires_at on delete.
  deletedTenantBundleRetentionDays: z.number().int().min(1).max(3650).optional(),
  // File-manager recycle-bin retention. Bounded below at 1 day: a 0 would make
  // every delete permanent while both panels still said "Move to Trash".
  fileTrashRetentionDays: z.number().int().min(MIN_TRASH_RETENTION_DAYS).max(MAX_TRASH_RETENTION_DAYS).optional(),
  // IANA timezone string. Used as the fallback on new tenants that don't
  // specify their own timezone, and as the global default for UI date
  // rendering when a user has no per-user override.
  timezone: z.string().min(1).max(50).optional(),
  // ISO 4217 currency code (USD, EUR, …). Drives Intl.NumberFormat for
  // every monetary amount shown in both panels. Default 'USD'.
  currency: z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO 4217 code (e.g. USD)').optional(),
  // Deprecated here — webmailUrl moved to /admin/webmail-settings in the
  // 2026-04-19 consolidation. Accept silently for backwards compat so
  // existing tooling doesn't break; the service layer ignores it.
  // (mailHostname removed — canonical value is mailServerHostname under
  // /admin/webmail-settings; the column is retired in code, physical drop
  // deferred — see migration 0046.)
  webmailUrl: z.string().url().max(500).optional().nullable(),
  // Host-port gating (migration 0062). When false, the catalog deploy
  // path rejects workloads that request hostPort or carry the
  // platform.io/firewall-{tcp,udp}-ports annotations on the
  // corresponding node role.
  allowHostPortsServer: z.boolean().optional(),
  allowHostPortsWorker: z.boolean().optional(),
  // Node-defaults (migration 0063). Default applied to freshly-joined
  // SERVER nodes that arrive without an explicit
  // `insula.host/host-tenant-workloads` label.
  newServerHostsTenantWorkloads: z.boolean().optional(),
  // Kubelet image-GC thresholds (migration 0065). high > low, both 0–100,
  // minTtl ≥ 0. Applied on new nodes via bootstrap.sh --kubelet-arg.
  imageGcHighThreshold: z.number().int().min(50).max(95).optional(),
  imageGcLowThreshold: z.number().int().min(40).max(94).optional(),
  imageGcMinTtlMinutes: z.number().int().min(0).max(1440).optional(),
  // Custom Deployments kill switches (migration 0099).
  customDeploymentsEnabled: z.boolean().optional(),
  customDeploymentsAllowCompose: z.boolean().optional(),
  customDeploymentsAllowPrivateRegistries: z.boolean().optional(),
  customDeploymentsImagePullAudit: z.boolean().optional(),
  customDeploymentsScanOnPull: z.boolean().optional(),
  customDeploymentsWarnUnpinnedTags: z.boolean().optional(),
});

export type UpdateSystemSettingsInput = z.infer<typeof updateSystemSettingsSchema>;
/** Wire shape — what the panel sends. */
export type UpdateSystemSettingsRequest = z.input<typeof updateSystemSettingsSchema>;
