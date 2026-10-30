/**
 * Per-route OIDC sign-in gate — API contract.
 *
 * A tenant puts any of its ingress routes behind an OpenID Connect sign-in.
 * The platform runs ONE oauth2-proxy per tenant namespace (with the gate
 * sidecar that applies each route's policy), so every enabled route of a
 * tenant uses the same provider; a second provider is refused.
 */
import { z } from 'zod';

export const claimOperatorSchema = z.enum([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'exists',
  'regex',
]);
export type ClaimOperator = z.infer<typeof claimOperatorSchema>;

/**
 * Single claim rule, evaluated against the ID token's claims. All rules on a
 * route must hold (AND), on top of the allow lists.
 *
 * - `equals` / `not_equals`: string equality (case-sensitive)
 * - `contains` / `not_contains`: substring for strings, element-of for arrays
 * - `in` / `not_in`: the claim (or any element of it) is one of the values
 * - `exists`: claim is present; `value` ignored
 * - `regex`: ECMAScript regex match
 */
export const claimRuleSchema = z.object({
  claim: z.string().trim().min(1).max(200),
  operator: claimOperatorSchema,
  value: z.union([z.string().max(500), z.array(z.string().max(500)).max(100)]).optional(),
}).superRefine((r, ctx) => {
  const listOps = r.operator === 'in' || r.operator === 'not_in';
  if (r.operator === 'exists') return;
  if (listOps && !(Array.isArray(r.value) && r.value.length > 0)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: `'${r.operator}' needs a list of values` });
  }
  if (!listOps && typeof r.value !== 'string') {
    ctx.addIssue({ code: 'custom', path: ['value'], message: `'${r.operator}' needs one value` });
  }
  if (r.operator === 'regex' && typeof r.value === 'string') {
    try { new RegExp(r.value); } catch {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Not a valid regular expression' });
    }
  }
});
export type ClaimRule = z.infer<typeof claimRuleSchema>;

/** No control characters (newline, NUL, …) — these values end up in process arguments. */
const PLAIN = /^[^\p{Cc}]*$/u;
const plain = (max: number) => z.string().trim().min(1).max(max).regex(PLAIN, 'Must not contain control characters');

/** An issuer is an https URL with no query or fragment (discovery is appended to it). */
export const issuerUrlSchema = z.string().trim().url().max(500)
  .refine((u) => u.startsWith('https://'), 'The issuer URL must start with https://')
  .refine((u) => !/[?#]/.test(u), 'The issuer URL must not contain ? or #');

/** Space-separated scope tokens; `openid` is required. */
export const oidcScopesSchema = z.string().trim().max(500)
  .regex(/^[\x21-\x7e]+( [\x21-\x7e]+)*$/, 'Scopes are words separated by single spaces')
  .refine((s) => s.split(' ').includes('openid'), 'Scopes must include openid');

const providerFields = {
  name: z.string().trim().min(1).max(120),
  issuerUrl: issuerUrlSchema,
  oauthClientId: plain(255),
  /** Plaintext. Required on create; omitted on update = keep. */
  oauthClientSecret: plain(500),
  usePkce: z.boolean(),
  defaultScopes: oidcScopesSchema,
};

/** Create a provider (stored per tenant, reused by that tenant's routes). */
export const oidcProviderInputSchema = z.object({
  ...providerFields,
  usePkce: providerFields.usePkce.default(true),
  defaultScopes: providerFields.defaultScopes.default('openid profile email'),
});
export type OidcProviderInput = z.infer<typeof oidcProviderInputSchema>;

/** Update a provider — every field optional, and NO defaults: an omitted field is kept. */
export const oidcProviderUpdateSchema = z.object(providerFields).partial();
export type OidcProviderUpdateInput = z.infer<typeof oidcProviderUpdateSchema>;

export const oidcProviderResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  issuerUrl: z.string(),
  oauthClientId: z.string(),
  secretSet: z.boolean(),
  usePkce: z.boolean(),
  defaultScopes: z.string(),
  /** Number of routes using this provider. */
  consumerCount: z.number().int().nonnegative(),
  /** Redirect URIs to register at the provider: one per host of a route using it. */
  callbackUrls: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OidcProviderResponse = z.infer<typeof oidcProviderResponseSchema>;

/** A hostname or a parent domain of it, optionally with a leading dot. */
const cookieDomainSchema = z.string().trim().toLowerCase().max(253)
  .regex(/^\.?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/, 'Not a domain name');

/** Every route sign-in field, none with a default. */
const ingressAuthFields = {
  enabled: z.boolean(),
  providerId: z.string().optional(),
  issuerUrl: issuerUrlSchema.optional(),
  clientId: plain(255).optional(),
  clientSecret: plain(500).optional(),
  usePkce: z.boolean().optional(),
  /** Inline creation only: the new provider's scopes. */
  scopes: oidcScopesSchema.optional(),
  /** Every sign-in lands here instead of the page the visitor asked for (a host of this tenant). */
  postLoginRedirectUrl: z.string().trim().url().max(2048)
    .refine((u) => u.startsWith('https://'), 'Must start with https://').nullable(),
  /** Comma-separated. A visitor passes when every list is empty, or any entry matches. */
  allowedEmails: z.string().max(10_000).nullable(),
  allowedEmailDomains: z.string().max(10_000).nullable(),
  allowedGroups: z.string().max(10_000).nullable(),
  claimRules: z.array(claimRuleSchema).max(50).nullable(),
  /** Replaces the request's own Authorization header — off unless the app expects the ID token there. */
  passAuthorizationHeader: z.boolean(),
  passAccessToken: z.boolean(),
  passIdToken: z.boolean(),
  /** X-Auth-Request-User / -Email / -Preferred-Username. */
  passUserHeaders: z.boolean(),
  /** X-Auth-Request-Groups. */
  setXauthrequest: z.boolean(),
  /** Share the sign-in across sub-domains: a parent domain of the route's host, within the tenant's domains. */
  cookieDomain: cookieDomainSchema.nullable(),
  /** 0 = never re-check with the provider before the cookie expires. */
  cookieRefreshSeconds: z.number().int().min(0).max(7 * 86400),
  cookieExpireSeconds: z.number().int().min(60).max(30 * 86400),
};

/** Refresh must stay below expiry (oauth2-proxy refuses to start otherwise). */
export function cookieTimingIssue(c: { cookieRefreshSeconds: number; cookieExpireSeconds: number }): string | null {
  return c.cookieRefreshSeconds > 0 && c.cookieRefreshSeconds >= c.cookieExpireSeconds
    ? 'Cookie refresh must be shorter than cookie expiry (or 0)'
    : null;
}

/**
 * A complete route sign-in policy, with defaults for what is not given.
 * Two ways to choose the provider:
 *   - `providerId`: an existing provider of this tenant (preferred)
 *   - inline `issuerUrl` + `clientId` + `clientSecret`: create one now
 */
export const ingressAuthConfigSchema = z.object({
  ...ingressAuthFields,
  postLoginRedirectUrl: ingressAuthFields.postLoginRedirectUrl.optional(),
  allowedEmails: ingressAuthFields.allowedEmails.optional(),
  allowedEmailDomains: ingressAuthFields.allowedEmailDomains.optional(),
  allowedGroups: ingressAuthFields.allowedGroups.optional(),
  claimRules: ingressAuthFields.claimRules.optional(),
  passAuthorizationHeader: ingressAuthFields.passAuthorizationHeader.default(false),
  passAccessToken: ingressAuthFields.passAccessToken.default(false),
  passIdToken: ingressAuthFields.passIdToken.default(false),
  passUserHeaders: ingressAuthFields.passUserHeaders.default(true),
  setXauthrequest: ingressAuthFields.setXauthrequest.default(true),
  cookieDomain: ingressAuthFields.cookieDomain.optional(),
  cookieRefreshSeconds: ingressAuthFields.cookieRefreshSeconds.default(0),
  cookieExpireSeconds: ingressAuthFields.cookieExpireSeconds.default(86400),
}).superRefine((c, ctx) => {
  const issue = cookieTimingIssue(c);
  if (issue) ctx.addIssue({ code: 'custom', path: ['cookieRefreshSeconds'], message: issue });
});
export type IngressAuthConfigInput = z.infer<typeof ingressAuthConfigSchema>;

/**
 * PATCH body: every field optional and none defaulted, so an omitted field
 * KEEPS its saved value. (With defaults, a client sending only
 * `{enabled, providerId}` would clear the allow lists and open the site.)
 * `null` clears a nullable field.
 */
export const ingressAuthConfigPatchSchema = z.object(ingressAuthFields).partial();
export type IngressAuthConfigPatch = z.infer<typeof ingressAuthConfigPatchSchema>;

/** Server-rendered route policy, with the provider flattened in. Secrets are never returned. */
export const ingressAuthConfigResponseSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string(),
  providerName: z.string(),
  issuerUrl: z.string(),
  clientId: z.string(),
  clientSecretSet: z.boolean(),
  usePkce: z.boolean(),
  /** The provider's scopes. */
  scopes: z.string(),
  postLoginRedirectUrl: z.string().nullable(),
  allowedEmails: z.string().nullable(),
  allowedEmailDomains: z.string().nullable(),
  allowedGroups: z.string().nullable(),
  claimRules: z.array(claimRuleSchema).nullable(),
  passAuthorizationHeader: z.boolean(),
  passAccessToken: z.boolean(),
  passIdToken: z.boolean(),
  passUserHeaders: z.boolean(),
  setXauthrequest: z.boolean(),
  cookieDomain: z.string().nullable(),
  cookieRefreshSeconds: z.number().int(),
  cookieExpireSeconds: z.number().int(),
  /** Redirect URI to register at the provider (on the host the route serves). */
  callbackUrl: z.string(),
  /** Why the sign-in gate is not working, when it is not. */
  lastError: z.string().nullable(),
  lastReconciledAt: z.string().nullable(),
});
export type IngressAuthConfigResponse = z.infer<typeof ingressAuthConfigResponseSchema>;

export const ingressAuthTestResponseSchema = z.object({
  ok: z.boolean(),
  issuerReachable: z.boolean(),
  /** The issuer exactly as the provider publishes it — saved in this form. */
  issuer: z.string().nullable(),
  authorizationEndpoint: z.string().nullable(),
  tokenEndpoint: z.string().nullable(),
  jwksUri: z.string().nullable(),
  error: z.string().nullable(),
});
export type IngressAuthTestResponse = z.infer<typeof ingressAuthTestResponseSchema>;
