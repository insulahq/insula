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

/**
 * One tenant's outbound mail per domain (tenant panel → Email → Statistics).
 * The windows and counters of the operator's Monitoring → Mail table, for
 * this tenant's domains only.
 */
export const mailDomainStatsResponseSchema = z.object({
  windowDays: z.number().int().min(1),
  domains: z.array(z.object({
    domain: z.string(),
    /** An email domain of the tenant; false for a domain that only sends through the relay. */
    emailHosted: z.boolean(),
    sent24h: z.number().int().min(0),
    sent7d: z.number().int().min(0),
    recipients7d: z.number().int().min(0),
    rateLimited7d: z.number().int().min(0),
    quotaRejected7d: z.number().int().min(0),
  })),
});

export type MailDomainStatsResponse = z.infer<typeof mailDomainStatsResponseSchema>;

// PR 5 — Monitoring -> Mail tab aggregate.
export const mailOverviewResponseSchema = z.object({
  totals: z.object({
    // Rolling, like the top-senders `sent24h`. A calendar "today" reset at
    // UTC midnight — 02:00 for an operator at UTC+2 — so the tile read 0 in
    // the middle of their working day while mail was flowing.
    sent24h: z.number().int().min(0),
    sent7d: z.number().int().min(0),
    recipients7d: z.number().int().min(0),
    rateLimited7d: z.number().int().min(0),
    quotaRejected7d: z.number().int().min(0),
  }),
  /** Every domain that sent in the last 7 days, most mail first — up to 1,000 rows, not only the top ten. */
  topSenders: z.array(z.object({
    tenantId: z.string(),
    tenantName: z.string().nullable(),
    domain: z.string(),
    sent24h: z.number().int().min(0),
    sent7d: z.number().int().min(0),
    rateLimited7d: z.number().int().min(0),
    quotaRejected7d: z.number().int().min(0),
  })),
  queue: z.object({
    reachable: z.boolean(),
    depth: z.number().int().min(0),
    /** More messages are queued than were listed — the depth is a floor. */
    truncated: z.boolean().default(false),
    entries: z.array(z.object({
      id: z.string(),
      from: z.string(),
      recipients: z.array(z.string()),
      createdAt: z.string().nullable(),
      nextRetry: z.string().nullable(),
      size: z.number().nullable(),
    })),
  }),
  protection: z.object({
    // 'auto' retired 2026-09-15 with FBL — it only ever acted on complaint rates.
    mode: z.enum(['off', 'notify']),
  }),
});

export type MailOverviewResponse = z.infer<typeof mailOverviewResponseSchema>;
