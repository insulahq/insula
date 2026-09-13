import { z } from 'zod';

// ─── Input Schemas ───────────────────────────────────────────────────────────

// Path token used in the break-glass IngressRoute's match expression
// + stripPrefix Middleware. The value is interpolated unescaped into a
// Traefik match rule (Host(`x`) && PathPrefix(`/<path>`)), so we
// restrict it to lowercase alphanumerics + hyphen — the same charset
// the regenerator emits (`bg-<32-hex>`). The `.regex` guard is defence-
// in-depth against a direct DB write that would otherwise allow
// path-traversal sequences (`/..`), backticks (Traefik match-expression
// escape), or whitespace. Auto-generated values always match this
// shape; operator-set values must too.
const BREAK_GLASS_PATH_RE = /^[a-z0-9-]+$/;

// R29a. This schema existed but was never wired to the route, and it did not
// describe the endpoint: it declared `protect_tenant_via_proxy` — which is the
// DATABASE COLUMN name (`oidc_global_settings.protect_tenant_via_proxy`), not a
// field `saveGlobalSettings` reads — while omitting `proxy_protect_admin` /
// `proxy_protect_tenant`, which are the two the admin panel actually sends.
//
// Wiring it unchanged would have been worse than leaving the route unvalidated:
// Zod STRIPS unknown keys by default, so the panel's proxy-protection toggles
// would have parsed clean, arrived empty, and stopped working with the endpoint
// still answering 200. This is the exact hazard ROADMAP R29a warns about —
// author the schema from what the HANDLER reads, never from what the panel
// sends, and never from what an earlier schema asserted.
//
// The handler takes either spelling of each toggle:
//   adminProxy  = input.protect_admin_via_proxy  ?? input.proxy_protect_admin
//   tenantProxy = input.protect_client_via_proxy ?? input.proxy_protect_tenant
// so all four are accepted here.
export const saveOidcGlobalSettingsSchema = z.object({
  disable_local_auth_admin: z.boolean().optional(),
  disable_local_auth_tenant: z.boolean().optional(),
  break_glass_secret: z.string().min(8).optional(),
  protect_admin_via_proxy: z.boolean().optional(),
  proxy_protect_admin: z.boolean().optional(),
  protect_client_via_proxy: z.boolean().optional(),
  proxy_protect_tenant: z.boolean().optional(),
  break_glass_path: z.union([
    z.string().min(1).max(100).regex(BREAK_GLASS_PATH_RE, {
      message: 'break_glass_path must contain only lowercase alphanumerics and hyphens',
    }),
    z.null(),
  ]).optional(),
}).strict();

// ─── Response Schemas ────────────────────────────────────────────────────────

export const oidcGlobalSettingsResponseSchema = z.object({
  disableLocalAuthAdmin: z.boolean(),
  disableLocalAuthTenant: z.boolean(),
  hasBreakGlassSecret: z.boolean(),
  protectAdminViaProxy: z.boolean(),
  protectTenantViaProxy: z.boolean(),
  breakGlassPath: z.string().nullable(),
});

export const breakGlassPathResponseSchema = z.object({
  breakGlassPath: z.string(),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type SaveOidcGlobalSettingsInput = z.infer<typeof saveOidcGlobalSettingsSchema>;
export type OidcGlobalSettingsResponse = z.infer<typeof oidcGlobalSettingsResponseSchema>;
export type BreakGlassPathResponse = z.infer<typeof breakGlassPathResponseSchema>;

// ─── OIDC provider create / update ───────────────────────────────────────────
//
// These live here, not in the backend service and not in a hand-written
// frontend interface, because the API-contract rule exists for exactly this
// failure: `frontend/admin-panel/src/hooks/use-oidc-settings.ts` declared its
// own `CreateProviderInput` with `tenant_id` / `tenant_secret` while the
// backend required `client_id` / `client_secret`. The local type was
// self-consistent, so tsc was satisfied and the panel compiled, shipped, and
// could not add a provider at all:
//
//   POST → 400 "display_name, issuer_url, client_id, client_secret, and
//               panel_scope are required"
//   PATCH → 200, with the client id and secret silently NOT written, because
//               the update skips fields that are `undefined`.
//
// With one shared schema, that mismatch is a compile error.
//
// Field names are snake_case here, unlike the platform's camelCase response
// convention — this endpoint shipped that way and renaming it would break any
// existing caller.

export const oidcProviderPanelScope = ['admin', 'tenant'] as const;
export type OidcProviderPanelScope = typeof oidcProviderPanelScope[number];

export const createOidcProviderSchema = z.object({
  display_name: z.string().min(1, 'display_name is required'),
  issuer_url: z.string().url('issuer_url must be a valid URL'),
  client_id: z.string().min(1, 'client_id is required'),
  client_secret: z.string().min(1, 'client_secret is required'),
  panel_scope: z.enum(oidcProviderPanelScope),
  enabled: z.boolean().optional(),
  backchannel_logout_enabled: z.boolean().optional(),
  display_order: z.number().int().optional(),
  auto_provision: z.boolean().optional(),
  default_role: z.string().optional(),
  additional_claims: z.array(z.string()).optional(),
}).strict();
export type CreateOidcProviderInput = z.infer<typeof createOidcProviderSchema>;

/**
 * PATCH input. `.strict()` matters more here than on create: an unknown key on
 * update is not a 400 you notice, it is a field that silently does not change
 * — the shape of the original bug. `client_secret` stays non-empty when
 * present so "leave unchanged" is expressed by omitting it, never by "".
 */
export const updateOidcProviderSchema = createOidcProviderSchema.partial().strict();
export type UpdateOidcProviderInput = z.infer<typeof updateOidcProviderSchema>;
