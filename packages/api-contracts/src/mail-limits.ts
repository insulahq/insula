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

// PR 5 — Monitoring -> Mail tab aggregate.
export const mailOverviewResponseSchema = z.object({
  totals: z.object({
    sentToday: z.number().int().min(0),
    sent7d: z.number().int().min(0),
    recipients7d: z.number().int().min(0),
    rateLimited7d: z.number().int().min(0),
    quotaRejected7d: z.number().int().min(0),
  }),
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
