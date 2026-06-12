import { z } from 'zod';

// R6 PR 1 — effective outbound send limits for a tenant.
//
// Resolution chain (per window): tenant override -> plan value
// (hosting_plans.email_hourly_send_limit / email_daily_send_limit) ->
// hardcoded fallback (only if the plan row is missing). Suspension
// (tenant lifecycle OR the admin outbound-mail lever) forces 0.
//
// The legacy keys `limitPerHour` / `source` / `suspended` predate the
// daily window and are kept so existing consumers (tenant-panel Email
// page) don't break; new consumers should read `hourly` / `daily`.

export const sendLimitSourceEnum = z.enum([
  'tenant_override',
  'plan',
  'suspended',
  'outbound_suspended',
  'fallback_default',
]);

const resolvedWindowSchema = z.object({
  limit: z.number().int().min(0),
  source: sendLimitSourceEnum,
});

export const effectiveSendLimitsSchema = z.object({
  hourly: resolvedWindowSchema,
  daily: resolvedWindowSchema,
  /** Tenant lifecycle suspension (tenants.status === 'suspended'). */
  suspended: z.boolean(),
  /** Admin outbound-mail lever (tenants.email_outbound_suspended). */
  outboundSuspended: z.boolean(),
  planId: z.string().nullable(),
  planCode: z.string().nullable(),
  // ── Legacy keys (pre-daily shape) ──
  // The legacy enum is narrower on purpose: legacySource() in
  // backend email-outbound/rate-limit.ts maps outbound_suspended ->
  // 'suspended' and plan -> 'platform_default', fallback_default ->
  // 'hardcoded_default'. Keep that mapping total if values change.
  limitPerHour: z.number().int().min(0),
  source: z.enum([
    'tenant_override',
    'platform_default',
    'hardcoded_default',
    'suspended',
  ]),
});

export type SendLimitSource = z.infer<typeof sendLimitSourceEnum>;
export type EffectiveSendLimits = z.infer<typeof effectiveSendLimitsSchema>;

// R6 PR 2 — tenant mail usage (current hour / day vs effective limits).
const usageWindowSchema = z.object({
  used: z.number().int().min(0),
  limit: z.number().int().min(0),
});

export const mailUsageResponseSchema = z.object({
  hour: usageWindowSchema,
  day: usageWindowSchema.extend({
    recipients: z.number().int().min(0),
    rateLimited: z.number().int().min(0),
    quotaRejected: z.number().int().min(0),
  }),
  suspended: z.boolean(),
  outboundSuspended: z.boolean(),
});

export type MailUsageResponse = z.infer<typeof mailUsageResponseSchema>;

// R4 PR 3 — FBL complaints.
export const fblComplaintSchema = z.object({
  id: z.string(),
  stalwartReportId: z.string(),
  tenantId: z.string().nullable(),
  domain: z.string().nullable(),
  feedbackType: z.string(),
  originalMailFrom: z.string().nullable(),
  originalRcptTo: z.string().nullable(),
  sourceIp: z.string().nullable(),
  reportingMta: z.string().nullable(),
  reporter: z.string().nullable(),
  incidents: z.number().int().min(1),
  receivedAt: z.union([z.string(), z.date()]),
  createdAt: z.union([z.string(), z.date()]),
});

export const complaintSummaryEntrySchema = z.object({
  tenantId: z.string().nullable(),
  tenantName: z.string().nullable(),
  domain: z.string().nullable(),
  sent7d: z.number().int().min(0),
  sent30d: z.number().int().min(0),
  complaints7d: z.number().int().min(0),
  complaints30d: z.number().int().min(0),
  /** complaints / sends; 1 when complaints exist with no recorded sends. */
  complaintRate7d: z.number().min(0),
  complaintRate30d: z.number().min(0),
  lastComplaintAt: z.union([z.string(), z.date()]).nullable(),
});

export type FblComplaint = z.infer<typeof fblComplaintSchema>;
export type ComplaintSummaryEntry = z.infer<typeof complaintSummaryEntrySchema>;
