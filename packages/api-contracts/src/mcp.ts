import { z } from 'zod';

/**
 * AI agents (MCP) — access for agents acting on the platform's API.
 *
 * Two MCP endpoints, one per panel:
 *   admin   https://admin.<apex>/api/v1/mcp   — users with the `admin` role
 *   tenant  https://tenant.<apex>/api/v1/mcp  — any active tenant-panel user,
 *           once the operator switches tenant agents on (off by default)
 *
 * An agent connects by signing in (OAuth): the user approves the client on
 * their panel's consent page, which creates a CONNECTION. The agent then holds
 * a 1-hour access token it renews with a refresh token; the connection ends 8
 * hours after approval, or as soon as it is revoked. Admins can also create a
 * personal access token (PAT) for scripts and agents on the admin API.
 *
 * Every token carries scopes, and every API call the agent makes is checked
 * against them:
 *
 *   read   — GET
 *   write  — POST / PUT / PATCH, and moving a tenant's file to the trash
 *   delete — DELETE, and anything permanent (emptying the trash, purges)
 *
 * Scopes only ever NARROW: an agent can do no more than its user's role
 * allows. On the admin side only the `admin` role may connect — not
 * super_admin (agents must not reach break-glass functions). On the tenant
 * side the agent acts as the tenant user who approved it, with that user's
 * role, inside that user's tenant only.
 */

export const MCP_SCOPES = ['read', 'write', 'delete'] as const;
export const mcpScopeSchema = z.enum(MCP_SCOPES);
export type McpScope = z.infer<typeof mcpScopeSchema>;

/** Which panel's MCP endpoint a connection belongs to. */
export const MCP_AUDIENCES = ['admin', 'tenant'] as const;
export const mcpAudienceSchema = z.enum(MCP_AUDIENCES);
export type McpAudience = z.infer<typeof mcpAudienceSchema>;

/** The admin-panel role allowed to own agent access. */
export const MCP_ALLOWED_ROLE = 'admin' as const;

/** An OAuth access token lives this long; the agent renews it with its refresh token. */
export const MCP_OAUTH_TOKEN_TTL_SECONDS = 3600;

/** A connection — and every token renewed under it — ends this long after approval. */
export const MCP_CONNECTION_MAX_SECONDS = 8 * 3600;

/** PAT expiry choices offered by the panel; `null` = never expires. */
export const MCP_PAT_EXPIRY_DAYS = [7, 30, 90, 180, 365] as const;

const scopeListSchema = z.array(mcpScopeSchema).min(1).max(3)
  .refine((s) => new Set(s).size === s.length, { message: 'scopes must not repeat' });

export const createMcpPatSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: scopeListSchema,
  /** Days until expiry; null = never. */
  expiresInDays: z.number().int().min(1).max(3650).nullable(),
}).strict();
export type CreateMcpPatInput = z.infer<typeof createMcpPatSchema>;

/** A personal access token as listed — never the secret. */
export const mcpTokenSchema = z.object({
  id: z.string(),
  kind: z.enum(['pat', 'oauth']),
  name: z.string(),
  scopes: z.array(mcpScopeSchema),
  /** First characters of the token, so a user can tell two apart. */
  prefix: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  /** OAuth tokens only: the client the user approved. */
  clientName: z.string().nullable(),
});
export type McpToken = z.infer<typeof mcpTokenSchema>;

/** Returned once, at creation. */
export const createdMcpPatSchema = mcpTokenSchema.extend({
  token: z.string(),
});
export type CreatedMcpPat = z.infer<typeof createdMcpPatSchema>;

/** A connected AI agent: one approval on a consent page, until it ends or is revoked. */
export const mcpConnectionSchema = z.object({
  id: z.string(),
  audience: mcpAudienceSchema,
  /** The name the client registered itself with. */
  clientName: z.string(),
  scopes: z.array(mcpScopeSchema),
  /** When it was approved. */
  createdAt: z.string(),
  /** When it ends on its own (8 hours after approval). */
  expiresAt: z.string(),
  /** Last time the agent used it (at most a minute stale). */
  lastUsedAt: z.string().nullable(),
  /** Who approved it — the user the agent acts as. */
  user: z.object({ id: z.string(), email: z.string(), fullName: z.string() }),
  /** Tenant connections only. */
  tenant: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type McpConnection = z.infer<typeof mcpConnectionSchema>;

/** User Settings → API tokens & AI agents (admin panel). */
export const mcpTokenListSchema = z.object({
  /** The caller's personal access tokens. */
  tokens: z.array(mcpTokenSchema),
  /** The caller's connected AI agents. */
  connections: z.array(mcpConnectionSchema),
  /** The URL to give an MCP client. */
  endpoint: z.string(),
  /** Whether the CALLER may create tokens / approve clients (role `admin`). */
  canUse: z.boolean(),
});
export type McpTokenList = z.infer<typeof mcpTokenListSchema>;

/** User Settings → AI agents (tenant panel). */
export const tenantMcpAgentsSchema = z.object({
  /** The URL to give an MCP client. */
  endpoint: z.string(),
  /** The operator's switch (off by default): false = tenant agents are off on this platform. */
  enabled: z.boolean(),
  /**
   * Whether the CALLER may approve an agent now. False while switched off and
   * in an impersonation session (staff use the admin MCP endpoint instead).
   */
  canConnect: z.boolean(),
  /**
   * `own` — the caller's own agents; `tenant` — every agent connected to the
   * tenant (tenant_admin), which the caller may also revoke.
   */
  view: z.enum(['own', 'tenant']),
  connections: z.array(mcpConnectionSchema),
});
export type TenantMcpAgents = z.infer<typeof tenantMcpAgentsSchema>;

/** Security → AI agents (admin panel): every connected agent on the platform. */
export const mcpPlatformConnectionsSchema = z.object({
  connections: z.array(mcpConnectionSchema),
  /** The operator's switch for tenant agents. */
  tenantAgentsEnabled: z.boolean(),
});
export type McpPlatformConnections = z.infer<typeof mcpPlatformConnectionsSchema>;

export const mcpAgentSettingsSchema = z.object({
  /**
   * Off (the default on a new or upgraded installation): tenant users cannot
   * connect agents, and switching off disconnects every connected tenant agent.
   */
  tenantAgentsEnabled: z.boolean(),
}).strict();
export type McpAgentSettings = z.infer<typeof mcpAgentSettingsSchema>;

/** A pending OAuth authorization, as the consent page shows it. */
export const mcpConsentRequestSchema = z.object({
  id: z.string(),
  clientName: z.string(),
  /** Which panel's API the agent asks for. */
  audience: mcpAudienceSchema,
  /** Where the browser goes after the decision — shown so the user can judge it. */
  redirectHost: z.string(),
  requestedScopes: z.array(mcpScopeSchema),
  expiresAt: z.string(),
  /** When the client registered itself — a minutes-old "Claude" deserves a second look. */
  clientRegisteredAt: z.string(),
  /**
   * Whether the signed-in user has approved this client before (recently —
   * a connection is kept a day after it ends). Per user on purpose: anyone can
   * register a client, so its author approving it must not silence the
   * warning for everyone else.
   */
  clientApprovedBefore: z.boolean(),
});
export type McpConsentRequest = z.infer<typeof mcpConsentRequestSchema>;

export const mcpConsentDecisionSchema = z.object({
  approve: z.boolean(),
  /** Must be a subset of the requested scopes. */
  scopes: z.array(mcpScopeSchema).max(3).default([]),
}).strict();
export type McpConsentDecision = z.infer<typeof mcpConsentDecisionSchema>;

export const mcpConsentResultSchema = z.object({
  redirectTo: z.string(),
});
export type McpConsentResult = z.infer<typeof mcpConsentResultSchema>;
