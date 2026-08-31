/**
 * F4 — DB-backed WAF rule exclusion management.
 *
 * Operators add surgical CRS rule exclusions from the WAF Events tab
 * ("Whitelist this rule for this host" button) or from the dedicated
 * Exclusions tab. A backend reconciler renders enabled rows into the
 * `modsec-crs-exclusions-dynamic` ConfigMap (file
 * REQUEST-901-EXCLUSION-RULES-BEFORE-CRS-DYNAMIC.conf) and bumps a
 * hash annotation on the modsec-crs Deployment so it rolls.
 *
 * scope:
 *  - 'args' — removes ARGS **and** ARGS_NAMES. This is the useful default
 *    and what an operator almost always means by "whitelist this rule for
 *    this host": the rule stops inspecting request arguments, and still
 *    scans REQUEST_URI, headers, cookies and body.
 *  - 'args_names_only' — removes ARGS_NAMES only, i.e. the field NAMES.
 *    Correct for the narrow case of a rule matching a JSON field name
 *    (930xxx/931xxx against LFI/RFI dictionaries) and A NO-OP FOR EVERYTHING
 *    ELSE. Kept for existing rows; not recommended for new ones.
 *  - 'full_disable' — `ctl:ruleRemoveById`. The rule is disabled entirely
 *    for matching hosts. Use sparingly.
 *
 * WHY 'args' EXISTS. 'args_names_only' was the default, and it silently does
 * nothing for any rule that matches argument VALUES — which is most of them.
 * Reported 2026-08-31: a PHP deploy was blocked by 932160 (Unix shell code in
 * an ARG value), the operator whitelisted 932160 for the host exactly as the
 * UI offered, the exclusion rendered and loaded correctly, and the deploy was
 * still blocked. The codebase already knew: waf-log-scraper.ts notes that
 * "removing an ARGS target is a no-op" for a rule that does not scan ARGS.
 * An exclusion scope that cannot fix the false positive it is offered for is
 * worse than none, because it looks like it worked.
 *
 * hostnameRegex is rendered as a `@rx <value>` operator against
 * `REQUEST_HEADERS:X-Forwarded-Host`. Validation:
 *  - parses as a JS RegExp (caught at write time, returned as 400)
 *  - contains NO double-quote (would close the SecRule string and
 *    allow rule injection — same defense as the DB CHECK constraint)
 *  - contains NO newline
 *  - operators are expected to anchor with ^ and $ to avoid over-broad
 *    matches; the UI surface defaults to a fully-anchored pattern
 *    when pre-filled from a WAF event row.
 *
 * The platform-api host (X-Forwarded-Host vs Host) gotcha — Traefik's
 * modsecurity plugin proxies every inspected request with
 * `Host: modsec-crs.traefik.svc.cluster.local` and puts the original
 * hostname in `X-Forwarded-Host`. Matching `Host` never fires.
 * Enforced by scripts/ci-modsec-exclusion-check.sh.
 */

import { z } from 'zod';

export const wafRuleExclusionScopeSchema = z.enum(['args', 'args_names_only', 'full_disable']);
export type WafRuleExclusionScope = z.infer<typeof wafRuleExclusionScopeSchema>;

const hostnameRegexBase = z
  .string()
  .min(1)
  .max(255)
  // Block characters that break the rendered SecRule string. Backslash
  // IS allowed because legitimate hostname patterns escape `.` as `\.` —
  // `buildHostnameRegexFromEventHost` below produces those. Trailing or
  // hanging backslash that would crash the PCRE parser is caught at
  // the CREATE/UPDATE schema layer via .refine(regexParseable), which
  // calls `new RegExp(value)` and surfaces the SyntaxError as a 400.
  .regex(/^[^"\n\r]+$/, 'hostname regex must not contain double-quote or newline');

export const wafRuleExclusionSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().regex(/^[0-9]+$/, 'rule id must be digits only'),
  hostnameRegex: hostnameRegexBase,
  scope: wafRuleExclusionScopeSchema,
  reason: z.string().min(1).max(1024),
  createdBy: z.string().min(1).max(255),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  disabled: z.boolean(),
  // B2 (2026-05-26): non-null when the row is owned by a tenant, null
  // when admin-created. Always co-non-null with routeId (DB CHECK).
  tenantId: z.string().uuid().nullable(),
  routeId: z.string().uuid().nullable(),
});
export type WafRuleExclusion = z.infer<typeof wafRuleExclusionSchema>;

export const wafRuleExclusionListResponseSchema = z.object({
  exclusions: z.array(wafRuleExclusionSchema),
});
export type WafRuleExclusionListResponse = z.infer<typeof wafRuleExclusionListResponseSchema>;

/**
 * Admin list variant — same row shape PLUS tenantName from a LEFT JOIN
 * on tenants. Null for admin-scoped (tenantId IS NULL) rows.
 */
export const wafRuleExclusionAdminListResponseSchema = z.object({
  exclusions: z.array(wafRuleExclusionSchema.extend({
    tenantName: z.string().nullable(),
  })),
});
export type WafRuleExclusionAdminListResponse =
  z.infer<typeof wafRuleExclusionAdminListResponseSchema>;

// ─── Tenant-scoped CRUD ──────────────────────────────────────────────────
//
// B2: tenants can manage exclusions for ONE of their routes (and only
// that route). The server resolves hostnameRegex from the route's
// hostname — clients never supply it. tenantId + routeId come from the
// URL path; the body carries only the ruleId/scope/reason knobs.

export const createTenantWafRuleExclusionRequestSchema = z.object({
  ruleId: z.string().regex(/^[0-9]+$/),
  scope: wafRuleExclusionScopeSchema,
  reason: z.string().min(1).max(1024),
});
export type CreateTenantWafRuleExclusionRequest =
  z.infer<typeof createTenantWafRuleExclusionRequestSchema>;

/**
 * Refine: hostnameRegex must parse as a JS RegExp. Same engine that
 * ModSecurity's @rx operator uses (PCRE) accepts a superset, so JS
 * parseability is a reasonable lower-bound sanity check that catches
 * obvious typos (unbalanced parens, dangling backslash).
 */
const regexParseable = (value: string): boolean => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
};

export const createWafRuleExclusionRequestSchema = z.object({
  ruleId: z.string().regex(/^[0-9]+$/),
  hostnameRegex: hostnameRegexBase.refine(regexParseable, {
    message: 'hostname regex must parse as a JavaScript RegExp',
  }),
  scope: wafRuleExclusionScopeSchema,
  reason: z.string().min(1).max(1024),
});
export type CreateWafRuleExclusionRequest = z.infer<typeof createWafRuleExclusionRequestSchema>;

export const updateWafRuleExclusionRequestSchema = z.object({
  hostnameRegex: hostnameRegexBase.refine(regexParseable).optional(),
  scope: wafRuleExclusionScopeSchema.optional(),
  reason: z.string().min(1).max(1024).optional(),
  disabled: z.boolean().optional(),
}).refine(
  (obj) => Object.keys(obj).length > 0,
  { message: 'at least one field must be provided' },
);
export type UpdateWafRuleExclusionRequest = z.infer<typeof updateWafRuleExclusionRequestSchema>;

/**
 * "Whitelist this rule for this host" pre-fill helper — used by the
 * frontend to convert a WAF event into a sensible default exclusion.
 * Returns a fully-anchored regex matching the exact hostname.
 */
export const buildHostnameRegexFromEventHost = (hostname: string): string => {
  // Escape regex metacharacters in the hostname (only `.` is realistic
  // for DNS hostnames, but defend against anything else).
  const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}$`;
};
