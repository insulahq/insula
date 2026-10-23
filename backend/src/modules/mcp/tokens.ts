/**
 * Agent & automation credentials: personal access tokens (PATs), and the
 * CONNECTIONS an AI client gets by signing in (OAuth) with their access and
 * refresh tokens.
 *
 * All are opaque random strings; only their SHA-256 is stored. A PAT belongs
 * to an admin and works on the whole REST API and on the admin MCP endpoint.
 * A connection belongs to the admin or the tenant MCP endpoint (its audience)
 * and lasts at most MCP_CONNECTION_MAX_SECONDS; the agent holds a 1-hour access
 * token issued FOR that endpoint (RFC 8707 resource) and renews it with a
 * refresh token that is replaced on every use.
 *
 * A credential never outranks its user: on every use the owner must still
 * exist and be active — an admin connection or PAT needs the one role agent
 * access is granted to (MCP_ALLOWED_ROLE), a tenant connection needs its user
 * still in the tenant it was approved for and tenant agents still switched on.
 * Demoting or disabling a user, or revoking a connection, disables its tokens
 * within RESOLVE_CACHE_MS without anyone having to find them.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, gt, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import {
  MCP_ALLOWED_ROLE, MCP_CONNECTION_MAX_SECONDS, MCP_OAUTH_TOKEN_TTL_SECONDS, mcpScopeSchema,
  type McpAudience, type McpConnection, type McpScope, type McpToken,
} from '@insula/api-contracts';
import type { Database } from '../../db/index.js';
import { mcpConnections, mcpOauthClients, mcpOauthRequests, mcpTokens, tenants, users } from '../../db/schema.js';
import { tenantAgentsEnabled } from './settings.js';

export const PAT_PREFIX = 'insula_pat_';
export const OAUTH_TOKEN_PREFIX = 'insula_oat_';
export const REFRESH_TOKEN_PREFIX = 'insula_ort_';

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
  /** The MCP endpoint (panel) the token was issued for; a PAT is always 'admin'. */
  readonly audience: McpAudience;
  /** Tenant connections: the tenant the agent acts in. */
  readonly tenantId: string | null;
  readonly connectionId: string | null;
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
/** `until`: the token's (or its connection's) end — a cached principal never outlives it. */
const resolveCache = new Map<string, { at: number; until: number; principal: TokenPrincipal | null }>();

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

interface ResolvedRow {
  readonly kind: string;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly status: string;
  readonly panel: string;
  readonly role: string;
  readonly userTenantId: string | null;
  readonly connectionId: string | null;
  readonly connectionAudience: string | null;
  readonly connectionTenantId: string | null;
  readonly connectionExpiresAt: Date | null;
  readonly connectionRevokedAt: Date | null;
}

/** The audience a token row may act for, or null when it may not act at all. */
async function usableAudience(db: Database, row: ResolvedRow, now: number): Promise<McpAudience | null> {
  if (row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= now) || row.status !== 'active') return null;
  const adminOk = row.panel === 'admin' && row.role === MCP_ALLOWED_ROLE;
  if (row.kind === 'pat') return adminOk ? 'admin' : null;
  // An OAuth token is only as alive as the connection it was issued under.
  if (!row.connectionId || row.connectionRevokedAt
    || !row.connectionExpiresAt || row.connectionExpiresAt.getTime() <= now) return null;
  if (row.connectionAudience === 'admin') return adminOk ? 'admin' : null;
  if (row.connectionAudience === 'tenant') {
    const sameTenant = row.panel === 'tenant' && row.userTenantId !== null && row.userTenantId === row.connectionTenantId;
    return sameTenant && await tenantAgentsEnabled(db, now) ? 'tenant' : null;
  }
  return null;
}

/**
 * Resolve a bearer secret to the principal it acts as, or null when it is
 * unknown, revoked, expired, or its owner may no longer hold agent access.
 */
export async function resolveToken(db: Database, secret: string, now: number = Date.now()): Promise<TokenPrincipal | null> {
  const hash = hashSecret(secret);
  const hit = resolveCache.get(hash);
  if (hit && now - hit.at < RESOLVE_CACHE_MS && now < hit.until) return hit.principal;

  const rows = await db
    .select({
      id: mcpTokens.id, kind: mcpTokens.kind, name: mcpTokens.name, scopes: mcpTokens.scopes,
      expiresAt: mcpTokens.expiresAt, revokedAt: mcpTokens.revokedAt, resource: mcpTokens.resource,
      userId: users.id, role: users.roleName, status: users.status, panel: users.panel, userTenantId: users.tenantId,
      connectionId: mcpConnections.id, connectionAudience: mcpConnections.audience,
      connectionTenantId: mcpConnections.tenantId, connectionExpiresAt: mcpConnections.expiresAt,
      connectionRevokedAt: mcpConnections.revokedAt,
    })
    .from(mcpTokens)
    .innerJoin(users, eq(users.id, mcpTokens.userId))
    .leftJoin(mcpConnections, eq(mcpConnections.id, mcpTokens.connectionId))
    .where(eq(mcpTokens.tokenHash, hash))
    .limit(1);
  const row = rows[0];
  const audience = row ? await usableAudience(db, row, now) : null;
  const principal: TokenPrincipal | null = row && audience ? {
    tokenId: row.id,
    kind: row.kind === 'oauth' ? 'oauth' : 'pat',
    name: row.name,
    scopes: parseScopes(row.scopes),
    userId: row.userId,
    role: row.role,
    resource: row.resource,
    audience,
    tenantId: audience === 'tenant' ? row.connectionTenantId : null,
    connectionId: row.connectionId,
  } : null;

  const ends = [row?.expiresAt, row?.connectionExpiresAt].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.clear();
  resolveCache.set(hash, { at: now, until: ends.length > 0 ? Math.min(...ends) : Number.POSITIVE_INFINITY, principal });

  if (principal && now - (touchedAt.get(principal.tokenId) ?? 0) > TOUCH_EVERY_MS) {
    pruneTouched(now);
    touchedAt.set(principal.tokenId, now);
    const at = new Date(now);
    void db.update(mcpTokens).set({ lastUsedAt: at }).where(eq(mcpTokens.id, principal.tokenId))
      .catch(() => { /* bookkeeping only */ });
    if (principal.connectionId) {
      void db.update(mcpConnections).set({ lastUsedAt: at }).where(eq(mcpConnections.id, principal.connectionId))
        .catch(() => { /* bookkeeping only */ });
    }
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

/** A user's live personal access tokens (not revoked, not expired), newest first. */
export async function listTokens(db: Database, userId: string, now: Date = new Date()): Promise<McpToken[]> {
  const rows = await db
    .select({
      id: mcpTokens.id, name: mcpTokens.name, scopes: mcpTokens.scopes, prefix: mcpTokens.prefix,
      createdAt: mcpTokens.createdAt, expiresAt: mcpTokens.expiresAt, lastUsedAt: mcpTokens.lastUsedAt,
    })
    .from(mcpTokens)
    .where(and(
      eq(mcpTokens.userId, userId),
      eq(mcpTokens.kind, 'pat'),
      isNull(mcpTokens.revokedAt),
      or(isNull(mcpTokens.expiresAt), sql`${mcpTokens.expiresAt} > ${now}`),
    ))
    .orderBy(sql`${mcpTokens.createdAt} DESC`);
  return rows.map((r) => ({
    id: r.id,
    kind: 'pat' as const,
    name: r.name,
    scopes: parseScopes(r.scopes),
    prefix: r.prefix,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt?.toISOString() ?? null,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    clientName: null,
  }));
}

/** Revoke one of the user's own PATs. True when something was revoked. */
export async function revokeToken(db: Database, userId: string, tokenId: string): Promise<boolean> {
  const res = await db.update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, tokenId), eq(mcpTokens.userId, userId), eq(mcpTokens.kind, 'pat'), isNull(mcpTokens.revokedAt)))
    .returning({ id: mcpTokens.id });
  if (res.length > 0) clearTokenCache();
  return res.length > 0;
}

// ─── connections (OAuth) ────────────────────────────────────────────────────

export interface IssuedAccess {
  readonly token: string;
  readonly expiresIn: number;
}

export interface IssuedConnection {
  readonly connectionId: string;
  readonly access: IssuedAccess;
  readonly refreshToken: string;
}

interface ConnectionForIssue {
  readonly id: string;
  readonly userId: string;
  readonly clientId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly expiresAt: Date;
}

/** A 1-hour access token under `connection`, never outliving it. */
async function issueAccessToken(db: Pick<Database, 'insert'>, connection: ConnectionForIssue, now: Date): Promise<IssuedAccess> {
  const secret = newSecret(OAUTH_TOKEN_PREFIX);
  const expiresAt = new Date(Math.min(now.getTime() + MCP_OAUTH_TOKEN_TTL_SECONDS * 1000, connection.expiresAt.getTime()));
  await db.insert(mcpTokens).values({
    id: randomUUID(), kind: 'oauth', tokenHash: hashSecret(secret), prefix: displayPrefix(secret),
    userId: connection.userId, clientId: connection.clientId, connectionId: connection.id,
    name: connection.name, scopes: [...connection.scopes], resource: connection.resource, expiresAt, createdAt: now,
  });
  return { token: secret, expiresIn: Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)) };
}

/** A consent-page approval redeemed: the connection, its first access token and its refresh token. */
export async function createConnection(db: Database, input: {
  userId: string; tenantId: string | null; clientId: string; clientName: string;
  audience: McpAudience; scopes: readonly McpScope[]; resource: string;
}, now: Date = new Date()): Promise<IssuedConnection> {
  const refreshToken = newSecret(REFRESH_TOKEN_PREFIX);
  const connection: ConnectionForIssue = {
    id: randomUUID(), userId: input.userId, clientId: input.clientId, name: input.clientName,
    scopes: [...input.scopes], resource: input.resource,
    expiresAt: new Date(now.getTime() + MCP_CONNECTION_MAX_SECONDS * 1000),
  };
  await db.insert(mcpConnections).values({
    ...connection, scopes: [...connection.scopes], tenantId: input.audience === 'tenant' ? input.tenantId : null,
    audience: input.audience, refreshTokenHash: hashSecret(refreshToken), lastUsedAt: now, createdAt: now,
  });
  const access = await issueAccessToken(db, connection, now);
  return { connectionId: connection.id, access, refreshToken };
}

export type RefreshResult =
  | { readonly ok: true; readonly issued: IssuedConnection; readonly scopes: readonly McpScope[]; readonly resource: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Trade a refresh token for a new access token AND a new refresh token
 * (rotation). The old refresh token is spent; presenting it again means two
 * parties hold this connection, so it is revoked outright (RFC 9700 §4.14.2).
 */
export async function refreshConnection(
  db: Database, refreshToken: string, clientId: string, now: Date = new Date(),
): Promise<RefreshResult> {
  const hash = hashSecret(refreshToken);
  const [conn] = await db.select().from(mcpConnections).where(eq(mcpConnections.refreshTokenHash, hash)).limit(1);
  if (!conn) {
    const replayed = await db.update(mcpConnections).set({ revokedAt: now })
      .where(and(eq(mcpConnections.previousRefreshHash, hash), isNull(mcpConnections.revokedAt)))
      .returning({ id: mcpConnections.id });
    if (replayed.length > 0) {
      clearTokenCache();
      return { ok: false, reason: 'refresh token was already used — the connection is revoked' };
    }
    return { ok: false, reason: 'invalid refresh token' };
  }
  if (conn.clientId !== clientId) return { ok: false, reason: 'refresh token was issued to another client' };
  if (conn.revokedAt) return { ok: false, reason: 'the connection was revoked' };
  if (conn.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'the connection has ended — sign in again' };

  const next = newSecret(REFRESH_TOKEN_PREFIX);
  // One transaction: the swap and the new access token land together, so a
  // failure between them cannot spend the old refresh token without handing
  // out a new one (the client's retry would then read as a replay).
  const access = await db.transaction(async (tx) => {
    // Compare-and-swap on the current hash: of two concurrent refreshes, one wins.
    const swapped = await tx.update(mcpConnections)
      .set({ refreshTokenHash: hashSecret(next), previousRefreshHash: hash, lastUsedAt: now })
      .where(and(eq(mcpConnections.id, conn.id), eq(mcpConnections.refreshTokenHash, hash), isNull(mcpConnections.revokedAt)))
      .returning({ id: mcpConnections.id });
    if (swapped.length === 0) return null;
    return issueAccessToken(tx, conn, now);
  });
  if (!access) return { ok: false, reason: 'invalid refresh token' };
  return {
    ok: true,
    issued: { connectionId: conn.id, access, refreshToken: next },
    scopes: parseScopes(conn.scopes),
    resource: conn.resource,
  };
}

/** Who may see / revoke which connections. */
export type ConnectionFilter =
  | { readonly userId: string }
  | { readonly tenantId: string }
  | { readonly all: true };

function filterSql(filter: ConnectionFilter): SQL | undefined {
  if ('userId' in filter) return eq(mcpConnections.userId, filter.userId);
  if ('tenantId' in filter) return and(eq(mcpConnections.audience, 'tenant'), eq(mcpConnections.tenantId, filter.tenantId));
  return undefined;
}

/** Live connections (not revoked, not ended) the filter allows, newest first. */
export async function listConnections(
  db: Database, filter: ConnectionFilter, now: Date = new Date(),
): Promise<McpConnection[]> {
  const rows = await db
    .select({
      id: mcpConnections.id, audience: mcpConnections.audience, name: mcpConnections.name,
      scopes: mcpConnections.scopes, createdAt: mcpConnections.createdAt, expiresAt: mcpConnections.expiresAt,
      lastUsedAt: mcpConnections.lastUsedAt,
      userId: users.id, email: users.email, fullName: users.fullName,
      tenantId: tenants.id, tenantName: tenants.name,
    })
    .from(mcpConnections)
    .innerJoin(users, eq(users.id, mcpConnections.userId))
    .leftJoin(tenants, eq(tenants.id, mcpConnections.tenantId))
    .where(and(filterSql(filter), isNull(mcpConnections.revokedAt), gt(mcpConnections.expiresAt, now)))
    .orderBy(sql`${mcpConnections.createdAt} DESC`);
  return rows.map((r) => ({
    id: r.id,
    audience: r.audience === 'tenant' ? 'tenant' as const : 'admin' as const,
    clientName: r.name,
    scopes: parseScopes(r.scopes),
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    user: { id: r.userId, email: r.email, fullName: r.fullName },
    tenant: r.tenantId && r.tenantName ? { id: r.tenantId, name: r.tenantName } : null,
  }));
}

/** Revoke one live connection the filter allows. True when something was revoked. */
export async function revokeConnection(
  db: Database, connectionId: string, filter: ConnectionFilter, now: Date = new Date(),
): Promise<boolean> {
  const res = await db.update(mcpConnections).set({ revokedAt: now })
    .where(and(eq(mcpConnections.id, connectionId), filterSql(filter), isNull(mcpConnections.revokedAt)))
    .returning({ id: mcpConnections.id });
  if (res.length > 0) clearTokenCache();
  return res.length > 0;
}

/** Disconnect every tenant agent (the operator switched tenant agents off). */
export async function revokeTenantConnections(db: Database, now: Date = new Date()): Promise<number> {
  const res = await db.update(mcpConnections).set({ revokedAt: now })
    .where(and(eq(mcpConnections.audience, 'tenant'), isNull(mcpConnections.revokedAt)))
    .returning({ id: mcpConnections.id });
  clearTokenCache();
  return res.length;
}

/**
 * RFC 7009 revocation by the client: an access token or a refresh token ends
 * the whole connection it belongs to.
 */
export async function revokeByClientToken(db: Database, token: string, now: Date = new Date()): Promise<void> {
  const hash = hashSecret(token);
  const [byRefresh] = await db.select({ id: mcpConnections.id }).from(mcpConnections)
    .where(eq(mcpConnections.refreshTokenHash, hash)).limit(1);
  const [byAccess] = byRefresh ? [] : await db.select({ id: mcpTokens.connectionId }).from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hash), eq(mcpTokens.kind, 'oauth'), isNotNull(mcpTokens.connectionId))).limit(1);
  const connectionId = byRefresh?.id ?? byAccess?.id ?? null;
  if (connectionId) await revokeConnection(db, connectionId, { all: true }, now);
}

// ─── housekeeping ───────────────────────────────────────────────────────────

/** A registered client nobody ever approved is gone after a day… */
const CLIENT_UNAPPROVED_TTL_MS = 86_400_000;
/** …and one that was approved, after a month without a sign-in. */
const CLIENT_IDLE_TTL_MS = 30 * 86_400_000;

/**
 * No connection, token or parked request still names the client (all cascade
 * on delete). Built per call: tables read at import time break every test that
 * mocks the schema.
 */
const clientUnreferenced = () => sql`NOT EXISTS (SELECT 1 FROM ${mcpTokens} WHERE ${mcpTokens.clientId} = ${mcpOauthClients.id})
  AND NOT EXISTS (SELECT 1 FROM ${mcpConnections} WHERE ${mcpConnections.clientId} = ${mcpOauthClients.id})
  AND NOT EXISTS (SELECT 1 FROM ${mcpOauthRequests} WHERE ${mcpOauthRequests.clientId} = ${mcpOauthClients.id})`;

/**
 * Delete what can never be used again: expired access tokens, connections that
 * ended or were revoked more than a day ago (their tokens cascade), revoked or
 * expired PATs older than a day (kept a little so a list refresh does not race
 * the deletion), and finished or abandoned authorization requests.
 */
export async function reapExpired(
  db: Database,
  now: Date = new Date(),
): Promise<{ tokens: number; connections: number; requests: number; clients: number }> {
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const connections = await db.delete(mcpConnections).where(or(
    lt(mcpConnections.expiresAt, dayAgo),
    lt(mcpConnections.revokedAt, dayAgo),
  )).returning({ id: mcpConnections.id });
  const tokens = await db.delete(mcpTokens).where(or(
    and(eq(mcpTokens.kind, 'oauth'), lt(mcpTokens.expiresAt, now)),
    lt(mcpTokens.revokedAt, dayAgo),
    and(eq(mcpTokens.kind, 'pat'), lt(mcpTokens.expiresAt, dayAgo)),
  )).returning({ id: mcpTokens.id });
  const requests = await db.delete(mcpOauthRequests).where(lt(mcpOauthRequests.expiresAt, now))
    .returning({ id: mcpOauthRequests.id });
  // After the rest, so a client whose last connection just went can go too.
  const clients = await db.delete(mcpOauthClients).where(and(
    or(
      and(isNull(mcpOauthClients.lastUsedAt), lt(mcpOauthClients.createdAt, new Date(now.getTime() - CLIENT_UNAPPROVED_TTL_MS))),
      lt(mcpOauthClients.lastUsedAt, new Date(now.getTime() - CLIENT_IDLE_TTL_MS)),
    ),
    clientUnreferenced(),
  )).returning({ id: mcpOauthClients.id });
  if (tokens.length > 0 || connections.length > 0) clearTokenCache();
  return { tokens: tokens.length, connections: connections.length, requests: requests.length, clients: clients.length };
}

/**
 * Make room for one registration when the table is full: drop the oldest
 * client that was never approved and holds no token. Registration is open, so
 * without this anyone could fill the table and lock every real client out
 * until the reaper ran. A client whose request a person has ANSWERED (code
 * issued, not yet redeemed) is spared — an unanswered request is not, since
 * `/authorize` is unauthenticated and would let a flood pin its own clients.
 * Returns false when every client is in use.
 */
export async function evictUnapprovedClient(db: Database): Promise<boolean> {
  const [oldest] = await db.select({ id: mcpOauthClients.id }).from(mcpOauthClients)
    .where(and(
      isNull(mcpOauthClients.lastUsedAt),
      sql`NOT EXISTS (SELECT 1 FROM ${mcpTokens} WHERE ${mcpTokens.clientId} = ${mcpOauthClients.id})`,
      sql`NOT EXISTS (SELECT 1 FROM ${mcpConnections} WHERE ${mcpConnections.clientId} = ${mcpOauthClients.id})`,
      sql`NOT EXISTS (SELECT 1 FROM ${mcpOauthRequests} WHERE ${mcpOauthRequests.clientId} = ${mcpOauthClients.id}
        AND ${mcpOauthRequests.userId} IS NOT NULL)`,
    ))
    .orderBy(mcpOauthClients.createdAt)
    .limit(1);
  if (!oldest) return false;
  await db.delete(mcpOauthClients).where(eq(mcpOauthClients.id, oldest.id));
  return true;
}
