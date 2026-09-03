/**
 * Scoped certificate-download tokens.
 *
 * The whole point of this credential is that it works where a session JWT
 * cannot: an unattended web server or deploy pipeline fetching its own renewed
 * certificate, on a platform that may be configured for OIDC-only sign-in.
 * Verification therefore goes DB row → domain, and never touches the JWT path.
 *
 * Threat model for a leaked token, and what bounds it:
 *   - bound to one domain      → cannot read any other domain's certificate
 *   - bound to one tenant      → cannot cross a tenant boundary
 *   - read-only, one route     → cannot mutate anything or reach the panel
 *   - revocable instantly      → a row update kills it, unlike a JWT
 *   - optional expiry          → the panel defaults to 90d, matching LE renewal
 */

import crypto from 'crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { certDownloadTokens, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type {
  CertToken,
  CertTokenExpiry,
  CreateCertTokenInput,
  CreateCertTokenResponse,
} from '@insula/api-contracts';

/**
 * Recognisable prefix so a leaked token is greppable in logs and matchable by
 * secret scanners, followed by 256 bits of randomness. The prefix is not a
 * secret and is deliberately not counted as entropy.
 */
const TOKEN_PREFIX = 'insula_cert_';
const TOKEN_BYTES = 32;

/** Max tokens per domain. Bounds the table and the blast radius of a compromised panel session. */
export const MAX_TOKENS_PER_DOMAIN = 20;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function mintToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

function expiryToDate(expiry: CertTokenExpiry, now: Date): Date | null {
  const days = expiry === '30d' ? 30 : expiry === '90d' ? 90 : expiry === '1y' ? 365 : null;
  return days === null ? null : new Date(now.getTime() + days * 24 * 3600 * 1000);
}

function toDto(row: typeof certDownloadTokens.$inferSelect, now: Date): CertToken {
  return {
    id: row.id,
    domainId: row.domainId,
    name: row.name,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime(),
  };
}

export async function listTokens(
  db: Database,
  tenantId: string,
  domainId: string,
): Promise<CertToken[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(certDownloadTokens)
    .where(and(
      eq(certDownloadTokens.tenantId, tenantId),
      eq(certDownloadTokens.domainId, domainId),
      // Revoked tokens are deleted, not tombstoned — a revoked credential in a
      // list is just noise, and the audit trail records the revocation.
      isNull(certDownloadTokens.revokedAt),
    ))
    .orderBy(desc(certDownloadTokens.createdAt));
  return rows.map((r) => toDto(r, now));
}

export async function createToken(
  db: Database,
  tenantId: string,
  domainId: string,
  input: CreateCertTokenInput,
  createdBy: string | null,
): Promise<CreateCertTokenResponse> {
  // The domain must exist AND belong to this tenant. Without this a
  // tenant_admin could mint a token against another tenant's domain id.
  const [domain] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)))
    .limit(1);
  if (!domain) {
    throw new ApiError('DOMAIN_NOT_FOUND', `Domain '${domainId}' not found for this tenant`, 404);
  }

  const existing = await listTokens(db, tenantId, domainId);
  if (existing.length >= MAX_TOKENS_PER_DOMAIN) {
    throw new ApiError(
      'CERT_TOKEN_LIMIT_REACHED',
      `A domain can have at most ${MAX_TOKENS_PER_DOMAIN} certificate tokens. Revoke one you no longer use.`,
      409,
    );
  }

  const now = new Date();
  const token = mintToken();
  const id = crypto.randomUUID();

  await db.insert(certDownloadTokens).values({
    id,
    tenantId,
    domainId,
    name: input.name,
    tokenHash: hashToken(token),
    expiresAt: expiryToDate(input.expiry, now),
    createdBy,
    createdAt: now,
  });

  const [row] = await db
    .select().from(certDownloadTokens).where(eq(certDownloadTokens.id, id)).limit(1);

  // The only time the plaintext leaves this function. Nothing persists it.
  return { ...toDto(row, now), token };
}

export async function revokeToken(
  db: Database,
  tenantId: string,
  domainId: string,
  tokenId: string,
): Promise<void> {
  const deleted = await db
    .delete(certDownloadTokens)
    .where(and(
      eq(certDownloadTokens.id, tokenId),
      eq(certDownloadTokens.tenantId, tenantId),
      eq(certDownloadTokens.domainId, domainId),
    ))
    .returning({ id: certDownloadTokens.id });
  if (deleted.length === 0) {
    throw new ApiError('CERT_TOKEN_NOT_FOUND', `Certificate token '${tokenId}' not found`, 404);
  }
}

export interface VerifiedToken {
  readonly tokenId: string;
  readonly tenantId: string;
  readonly domainId: string;
  readonly name: string;
}

/**
 * Verify a presented token.
 *
 * Returns null for every failure mode — absent, malformed, unknown, revoked,
 * expired — so the route emits one indistinguishable 401 and the caller learns
 * nothing about which tokens exist.
 *
 * The lookup is by sha256 against a UNIQUE index, so there is no secret
 * comparison to make constant-time: the server compares a hash of the
 * presented value, and an index probe reveals nothing about a 256-bit random
 * preimage. Same construction as refresh_tokens.
 */
export async function verifyToken(
  db: Database,
  presented: string | undefined,
  now: Date = new Date(),
): Promise<VerifiedToken | null> {
  if (!presented || !presented.startsWith(TOKEN_PREFIX)) return null;

  const [row] = await db
    .select()
    .from(certDownloadTokens)
    .where(eq(certDownloadTokens.tokenHash, hashToken(presented)))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;

  return {
    tokenId: row.id,
    tenantId: row.tenantId,
    domainId: row.domainId,
    name: row.name,
  };
}

/**
 * Record a successful use. Best-effort: a failed bookkeeping write must never
 * fail the download the customer's deploy pipeline is waiting on.
 */
export async function touchToken(db: Database, tokenId: string): Promise<void> {
  try {
    await db
      .update(certDownloadTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(certDownloadTokens.id, tokenId));
  } catch {
    // ignore
  }
}

/** Exported for tests — never call this to validate a presented token. */
export const __testing = { hashToken, mintToken, TOKEN_PREFIX };
