import { z } from 'zod';

/**
 * AI agents (MCP) — access for agents acting on the platform's API.
 *
 * An agent connects to the admin panel's MCP endpoint with a bearer token:
 * either an OAuth access token (8 hours, no refresh — the user approves the
 * client on a consent page) or a personal access token (PAT) the user created.
 * Either kind carries scopes, and every API call the agent makes is checked
 * against them:
 *
 *   read   — GET
 *   write  — POST / PUT / PATCH, and moving a tenant's file to the trash
 *   delete — DELETE, and anything permanent (emptying the trash, purges)
 *
 * Scopes only ever NARROW: a token can do no more than its user's role
 * allows. Only users with the `admin` role may hold one — not super_admin
 * (agents must not reach break-glass functions), not tenant users.
 */

export const MCP_SCOPES = ['read', 'write', 'delete'] as const;
export const mcpScopeSchema = z.enum(MCP_SCOPES);
export type McpScope = z.infer<typeof mcpScopeSchema>;

/** The role allowed to own agent access. */
export const MCP_ALLOWED_ROLE = 'admin' as const;

/** OAuth access tokens live this long and are not refreshable. */
export const MCP_OAUTH_TOKEN_TTL_SECONDS = 8 * 3600;

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

/** A token as listed — never the secret. */
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

export const mcpTokenListSchema = z.object({
  tokens: z.array(mcpTokenSchema),
  /** The URL to give an MCP client. */
  endpoint: z.string(),
  /** Whether the CALLER may create tokens / approve clients (role `admin`). */
  canUse: z.boolean(),
});
export type McpTokenList = z.infer<typeof mcpTokenListSchema>;

/** A pending OAuth authorization, as the consent page shows it. */
export const mcpConsentRequestSchema = z.object({
  id: z.string(),
  clientName: z.string(),
  /** Where the browser goes after the decision — shown so the user can judge it. */
  redirectHost: z.string(),
  requestedScopes: z.array(mcpScopeSchema),
  expiresAt: z.string(),
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
