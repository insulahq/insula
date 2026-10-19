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

/**
 * One tenant's outbound mail per UTC calendar day, oldest first, every day of
 * the window present (a day that sent nothing is a row of zeros, not a gap).
 */
export const mailDailyResponseSchema = z.object({
  days: z.array(z.object({
    /** UTC calendar day, `YYYY-MM-DD`. */
    date: z.string(),
    sent: z.number().int().min(0),
    recipients: z.number().int().min(0),
    rateLimited: z.number().int().min(0),
    quotaRejected: z.number().int().min(0),
  })),
});

export type MailDailyResponse = z.infer<typeof mailDailyResponseSchema>;

/**
 * What the mail server holds for one tenant's send limits, beside what the
 * platform wants it to hold — per mail domain, because the limits are keyed
 * by sender domain there.
 *
 * `inEffect` is true only when every object the platform wants exists exactly
 * once with the wanted values and nothing else of ours is left for the domain.
 * It is what the mail server STORES; the reconcile that wrote it also reloads
 * the server's settings, and logs an error when that reload fails.
 */
export const sendLimitLiveStateSchema = z.object({
  checkedAt: z.string(),
  /** False when the mail server could not be asked; every domain then reads not in effect. */
  reachable: z.boolean(),
  domains: z.array(z.object({
    domain: z.string(),
    desired: z.object({
      hourly: z.number().int().min(0),
      daily: z.number().int().min(0),
      blocked: z.boolean(),
    }),
    live: z.object({
      hourly: z.number().int().min(0).nullable(),
      daily: z.number().int().min(0).nullable(),
      backlog: z.number().int().min(0).nullable(),
      blocked: z.boolean(),
      /** Extra objects under a description that should exist once. */
      duplicates: z.number().int().min(0),
    }),
    inEffect: z.boolean(),
  })),
});

export type SendLimitLiveState = z.infer<typeof sendLimitLiveStateSchema>;

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
