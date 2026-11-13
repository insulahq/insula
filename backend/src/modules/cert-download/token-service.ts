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
 *   - revocable instantly      → deleting the row kills it, unlike a JWT
 *   - temporary                → 15 minutes to 24 hours (default 1 hour),
 *                                checked on every use against the row's own
 *                                creation time, and reaped once expired
 *                                (reapExpiredTokens). Unattended pickup of a
 *                                renewed certificate uses an API token on the
 *                                panel's download route instead.
 */

import crypto from 'crypto';
import { and, count, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { certDownloadTokens, domains } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import {
  CERT_TOKEN_MAX_LIFETIME_MS,
  type CertToken,
  type CertTokenExpiry,
  type CreateCertTokenInput,
  type CreateCertTokenResponse,
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

const LIFETIME_MS: Record<CertTokenExpiry, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

function expiryToDate(expiry: CertTokenExpiry, now: Date): Date {
  return new Date(now.getTime() + Math.min(LIFETIME_MS[expiry], CERT_TOKEN_MAX_LIFETIME_MS));
}

/**
 * Whether a row is a link the current rules allow at all: it expires, and no
 * later than 24 hours after it was made. A row minted under the old rules (no
 * expiry, or a year) by a pod still running the old code during the rollout
 * is refused, and the reaper deletes it.
 */
function withinRules(row: typeof certDownloadTokens.$inferSelect): row is typeof certDownloadTokens.$inferSelect & { expiresAt: Date } {
  return row.expiresAt !== null
    && row.expiresAt.getTime() - row.createdAt.getTime() <= CERT_TOKEN_MAX_LIFETIME_MS;
}

function toDto(row: typeof certDownloadTokens.$inferSelect & { expiresAt: Date }, now: Date): CertToken {
  return {
    id: row.id,
    domainId: row.domainId,
    name: row.name,
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    expired: row.expiresAt.getTime() <= now.getTime(),
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
    ))
    .orderBy(desc(certDownloadTokens.createdAt));
  return rows.filter(withinRules).map((r) => toDto(r, now));
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

  const now = new Date();
  const token = mintToken();
  const id = crypto.randomUUID();

  // Count and insert in one transaction. Without it two concurrent creates can
  // both pass the check and land at 21+ — a quota bypass rather than a
  // security hole, but the cap exists to bound the table and the blast radius
  // of a compromised panel session, so it should actually hold.
  const row = await db.transaction(async (tx) => {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(certDownloadTokens)
      .where(and(
        eq(certDownloadTokens.tenantId, tenantId),
        eq(certDownloadTokens.domainId, domainId),
      ));
    if (Number(n) >= MAX_TOKENS_PER_DOMAIN) {
      throw new ApiError(
        'CERT_TOKEN_LIMIT_REACHED',
        `A domain can have at most ${MAX_TOKENS_PER_DOMAIN} certificate tokens. Revoke one you no longer use.`,
        409,
      );
    }
    await tx.insert(certDownloadTokens).values({
      id,
      tenantId,
      domainId,
      name: input.name,
      tokenHash: hashToken(token),
      expiresAt: expiryToDate(input.expiry, now),
      createdBy,
      createdAt: now,
    });
    const [created] = await tx
      .select().from(certDownloadTokens).where(eq(certDownloadTokens.id, id)).limit(1);
    return created;
  });

  // The only time the plaintext leaves this function. Nothing persists it.
  if (!withinRules(row)) throw new Error('cert token row written outside the lifetime rules');
  return { ...toDto(row, now), token };
}

/**
 * Delete every link that is expired, or outside the lifetime rules (no expiry,
 * or more than 24 hours — minted by old code during a rollout). Run by the
 * leased reaper (token-reaper.ts) on one replica. The audit entry written at
 * minting is the durable record that the link existed.
 */
export async function reapExpiredTokens(db: Database, now: Date = new Date()): Promise<number> {
  const deleted = await db
    .delete(certDownloadTokens)
    .where(or(
      isNull(certDownloadTokens.expiresAt),
      lte(certDownloadTokens.expiresAt, now),
      sql`${certDownloadTokens.expiresAt} - ${certDownloadTokens.createdAt} > ${`${CERT_TOKEN_MAX_LIFETIME_MS / 1000} seconds`}::interval`,
    ))
    .returning({ id: certDownloadTokens.id });
  return deleted.length;
}

/**
 * Revoke by HARD DELETE, returning the deleted row so the caller can audit it.
 *
 * A tombstone would keep a dead credential in every list query and grow the
 * table forever; the durable record that the token existed and was revoked is
 * the `cert_download_token` audit row the route writes.
 */
export async function revokeToken(
  db: Database,
  tenantId: string,
  domainId: string,
  tokenId: string,
): Promise<{ id: string; name: string }> {
  const deleted = await db
    .delete(certDownloadTokens)
    .where(and(
      eq(certDownloadTokens.id, tokenId),
      eq(certDownloadTokens.tenantId, tenantId),
      eq(certDownloadTokens.domainId, domainId),
    ))
    .returning({ id: certDownloadTokens.id, name: certDownloadTokens.name });
  if (deleted.length === 0) {
    throw new ApiError('CERT_TOKEN_NOT_FOUND', `Certificate token '${tokenId}' not found`, 404);
  }
  return deleted[0];
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
  // No revoked check: revocation hard-deletes the row, so a revoked token
  // simply has no match above. (The table has no revoked_at column.)
  // Expired, or outside the lifetime rules, is refused even before the reaper
  // gets to it.
  if (!withinRules(row) || row.expiresAt.getTime() <= now.getTime()) return null;

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
