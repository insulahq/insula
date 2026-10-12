/**
 * Automatic archive and delete of tenants (admin → Tenant Lifecycle Hooks).
 *
 * A sweep in the platform API archives tenants that have been suspended for
 * longer than a set number of days, and deletes tenants that have been
 * archived for longer than another. Both steps are off until an admin turns
 * them on. With a notice period set, a tenant is told that many days ahead and
 * nothing happens to it before the date it was given. A tenant can be kept out
 * of both steps.
 */
import { z } from 'zod';

export const TENANT_AUTOMATION_MIN_DAYS = 1;
export const TENANT_AUTOMATION_MAX_DAYS = 3650;
/** The longest notice period. 0 tells nobody. */
export const TENANT_AUTOMATION_MAX_NOTICE_DAYS = 90;

/** What an install runs with until an admin changes it: nothing happens by itself. */
export const TENANT_AUTOMATION_DEFAULTS = {
  autoArchiveEnabled: false,
  autoArchiveAfterDays: 30,
  autoDeleteEnabled: false,
  autoDeleteAfterDays: 90,
  noticeDays: 7,
} as const;

const days = z.number().int().min(TENANT_AUTOMATION_MIN_DAYS).max(TENANT_AUTOMATION_MAX_DAYS);

export const tenantAutomationSettingsSchema = z.object({
  autoArchiveEnabled: z.boolean(),
  autoArchiveAfterDays: days,
  autoDeleteEnabled: z.boolean(),
  autoDeleteAfterDays: days,
  /**
   * How many days ahead a tenant is told that it will be archived or deleted.
   * The sweep does neither before the date it gave. 0: nobody is told any
   * more, and a tenant that has no date yet is acted on as soon as it is past
   * its limit.
   */
  noticeDays: z.number().int().min(0).max(TENANT_AUTOMATION_MAX_NOTICE_DAYS),
});
export type TenantAutomationSettings = z.infer<typeof tenantAutomationSettingsSchema>;

/** PATCH body: any of the settings, nothing else. */
export const tenantAutomationSettingsUpdateSchema = tenantAutomationSettingsSchema.partial().strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });
export type TenantAutomationSettingsUpdate = z.infer<typeof tenantAutomationSettingsUpdateSchema>;

/** What a PATCH answers: the settings as they are stored now. */
export const tenantAutomationSettingsSavedSchema = z.object({ settings: tenantAutomationSettingsSchema });
export type TenantAutomationSettingsSaved = z.infer<typeof tenantAutomationSettingsSavedSchema>;

/** What a tenant was told, and when. */
export const tenantAutomationNoticeSchema = z.object({
  toldAt: z.string(),
  /** The date it was given: nothing happens to it before. */
  date: z.string(),
  /**
   * False when the message reached nobody — no user and no contact address to
   * write to, or notifications are off. Such a notice does not count: the
   * tenant is told again at every run, and nothing is done to it meanwhile.
   */
  reached: z.boolean(),
});
export type TenantAutomationNotice = z.infer<typeof tenantAutomationNoticeSchema>;

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
  /** The notice sent for this suspension (or archive); null when none was. */
  notice: tenantAutomationNoticeSchema.nullable(),
});
export type TenantAutomationCandidate = z.infer<typeof tenantAutomationCandidateSchema>;

/** A tenant an admin keeps out of both steps, whatever its status. */
export const tenantAutomationKeptSchema = z.object({
  tenantId: z.string(),
  name: z.string(),
  status: z.string(),
});
export type TenantAutomationKept = z.infer<typeof tenantAutomationKeptSchema>;

/** PUT body of …/automation/tenants/:tenantId. */
export const tenantAutomationExemptionSchema = z.object({ exempt: z.boolean() }).strict();
export type TenantAutomationExemption = z.infer<typeof tenantAutomationExemptionSchema>;

const actedOnSchema = z.object({ tenantId: z.string(), name: z.string() });

export const tenantAutomationRunSchema = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  archived: z.array(actedOnSchema),
  deleted: z.array(actedOnSchema),
  failed: z.array(actedOnSchema.extend({ action: z.enum(['archive', 'delete']), error: z.string() })),
  /**
   * Tenants this run told what is coming, and the date each was given.
   * `reached: false` — the message reached nobody, so the date does not hold
   * and the tenant is told again at the next run.
   */
  told: z.array(actedOnSchema.extend({ action: z.enum(['archive', 'delete']), date: z.string(), reached: z.boolean() })).default([]),
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
  /** Tenants kept out of both steps. They are in neither list above. */
  kept: z.array(tenantAutomationKeptSchema),
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

/** What the sweep does with one tenant at its next run. */
export type TenantAutomationPlan =
  /** No date recorded: the sweep never touches the tenant. */
  | { readonly kind: 'never' }
  /** Archived (or deleted) at the next run. */
  | { readonly kind: 'due' }
  /** Told at the next run; acted on at `actAt` at the earliest. */
  | { readonly kind: 'tell'; readonly actAt: number }
  /**
   * Nothing at the next run. Acted on at `actAt` at the earliest; `told` when
   * it has been given that date already, else `tellAt` is when it will be
   * (null when nobody is told).
   */
  | { readonly kind: 'later'; readonly actAt: number; readonly told: boolean; readonly tellAt: number | null };

type Instant = string | Date;

/**
 * Decide what happens to a tenant suspended (or archived) at `since`, under a
 * limit of `afterDays` and a notice period of `noticeDays`. The sweep and the
 * panel's preview both decide with this, so the preview cannot promise what
 * the sweep will not do.
 *
 *   - A tenant that has been told keeps the date it was given, whatever is
 *     changed afterwards — the notice period too, also to nothing. It is due
 *     on that date and not before.
 *   - A notice counts while it belongs to this suspension (told after
 *     `since`), reached somebody, and its date is not earlier than the limit.
 *     Raise the limit and the tenant is told again, with the later date; a
 *     message that reached nobody is no notice, and is sent again.
 *   - With a notice period and no such notice: the tenant is told once it is
 *     within `noticeDays` of its limit — at the first run after that moment,
 *     however long ago it was — and given a date `noticeDays` from the
 *     telling, which is never before its limit.
 *   - With no notice period and no such notice: due once past the limit.
 */
export function tenantAutomationPlan(
  candidate: {
    readonly since: Instant | null;
    readonly notice?: { readonly toldAt: Instant; readonly date: Instant; readonly reached?: boolean } | null;
  },
  afterDays: number,
  noticeDays: number,
  nowMs: number,
): TenantAutomationPlan {
  if (candidate.since === null) return { kind: 'never' };
  const sinceMs = new Date(candidate.since).getTime();
  const limitAt = sinceMs + afterDays * DAY_MS;
  const notice = candidate.notice ?? null;
  if (notice && notice.reached !== false) {
    const toldAt = new Date(notice.toldAt).getTime();
    const date = new Date(notice.date).getTime();
    // A second of slack: `since` is stored finer than a millisecond.
    if (toldAt >= sinceMs && date >= limitAt - 1000) {
      return date <= nowMs ? { kind: 'due' } : { kind: 'later', actAt: date, told: true, tellAt: null };
    }
  }
  if (noticeDays <= 0) {
    return limitAt < nowMs ? { kind: 'due' } : { kind: 'later', actAt: limitAt, told: false, tellAt: null };
  }
  const tellAt = limitAt - noticeDays * DAY_MS;
  // Inside the notice period, so `noticeDays` from now is at or past the limit.
  if (tellAt <= nowMs) return { kind: 'tell', actAt: nowMs + noticeDays * DAY_MS };
  return { kind: 'later', actAt: limitAt, told: false, tellAt };
}

/**
 * How long the archive taken by the automatic archive step is kept: the
 * platform's archive retention, or — when automatic delete is on — the delete
 * limit plus the notice period when that is longer. An archive must not
 * expire before its tenant is deleted, and a tenant told late is deleted up
 * to a notice period after its limit.
 */
export function tenantAutomationArchiveRetentionDays(
  settings: Pick<TenantAutomationSettings, 'autoDeleteEnabled' | 'autoDeleteAfterDays' | 'noticeDays'>,
  archiveRetentionDays: number,
): number {
  return settings.autoDeleteEnabled
    ? Math.max(archiveRetentionDays, settings.autoDeleteAfterDays + settings.noticeDays)
    : archiveRetentionDays;
}
