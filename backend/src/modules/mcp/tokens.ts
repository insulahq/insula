/**
 * Agent & automation tokens: personal access tokens (PATs) and OAuth access
 * tokens for MCP clients.
 *
 * Both are opaque random strings; only their SHA-256 is stored. A PAT works on
 * the whole REST API and on the MCP endpoint; an OAuth token was issued FOR
 * the MCP endpoint (RFC 8707 resource) and is accepted there only.
 *
 * A token never outranks its user: on every use the owner must still exist,
 * be active, and hold the one role agent access is granted to
 * (MCP_ALLOWED_ROLE). Demoting or disabling a user disables their tokens
 * within RESOLVE_CACHE_MS, without anyone having to revoke them.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  MCP_ALLOWED_ROLE, MCP_OAUTH_TOKEN_TTL_SECONDS, mcpScopeSchema,
  type McpScope, type McpToken,
} from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { mcpOauthClients, mcpOauthRequests, mcpTokens, users } from '../../db/schema.js';

export const PAT_PREFIX = 'insula_pat_';
export const OAUTH_TOKEN_PREFIX = 'insula_oat_';

export type TokenKind = 'pat' | 'oauth';

/** Who a bearer token acts as, once resolved. */
export interface TokenPrincipal {
  readonly tokenId: string;
  readonly kind: TokenKind;
  readonly name: string;
  readonly scopes: readonly McpScope[];
  readonly userId: string;
  readonly role: string;
  readonly resource: string | null;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** Shown in lists so two tokens can be told apart; never enough to use. */
function displayPrefix(secret: string): string {
  return secret.slice(0, 18);
}

export function looksLikeToken(bearer: string): TokenKind | null {
  if (bearer.startsWith(PAT_PREFIX)) return 'pat';
  if (bearer.startsWith(OAUTH_TOKEN_PREFIX)) return 'oauth';
  return null;
}

function parseScopes(raw: readonly string[]): McpScope[] {
  return raw.filter((s): s is McpScope => mcpScopeSchema.safeParse(s).success);
}

// ─── resolve (hot path) ─────────────────────────────────────────────────────

/**
 * Short cache of resolved tokens so an automation loop does not cost a DB
 * round trip per request. Bounded both ways: a revoked token or a demoted
 * user stops working within this window.
 */
const RESOLVE_CACHE_MS = 30_000;
const RESOLVE_CACHE_MAX = 500;
const resolveCache = new Map<string, { at: number; principal: TokenPrincipal | null }>();

/** When last_used_at was last written per token — at most once a minute. */
const touchedAt = new Map<string, number>();
const TOUCH_EVERY_MS = 60_000;

export function clearTokenCache(): void {
  resolveCache.clear();
  touchedAt.clear();
}

/** An entry older than TOUCH_EVERY_MS means the same as none, so drop those. */
function pruneTouched(now: number): void {
  if (touchedAt.size < RESOLVE_CACHE_MAX) return;
  for (const [tokenId, at] of touchedAt) {
    if (now - at > TOUCH_EVERY_MS) touchedAt.delete(tokenId);
  }
}

/**
 * Resolve a bearer secret to the principal it acts as, or null when it is
 * unknown, revoked, expired, or its owner may no longer hold agent access.
 */
export async function resolveToken(db: Database, secret: string, now: number = Date.now()): Promise<TokenPrincipal | null> {
  const hash = hashSecret(secret);
  const hit = resolveCache.get(hash);
  if (hit && now - hit.at < RESOLVE_CACHE_MS) return hit.principal;

  const rows = await db
    .select({
      id: mcpTokens.id, kind: mcpTokens.kind, name: mcpTokens.name, scopes: mcpTokens.scopes,
      expiresAt: mcpTokens.expiresAt, revokedAt: mcpTokens.revokedAt, resource: mcpTokens.resource,
      userId: users.id, role: users.roleName, status: users.status, panel: users.panel,
    })
    .from(mcpTokens)
    .innerJoin(users, eq(users.id, mcpTokens.userId))
    .where(eq(mcpTokens.tokenHash, hash))
    .limit(1);
  const row = rows[0];
  const usable = row
    && !row.revokedAt
    && (!row.expiresAt || row.expiresAt.getTime() > now)
    && row.status === 'active'
    && row.panel === 'admin'
    && row.role === MCP_ALLOWED_ROLE;
  const principal: TokenPrincipal | null = usable ? {
    tokenId: row.id,
    kind: row.kind === 'oauth' ? 'oauth' : 'pat',
    name: row.name,
    scopes: parseScopes(row.scopes),
    userId: row.userId,
    role: row.role,
    resource: row.resource,
  } : null;

  if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.clear();
  resolveCache.set(hash, { at: now, principal });

  if (principal && now - (touchedAt.get(principal.tokenId) ?? 0) > TOUCH_EVERY_MS) {
    pruneTouched(now);
    touchedAt.set(principal.tokenId, now);
    void db.update(mcpTokens).set({ lastUsedAt: new Date(now) }).where(eq(mcpTokens.id, principal.tokenId))
      .catch(() => { /* bookkeeping only */ });
  }
  return principal;
}

// ─── PATs ───────────────────────────────────────────────────────────────────

export async function createPat(db: Database, input: {
  userId: string; name: string; scopes: readonly McpScope[]; expiresInDays: number | null;
}, now: Date = new Date()): Promise<{ token: string; row: McpToken }> {
  const secret = newSecret(PAT_PREFIX);
  const id = randomUUID();
  const expiresAt = input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000);
  await db.insert(mcpTokens).values({
    id, kind: 'pat', tokenHash: hashSecret(secret), prefix: displayPrefix(secret),
    userId: input.userId, name: input.name, scopes: [...input.scopes], expiresAt, createdAt: now,
  });
  return {
    token: secret,
    row: {
      id, kind: 'pat', name: input.name, scopes: [...input.scopes], prefix: displayPrefix(secret),
      createdAt: now.toISOString(), expiresAt: expiresAt?.toISOString() ?? null, lastUsedAt: null, clientName: null,
    },
  };
}

/** A user's live tokens (not revoked, not expired), newest first. */
export async function listTokens(db: Database, userId: string, now: Date = new Date()): Promise<McpToken[]> {
  const rows = await db
    .select({
      id: mcpTokens.id, kind: mcpTokens.kind, name: mcpTokens.name, scopes: mcpTokens.scopes,
      prefix: mcpTokens.prefix, createdAt: mcpTokens.createdAt, expiresAt: mcpTokens.expiresAt,
      lastUsedAt: mcpTokens.lastUsedAt, clientName: mcpOauthClients.name,
    })
    .from(mcpTokens)
    .leftJoin(mcpOauthClients, eq(mcpOauthClients.id, mcpTokens.clientId))
    .where(and(
      eq(mcpTokens.userId, userId),
      isNull(mcpTokens.revokedAt),
      or(isNull(mcpTokens.expiresAt), sql`${mcpTokens.expiresAt} > ${now}`),
    ))
    .orderBy(sql`${mcpTokens.createdAt} DESC`);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind === 'oauth' ? 'oauth' : 'pat',
    name: r.name,
    scopes: parseScopes(r.scopes),
    prefix: r.prefix,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    clientName: r.clientName ?? null,
  }));
}

/** Revoke one of the user's own tokens. True when something was revoked. */
export async function revokeToken(db: Database, userId: string, tokenId: string): Promise<boolean> {
  const res = await db.update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId), isNull(mcpTokens.revokedAt)))
    .returning({ id: mcpTokens.id });
  if (res.length > 0) clearTokenCache();
  return res.length > 0;
}

// ─── OAuth access tokens ────────────────────────────────────────────────────

export async function issueOauthToken(db: Database, input: {
  userId: string; clientId: string; clientName: string; scopes: readonly McpScope[]; resource: string;
}, now: Date = new Date()): Promise<{ token: string; expiresIn: number }> {
  const secret = newSecret(OAUTH_TOKEN_PREFIX);
  await db.insert(mcpTokens).values({
    id: randomUUID(), kind: 'oauth', tokenHash: hashSecret(secret), prefix: displayPrefix(secret),
    userId: input.userId, clientId: input.clientId, name: input.clientName, scopes: [...input.scopes],
    resource: input.resource, expiresAt: new Date(now.getTime() + MCP_OAUTH_TOKEN_TTL_SECONDS * 1000), createdAt: now,
  });
  return { token: secret, expiresIn: MCP_OAUTH_TOKEN_TTL_SECONDS };
}

/**
 * Delete what can never be used again: expired OAuth tokens, revoked or
 * expired PATs older than a day (kept a little so a list refresh does not
 * race the deletion), and finished or abandoned authorization requests.
 */
/** A registered client nobody ever approved is gone after a day… */
const CLIENT_UNAPPROVED_TTL_MS = 86_400_000;
/** …and one that was approved, after a month without a sign-in. */
const CLIENT_IDLE_TTL_MS = 30 * 86_400_000;

/**
 * No token or parked request still names the client (both cascade on delete).
 * Built per call: tables read at import time break every test that mocks the schema.
 */
const clientUnreferenced = () => sql`NOT EXISTS (SELECT 1 FROM ${mcpTokens} WHERE ${mcpTokens.clientId} = ${mcpOauthClients.id})
  AND NOT EXISTS (SELECT 1 FROM ${mcpOauthRequests} WHERE ${mcpOauthRequests.clientId} = ${mcpOauthClients.id})`;

export async function reapExpired(
  db: Database,
  now: Date = new Date(),
): Promise<{ tokens: number; requests: number; clients: number }> {
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const tokens = await db.delete(mcpTokens).where(or(
    and(eq(mcpTokens.kind, 'oauth'), lt(mcpTokens.expiresAt, now)),
    lt(mcpTokens.revokedAt, dayAgo),
    and(eq(mcpTokens.kind, 'pat'), lt(mcpTokens.expiresAt, dayAgo)),
  )).returning({ id: mcpTokens.id });
  const requests = await db.delete(mcpOauthRequests).where(lt(mcpOauthRequests.expiresAt, now))
    .returning({ id: mcpOauthRequests.id });
  // After tokens and requests, so a client whose last token just expired can go.
  const clients = await db.delete(mcpOauthClients).where(and(
    or(
      and(isNull(mcpOauthClients.lastUsedAt), lt(mcpOauthClients.createdAt, new Date(now.getTime() - CLIENT_UNAPPROVED_TTL_MS))),
      lt(mcpOauthClients.lastUsedAt, new Date(now.getTime() - CLIENT_IDLE_TTL_MS)),
    ),
    clientUnreferenced(),
  )).returning({ id: mcpOauthClients.id });
  if (tokens.length > 0) clearTokenCache();
  return { tokens: tokens.length, requests: requests.length, clients: clients.length };
}

/**
 * Make room for one registration when the table is full: drop the oldest
 * client that was never approved and holds no token (a pending request of
 * its own goes with it). Registration is open, so without this anyone could
 * fill the table and lock every real client out until the reaper ran.
 * Returns false when every client is in use.
 */
export async function evictUnapprovedClient(db: Database): Promise<boolean> {
  const [oldest] = await db.select({ id: mcpOauthClients.id }).from(mcpOauthClients)
    .where(and(
      isNull(mcpOauthClients.lastUsedAt),
      sql`NOT EXISTS (SELECT 1 FROM ${mcpTokens} WHERE ${mcpTokens.clientId} = ${mcpOauthClients.id})`,
    ))
    .orderBy(mcpOauthClients.createdAt)
    .limit(1);
  if (!oldest) return false;
  await db.delete(mcpOauthClients).where(eq(mcpOauthClients.id, oldest.id));
  return true;
}
