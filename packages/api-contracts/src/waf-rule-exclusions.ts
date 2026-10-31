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
 *  - 'text_plain_as_json' — rule 920420 only. Accepts a `text/plain` body and
 *    has ModSecurity parse it as JSON, so it is still inspected. Browsers send
 *    `navigator.sendBeacon(url, string)` as `text/plain`; apps put JSON in it
 *    (Moodle's H5P progress saves, for one). Removing 920420 outright would let
 *    ANY body type through uninspected: ModSecurity parses only the types it
 *    knows, and an app that reads the raw body (Moodle's AJAX endpoint reads
 *    php://input whatever the Content-Type) receives what the WAF never saw.
 *    A body that is not valid JSON still fails (REQBODY_ERROR → 200002).
 *
 * pathRegex (optional) narrows any scope to requests whose path matches it,
 * rendered as a chained `REQUEST_FILENAME @rx <pathRegex>`: the path without
 * the query string, URL-decoded. Measured on CRS 4.30 / libmodsecurity 3.0.17:
 * `%2e` and `%2f` match as `.` and `/`; `//`, `/./`, `/../`, `;param`, a
 * trailing `/` and other letter case do NOT match, so such a request simply
 * keeps the full rule (fails closed). It must start with `^/`; end it with `$`
 * to match one path exactly. Null = every path on the host.
 *
 * Unlike hostnameRegex, a TENANT types this regex, and ModSecurity compiles it
 * with PCRE, not JavaScript. A pattern JS accepts but PCRE refuses (`\q`, `\1`,
 * `[\d-z]`, a variable-length lookbehind — all measured) fails the WAF's config
 * load: every site behind it, every tenant. So only a portable subset is
 * accepted — see isPortablePathRegex.
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

export const wafRuleExclusionScopeSchema = z.enum(['args', 'args_names_only', 'full_disable', 'text_plain_as_json']);
export type WafRuleExclusionScope = z.infer<typeof wafRuleExclusionScopeSchema>;

/** The only rule 'text_plain_as_json' applies to: CRS "Request content type is not allowed by policy". */
export const WAF_CONTENT_TYPE_RULE_ID = '920420';

/** Whether `scope` can be used with `ruleId` — 'text_plain_as_json' is meaningful for 920420 only. */
export const isWafExclusionScopeValidForRule = (scope: WafRuleExclusionScope, ruleId: string): boolean =>
  scope !== 'text_plain_as_json' || ruleId === WAF_CONTENT_TYPE_RULE_ID;

const SCOPE_RULE_MISMATCH = `scope text_plain_as_json applies to rule ${WAF_CONTENT_TYPE_RULE_ID} only`;

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

/**
 * Refine: a regex must parse as a JS RegExp. Same engine that
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

/**
 * Whether a path regex stays inside the subset JavaScript and PCRE both
 * compile, with the same meaning. Refused: groups other than `(` and `(?:`
 * (lookarounds, named groups, inline flags), a backslash before a letter or
 * digit other than \d \D \w \W \s \S (and \b \B outside a class) — that covers
 * backreferences, \k, \p, \u, \x, \c and unknown letters —, nested `[`
 * and shorthand classes inside `[...]` (POSIX classes, `[\d-z]`), a class
 * that is empty or starts with `:` / `=`, a `{` that is not an `{n}`, `{n,}`
 * or `{n,m}` quantifier, and a stray `}`. Each refused form was checked
 * against the CRS image's PCRE; waf-rule-exclusions.test.ts lists them.
 */
export const isPortablePathRegex = (value: string): boolean => {
  let inClass = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    const next = value[i + 1];
    if (ch === '\\') {
      if (next === undefined) return false;
      const isAlnum = /[A-Za-z0-9]/.test(next);
      if (isAlnum) {
        const allowed = inClass ? '' : 'dDwWsSbB';
        if (!allowed.includes(next)) return false;
      }
      i += 1;
      continue;
    }
    if (inClass) {
      if (ch === '[') return false;
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      if (value[j] === '^') j += 1;
      if (value[j] === ']' || value[j] === ':' || value[j] === '=') return false;
      inClass = true;
      i = j - 1;
      continue;
    }
    if (ch === '(' && next === '?' && value[i + 2] !== ':') return false;
    if (ch === '{') {
      const q = /^\{\d+(,\d*)?\}/.exec(value.slice(i));
      if (!q) return false;
      i += q[0].length - 1;
      continue;
    }
    if (ch === '}') return false;
  }
  return !inClass;
};

const pathRegexBase = z
  .string()
  .min(2)
  .max(255)
  .regex(/^[^"\n\r]+$/, 'path regex must not contain double-quote or newline')
  // Anchored at the start so an exception cannot silently cover more paths
  // than the operator meant (`/admin` unanchored also matches `/x/admin/y`).
  .regex(/^\^\//, 'path regex must start with ^/ (anchor it to the start of the path)');

/** Path regex as accepted on create/update: parseable, portable to PCRE, no trailing backslash. */
export const wafRuleExclusionPathRegexSchema = pathRegexBase
  // Also the DB CHECK's rule; checked here so the answer is a 400, not a constraint error.
  .refine((v) => !v.endsWith('\\'), { message: 'path regex must not end with a backslash' })
  .refine(regexParseable, { message: 'path regex must parse as a regular expression' })
  .refine(isPortablePathRegex, {
    message: 'path regex uses syntax the WAF cannot compile — use literal characters, . * + ? | ( ) (?: ) [ ] {n,m} ^ $ and \\d \\w \\s',
  });

export const wafRuleExclusionSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().regex(/^[0-9]+$/, 'rule id must be digits only'),
  hostnameRegex: hostnameRegexBase,
  // Null = every path on the host.
  pathRegex: pathRegexBase.nullable(),
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
  // Narrows the exception to matching paths of the route's host; a tenant can
  // only make its own exception smaller, never reach another host.
  pathRegex: wafRuleExclusionPathRegexSchema.nullable().optional(),
  scope: wafRuleExclusionScopeSchema,
  reason: z.string().min(1).max(1024),
}).refine((v) => isWafExclusionScopeValidForRule(v.scope, v.ruleId), {
  message: SCOPE_RULE_MISMATCH,
  path: ['scope'],
});
export type CreateTenantWafRuleExclusionRequest =
  z.infer<typeof createTenantWafRuleExclusionRequestSchema>;

export const createWafRuleExclusionRequestSchema = z.object({
  ruleId: z.string().regex(/^[0-9]+$/),
  hostnameRegex: hostnameRegexBase.refine(regexParseable, {
    message: 'hostname regex must parse as a JavaScript RegExp',
  }),
  pathRegex: wafRuleExclusionPathRegexSchema.nullable().optional(),
  scope: wafRuleExclusionScopeSchema,
  reason: z.string().min(1).max(1024),
}).refine((v) => isWafExclusionScopeValidForRule(v.scope, v.ruleId), {
  message: SCOPE_RULE_MISMATCH,
  path: ['scope'],
});
export type CreateWafRuleExclusionRequest = z.infer<typeof createWafRuleExclusionRequestSchema>;

// The rule id is not part of an update, so a scope/rule mismatch on update is
// refused by the service (it knows the stored rule id).
export const updateWafRuleExclusionRequestSchema = z.object({
  hostnameRegex: hostnameRegexBase.refine(regexParseable).optional(),
  // null clears the path, so the exception covers every path again.
  pathRegex: wafRuleExclusionPathRegexSchema.nullable().optional(),
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

/**
 * "Only this path" pre-fill: the event's request URI without its query string
 * or fragment, as a fully-anchored regex. Null when there is no usable path
 * (empty, not starting with `/`, or holding a character a SecRule string
 * cannot carry).
 */
export const buildPathRegexFromEventUri = (uri: string | null | undefined): string | null => {
  const path = (uri ?? '').split(/[?#]/, 1)[0] ?? '';
  if (!path.startsWith('/') || /["\r\n]/.test(path)) return null;
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = `^${escaped}$`;
  return regex.length <= 255 ? regex : null;
};
