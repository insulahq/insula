/**
 * Automatic archive and delete of tenants (admin → Tenant Lifecycle Hooks).
 *
 * A sweep in the platform API archives tenants that have been suspended for
 * longer than a set number of days, and deletes tenants that have been
 * archived for longer than another. Both steps are off until an admin turns
 * them on.
 */
import { z } from 'zod';

export const TENANT_AUTOMATION_MIN_DAYS = 1;
export const TENANT_AUTOMATION_MAX_DAYS = 3650;

/** What an install runs with until an admin changes it: nothing happens by itself. */
export const TENANT_AUTOMATION_DEFAULTS = {
  autoArchiveEnabled: false,
  autoArchiveAfterDays: 30,
  autoDeleteEnabled: false,
  autoDeleteAfterDays: 90,
} as const;

const days = z.number().int().min(TENANT_AUTOMATION_MIN_DAYS).max(TENANT_AUTOMATION_MAX_DAYS);

export const tenantAutomationSettingsSchema = z.object({
  autoArchiveEnabled: z.boolean(),
  autoArchiveAfterDays: days,
  autoDeleteEnabled: z.boolean(),
  autoDeleteAfterDays: days,
});
export type TenantAutomationSettings = z.infer<typeof tenantAutomationSettingsSchema>;

/** PATCH body: any of the four, nothing else. */
export const tenantAutomationSettingsUpdateSchema = tenantAutomationSettingsSchema.partial().strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });
export type TenantAutomationSettingsUpdate = z.infer<typeof tenantAutomationSettingsUpdateSchema>;

/** What a PATCH answers: the settings as they are stored now. */
export const tenantAutomationSettingsSavedSchema = z.object({ settings: tenantAutomationSettingsSchema });
export type TenantAutomationSettingsSaved = z.infer<typeof tenantAutomationSettingsSavedSchema>;

/** A tenant the sweep looks at: suspended (archive step) or archived (delete step). */
export const tenantAutomationCandidateSchema = z.object({
  tenantId: z.string(),
  name: z.string(),
  /**
   * When it was suspended, or archived. Null on a tenant whose date was never
   * recorded — the sweep leaves such a tenant alone.
   */
  since: z.string().nullable(),
  /** The storage operation that owns the tenant right now, if any; the sweep skips it. */
  busy: z.string().nullable(),
});
export type TenantAutomationCandidate = z.infer<typeof tenantAutomationCandidateSchema>;

const actedOnSchema = z.object({ tenantId: z.string(), name: z.string() });

export const tenantAutomationRunSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  archived: z.array(actedOnSchema),
  deleted: z.array(actedOnSchema),
  failed: z.array(actedOnSchema.extend({ action: z.enum(['archive', 'delete']), error: z.string() })),
  /** Why the archive step did nothing although tenants were due (no backup target, …). */
  archiveSkippedReason: z.string().nullable(),
  /** A step that stopped before its end — the tenants could not be listed, the settings not read. */
  errors: z.array(z.string()).default([]),
});
export type TenantAutomationRun = z.infer<typeof tenantAutomationRunSchema>;

export const tenantAutomationStatusSchema = z.object({
  settings: tenantAutomationSettingsSchema,
  /** How often the sweep runs by itself. */
  intervalHours: z.number(),
  /** A sweep is under way right now, on any replica. */
  running: z.boolean(),
  lastRun: tenantAutomationRunSchema.nullable(),
  /** When the schedule's next sweep is expected; null until one has run. */
  nextRunAt: z.string().nullable(),
  /** Why an archive cannot be taken at the moment (no backup target for tenant snapshots, …). */
  archiveBlockedReason: z.string().nullable(),
  /** How long a manually taken archive is kept (Backups settings). */
  archiveRetentionDays: z.number(),
  suspended: z.array(tenantAutomationCandidateSchema),
  archived: z.array(tenantAutomationCandidateSchema),
});
export type TenantAutomationStatus = z.infer<typeof tenantAutomationStatusSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a tenant suspended (or archived) at `since` comes due under a limit of
 * `afterDays`, as epoch milliseconds. The sweep and the panel's preview both
 * decide with this, so the preview cannot promise what the sweep will not do.
 */
export function tenantAutomationDueAt(since: string | Date, afterDays: number): number {
  return new Date(since).getTime() + afterDays * DAY_MS;
}

/**
 * How long the archive taken by the automatic archive step is kept: the
 * platform's archive retention, or the delete limit when automatic delete is
 * on and longer — an archive must not expire before its tenant is deleted.
 */
export function tenantAutomationArchiveRetentionDays(
  settings: Pick<TenantAutomationSettings, 'autoDeleteEnabled' | 'autoDeleteAfterDays'>,
  archiveRetentionDays: number,
): number {
  return settings.autoDeleteEnabled ? Math.max(archiveRetentionDays, settings.autoDeleteAfterDays) : archiveRetentionDays;
}
