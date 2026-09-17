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

const timeoutField = z
  .number()
  .int()
  .min(CRON_TIMEOUT_MIN_SECONDS)
  .max(CRON_TIMEOUT_MAX_SECONDS)
  .optional();

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
  enabled: z.boolean().default(true),
}).refine(
  (data) => {
    if (data.type === 'webcron') return !!data.url;
    if (data.type === 'deployment') return !!data.command && !!data.deployment_id;
    return false;
  },
  { message: 'Webcron requires url; deployment cron requires command and deployment_id' }
);

export const updateCronJobSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  schedule: z.string().regex(cronRegex, 'Invalid cron expression').optional(),
  url: z.string().url().max(2000).optional(),
  http_method: z.enum(['GET', 'POST', 'PUT']).optional(),
  command: z.string().min(1).max(2000).optional(),
  deployment_id: z.string().uuid().optional(),
  timeout_seconds: timeoutField,
  enabled: z.boolean().optional(),
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
  url: z.string().nullable(),
  httpMethod: z.string().nullable(),
  deploymentId: z.string().nullable(),
  enabled: z.number(),
  lastRunAt: z.string().nullable(),
  lastRunStatus: z.enum(['success', 'failed', 'running']).nullable(),
  lastRunDurationMs: z.number().nullable(),
  lastRunResponseCode: z.number().nullable(),
  lastRunOutput: z.string().nullable(),
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
export type CronJobResponse = z.infer<typeof cronJobResponseSchema>;
export type CronJobListResponse = z.infer<typeof cronJobListResponseSchema>;

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
