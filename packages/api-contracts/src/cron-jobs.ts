import { z } from 'zod';
import { uuidField, paginatedResponseSchema } from './shared.js';

// Simple cron expression validator: 5 space-separated fields
const cronRegex = /^([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)\s+([0-9*,\-\/]+)$/;

// ─── Input Schemas ───────────────────────────────────────────────────────────

/**
 * Per-job run ceiling, in seconds.
 *
 * One number cannot fit both job types: a webcron ping that takes 30 seconds is
 * broken, while Moodle's `admin/cli/cron.php` legitimately took 182 s on a
 * newly installed site — and a course backup or a search reindex takes longer
 * still. Leaving this unset keeps the per-type default (see
 * DEFAULT_CRON_TIMEOUT_SECONDS); setting it raises or lowers the ceiling for
 * that one job.
 *
 * The 1-hour cap is the scheduler's, not the job's: a run holds its claim for
 * its whole duration, and a ceiling beyond the claim's staleness window would
 * let two runs of the same job overlap.
 */
export const CRON_TIMEOUT_MIN_SECONDS = 5;
export const CRON_TIMEOUT_MAX_SECONDS = 3600;

/** Applied when a job does not set its own. */
export const DEFAULT_CRON_TIMEOUT_SECONDS = { webcron: 30, deployment: 300 } as const;

/**
 * IANA timezone the schedule is read in, e.g. `Europe/Berlin`.
 *
 * Optional: leaving it unset means "the platform's timezone", so an operator
 * who sets the platform to Europe/Berlin does not have to repeat themselves on
 * every job. Stored per job rather than resolved at write time, so changing the
 * platform timezone moves the jobs that follow it and leaves alone the ones
 * that were pinned deliberately.
 *
 * Validated against the runtime rather than a hardcoded list: `Intl` throws for
 * a zone it does not know, and its list is the one the scheduler will evaluate
 * against. A baked-in list would drift every time the tz database changes.
 */
const timezoneField = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown timezone — use an IANA name such as Europe/Berlin or UTC')
  .optional();

const timeoutField = z
  .number()
  .int()
  .min(CRON_TIMEOUT_MIN_SECONDS)
  .max(CRON_TIMEOUT_MAX_SECONDS)
  .optional();

/**
 * Failure email, per job, opt-in.
 *
 * Off by default: a scheduled run that fails always reaches the tenant's
 * admins through their own notification preferences (in the panel, and by
 * email if they have it on). This adds ADDRESSES on top — the tenant's primary
 * email and/or one more address typed in here — for the person who has to
 * fix the job and may never open the panel.
 *
 * The tenant email is a flag, not a copy: it is resolved from the tenant record
 * when the email is sent, so a changed primary address is followed.
 *
 * The extra address is tenant-entered and the platform will mail it, so two
 * limits bound what one tenant can make the platform send: at most one email
 * per job per UTC day while it keeps failing, and at most
 * CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY across all of a tenant's jobs. A job
 * failing every minute therefore costs one email a day, not 1,440.
 */
export const CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY = 20;

const FAILURE_EMAIL_RECIPIENT_MESSAGE =
  'Failure emails need a recipient — tick the tenant email or enter an address';

/** A contact address, not an identity: kept as typed (bar whitespace). */
const notifyEmailField = z
  .string()
  .trim()
  .max(255)
  .email('Enter a valid email address');

/**
 * True when a job would email nobody although it was asked to.
 *
 * One rule for three places: the create schema below, the API's check of the
 * MERGED row on edit (a PATCH may switch the flag on and leave the recipients
 * as stored), and both panels' Save button.
 */
export function failureEmailRecipientMissing(state: {
  readonly notifyOnFailure: boolean;
  readonly notifyTenantEmail: boolean;
  readonly notifyEmail: string | null | undefined;
}): boolean {
  if (!state.notifyOnFailure) return false;
  return !state.notifyTenantEmail && !(state.notifyEmail ?? '').trim();
}

export const createCronJobSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['webcron', 'deployment']),
  schedule: z.string().regex(cronRegex, 'Invalid cron expression (expected 5 fields: min hour dom mon dow)'),
  // Webcron fields
  url: z.string().url().max(2000).optional(),
  http_method: z.enum(['GET', 'POST', 'PUT']).default('GET'),
  // Deployment cron fields
  command: z.string().min(1).max(2000).optional(),
  deployment_id: z.string().uuid().optional(),
  // Common
  timeout_seconds: timeoutField,
  timezone: timezoneField,
  enabled: z.boolean().default(true),
  // Failure email — off unless asked for. See the block above.
  notify_on_failure: z.boolean().default(false),
  notify_tenant_email: z.boolean().default(true),
  notify_email: notifyEmailField.nullable().optional(),
}).refine(
  (data) => {
    if (data.type === 'webcron') return !!data.url;
    if (data.type === 'deployment') return !!data.command && !!data.deployment_id;
    return false;
  },
  { message: 'Webcron requires url; deployment cron requires command and deployment_id' }
).refine(
  (data) => !failureEmailRecipientMissing({
    notifyOnFailure: data.notify_on_failure,
    notifyTenantEmail: data.notify_tenant_email,
    notifyEmail: data.notify_email ?? null,
  }),
  { message: FAILURE_EMAIL_RECIPIENT_MESSAGE, path: ['notify_email'] },
);

/**
 * `type` is deliberately absent: it selects which of the two field sets is
 * meaningful, and flipping it would leave a job carrying a url AND a command
 * with no way to say which one the scheduler should honour. Delete and
 * recreate instead.
 *
 * `timeout_seconds` and `timezone` are nullable HERE and only here. Omitting a
 * field means "leave it as it is", which on create is the same thing as "use
 * the default" — on update it is not. Without an explicit null there is no way
 * to put a job that was pinned to 600s or Europe/Berlin back on the default,
 * and the edit form's cleared field would silently do nothing.
 */
export const updateCronJobSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  schedule: z.string().regex(cronRegex, 'Invalid cron expression').optional(),
  url: z.string().url().max(2000).optional(),
  http_method: z.enum(['GET', 'POST', 'PUT']).optional(),
  command: z.string().min(1).max(2000).optional(),
  deployment_id: z.string().uuid().optional(),
  timeout_seconds: timeoutField.nullable(),
  timezone: timezoneField.nullable(),
  enabled: z.boolean().optional(),
  // No cross-field refine here: a PATCH carries only what changed, so whether
  // the job still names a recipient is a question about the MERGED row — the
  // service answers it with failureEmailRecipientMissing.
  notify_on_failure: z.boolean().optional(),
  notify_tenant_email: z.boolean().optional(),
  /** null removes the extra address. */
  notify_email: notifyEmailField.nullable().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

export const cronJobResponseSchema = z.object({
  id: uuidField,
  tenantId: uuidField,
  name: z.string(),
  type: z.enum(['webcron', 'deployment']),
  schedule: z.string(),
  command: z.string().nullable(),
  timeoutSeconds: z.number().int().nullable(),
  timezone: z.string().nullable(),
  url: z.string().nullable(),
  httpMethod: z.string().nullable(),
  deploymentId: z.string().nullable(),
  enabled: z.number(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(['success', 'failed', 'running']).nullable(),
  lastRunDurationMs: z.number().nullable(),
  lastRunResponseCode: z.number().nullable(),
  lastRunOutput: z.string().nullable(),
  notifyOnFailure: z.boolean(),
  notifyTenantEmail: z.boolean(),
  notifyEmail: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const cronJobListResponseSchema = paginatedResponseSchema(cronJobResponseSchema);

// ─── Admin cross-tenant cron-job list ───────────────────────────────────────
//
// /admin/cron-jobs returns rows joined to their owning tenant so the
// admin Tenants → Cron Jobs tab can render a tenant column without a
// second fetch.
export const adminCronJobResponseSchema = cronJobResponseSchema.extend({
  tenantName: z.string().nullable(),
});
export type AdminCronJobResponse = z.infer<typeof adminCronJobResponseSchema>;

export const adminCronJobListResponseSchema = paginatedResponseSchema(adminCronJobResponseSchema);
export type AdminCronJobListResponse = z.infer<typeof adminCronJobListResponseSchema>;

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateCronJobInput = z.infer<typeof createCronJobSchema>;

// ─── Request (wire) types ────────────────────────────────────────────────────
//
// `z.infer` is the OUTPUT type: a field declared `.default(x)` is REQUIRED
// there, because after parsing it always has a value. On the wire it is
// optional — the client may omit it and the backend fills it in.
//
// Typing a request body with the output type therefore marks every defaulted
// field as mandatory. Doing that surfaced three "missing required field"
// compile errors in working forms (catalog-repo sync interval, cron http_method,
// plan features) — all three fields have defaults, and all three forms were
// correct. A migration that trusted those errors would have changed working
// code to satisfy a type that was wrong.
//
// So: frontends type request bodies with `…Request` (= z.input), and the
// backend keeps using the `…Input` (= z.infer) type for `parsed.data`.
export type CreateCronJobRequest = z.input<typeof createCronJobSchema>;

export type UpdateCronJobInput = z.infer<typeof updateCronJobSchema>;
/** Wire shape for the PATCH body — see the CreateCronJobRequest note above. */
export type UpdateCronJobRequest = z.input<typeof updateCronJobSchema>;
export type CronJobResponse = z.infer<typeof cronJobResponseSchema>;
export type CronJobListResponse = z.infer<typeof cronJobListResponseSchema>;

// ─── Failure-email recipients (GET …/cron-jobs/failure-email-info) ─────────
//
// What the panels need to show the user who will actually be mailed: the
// tenant email as the API will resolve it at send time, and the daily cap.
export const cronFailureEmailInfoSchema = z.object({
  /** The tenant's primary email, or null when the tenant has none on record. */
  tenantEmail: z.string().nullable(),
  maxEmailsPerTenantPerDay: z.number().int().positive(),
});
export type CronFailureEmailInfo = z.infer<typeof cronFailureEmailInfoSchema>;

// ─── Bulk actions (ROADMAP R29a) ───────────────────────────────────────
//
// Authored from what the HANDLER reads, not from what the panel sends.
// Id columns are `varchar(36)` — UUID-shaped but not UUID-constrained — so
// these mirror the column rather than asserting `.uuid()`: a schema stricter
// than the storage rejects ids the platform itself is able to mint.

export const bulkCronJobActionSchema = z.object({
  cron_job_ids: z.array(z.string().min(1).max(36)),
  action: z.enum(['enable', 'disable', 'delete']),
});
export type BulkCronJobAction = z.infer<typeof bulkCronJobActionSchema>;
