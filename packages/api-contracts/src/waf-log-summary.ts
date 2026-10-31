/**
 * WAF event retention + the "would block" summary.
 *
 * waf_logs keeps one row per (request, matching rule) the WAF blocked, or in
 * detection-only mode would have blocked. It used to keep only the newest 50
 * rows per route (500 for all platform hosts together), which reduced a
 * week-long detection dry run to its last minutes. It now keeps rows for
 * `retentionDays`, with a per-route ceiling as a safety valve against floods
 * that never removes rows younger than `protectedRecentMinutes` — CrowdSec
 * auto-ban judges those.
 *
 * The summary groups those rows by rule and request path, which is what an
 * operator decides exceptions from.
 */
import { z } from 'zod';
import type { WafRuleExclusionScope } from './waf-rule-exclusions.js';

export const WAF_LOG_RETENTION_DAYS_DEFAULT = 30;
export const WAF_LOG_RETENTION_DAYS_MIN = 1;
export const WAF_LOG_RETENTION_DAYS_MAX = 365;

export const wafLogSettingsSchema = z.object({
  retentionDays: z.number().int().min(WAF_LOG_RETENTION_DAYS_MIN).max(WAF_LOG_RETENTION_DAYS_MAX),
  /** Most rows one tenant route keeps; older ones go first. Fixed. */
  routeCeiling: z.number().int(),
  /** Most rows all platform (admin/API) hosts keep together. Fixed. */
  adminHostCeiling: z.number().int(),
  /** Rows younger than this are never removed by the ceiling. Fixed. */
  protectedRecentMinutes: z.number().int(),
  /** Rows currently kept, and the oldest one's time — what the setting is doing. */
  storedEvents: z.number().int(),
  oldestEventAt: z.string().datetime().nullable(),
});
export type WafLogSettings = z.infer<typeof wafLogSettingsSchema>;

export const patchWafLogSettingsRequestSchema = z.object({
  retentionDays: z.number().int().min(WAF_LOG_RETENTION_DAYS_MIN).max(WAF_LOG_RETENTION_DAYS_MAX),
});
export type PatchWafLogSettingsRequest = z.infer<typeof patchWafLogSettingsRequestSchema>;

/** One (host, rule, path) of the summary. */
export const wafLogSummaryRowSchema = z.object({
  hostname: z.string(),
  ruleId: z.string(),
  message: z.string(),
  /** The request path without the query string. */
  path: z.string(),
  /** Requests on this path that matched this rule. */
  requests: z.number().int(),
  /** Of those, checked in detection-only mode — logged, not blocked. */
  detectionOnly: z.number().int(),
  sourceIps: z.number().int(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});
export type WafLogSummaryRow = z.infer<typeof wafLogSummaryRowSchema>;

export const wafLogSummaryResponseSchema = z.object({
  /** Requests blocked (or, detection-only, flagged) in the window: one per request, whatever rules matched. */
  requests: z.number().int(),
  rows: z.array(wafLogSummaryRowSchema),
  /** More (host, rule, path) groups exist than were returned. */
  truncated: z.boolean(),
});
export type WafLogSummaryResponse = z.infer<typeof wafLogSummaryResponseSchema>;

/** Windows the summary offers, in seconds. */
export const WAF_LOG_SUMMARY_WINDOWS = [86_400, 7 * 86_400, 30 * 86_400] as const;

export const tenantWafLogSummaryQuerySchema = z.object({
  sinceSeconds: z.coerce.number().int().min(3600).max(30 * 86_400).default(7 * 86_400),
});
export type TenantWafLogSummaryQuery = z.infer<typeof tenantWafLogSummaryQuerySchema>;

/**
 * The exception scope worth suggesting for a rule, from what the rule inspects.
 *
 * `args` is a no-op for a rule that does not read request parameters, and the
 * exception would save, show as active and change nothing. So:
 *  - 920420 (content type not allowed) → text_plain_as_json, the one scope
 *    that fixes a text/plain beacon and still inspects its body;
 *  - other protocol rules (911 method, 913 scanner, 920/921 protocol, 922
 *    multipart) read headers, the request line or multipart part headers →
 *    full_disable, meant together with a path;
 *  - the attack families (930–944) read parameters → args.
 * The panels pre-select it; the operator can change it.
 */
export const suggestWafExclusionScope = (ruleId: string): WafRuleExclusionScope => {
  if (ruleId === '920420') return 'text_plain_as_json';
  if (/^9(11|13|20|21|22)\d{3}$/.test(ruleId)) return 'full_disable';
  return 'args';
};
