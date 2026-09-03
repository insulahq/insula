import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyToken, __testing } from './token-service.js';
import type { Database } from '../../db/index.js';

const { hashToken, mintToken, TOKEN_PREFIX } = __testing;

type Row = {
  id: string; tenantId: string; domainId: string; name: string;
  tokenHash: string; expiresAt: Date | null; revokedAt: Date | null;
};

/**
 * Stand-in for the single `select().from().where().limit()` lookup.
 *
 * Returns whatever rows the test supplies, regardless of condition: matching a
 * hash to a row is the DB's UNIQUE index doing its job, not this service's
 * logic. What IS this service's logic — the prefix gate, revocation, expiry —
 * is what these tests drive, so the fake stays out of Drizzle's internals.
 */
function dbWith(rows: Row[]): { db: Database; lookups: () => number } {
  let count = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => { count += 1; return Promise.resolve(rows); },
        }),
      }),
    }),
  } as unknown as Database;
  return { db, lookups: () => count };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'tok-1', tenantId: 't-1', domainId: 'd-1', name: 'deploy-pipeline',
    tokenHash: 'x', expiresAt: null, revokedAt: null, ...over,
  };
}

describe('cert-download token minting', () => {
  it('mints a prefixed 256-bit token', () => {
    const t = mintToken();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    // base64url of 32 bytes = 43 chars, no padding.
    expect(t.slice(TOKEN_PREFIX.length)).toHaveLength(43);
  });

  it('mints distinct tokens', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintToken()));
    expect(seen.size).toBe(200);
  });

  it('stores only the sha256 — the plaintext is not recoverable from the row', () => {
    const t = mintToken();
    const h = hashToken(t);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).not.toContain(t.slice(TOKEN_PREFIX.length));
  });
});

describe('verifyToken', () => {
  const good = mintToken();

  it('accepts a live token and returns its binding', async () => {
    const { db } = dbWith([row({ tokenHash: hashToken(good) })]);
    await expect(verifyToken(db, good)).resolves.toMatchObject({
      tokenId: 'tok-1', tenantId: 't-1', domainId: 'd-1',
    });
  });

  it('rejects a missing header', async () => {
    const { db } = dbWith([row({ tokenHash: hashToken(good) })]);
    expect(await verifyToken(db, undefined)).toBeNull();
  });

  it('rejects an unknown token (no row matches the hash)', async () => {
    const { db } = dbWith([]);
    expect(await verifyToken(db, mintToken())).toBeNull();
  });

  it('rejects a revoked token', async () => {
    const { db } = dbWith([row({ tokenHash: hashToken(good), revokedAt: new Date() })]);
    expect(await verifyToken(db, good)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { db } = dbWith([row({ tokenHash: hashToken(good), expiresAt: new Date('2020-01-01') })]);
    expect(await verifyToken(db, good)).toBeNull();
  });

  it('accepts a token whose expiry is still in the future', async () => {
    const future = new Date(Date.now() + 3600_000);
    const { db } = dbWith([row({ tokenHash: hashToken(good), expiresAt: future })]);
    expect(await verifyToken(db, good)).not.toBeNull();
  });

  it('treats expiry as inclusive — a token expiring exactly now is dead', async () => {
    const now = new Date('2026-09-03T12:00:00Z');
    const { db } = dbWith([row({ tokenHash: hashToken(good), expiresAt: now })]);
    expect(await verifyToken(db, good, now)).toBeNull();
  });

  // A JWT presented here must not be honoured: this route is deliberately
  // outside the JWT/OIDC path, and accepting one would re-couple them.
  it('rejects anything without the cert-token prefix, without hitting the DB', async () => {
    const { db, lookups } = dbWith([row({ tokenHash: hashToken(good) })]);
    const jwtish = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig';
    expect(await verifyToken(db, jwtish)).toBeNull();
    expect(await verifyToken(db, '')).toBeNull();
    expect(await verifyToken(db, 'Bearer something')).toBeNull();
    // Short-circuited on the prefix — no lookup was attempted. A JWT must not
    // even reach the token table: this route is deliberately outside the
    // JWT/OIDC path and honouring one would re-couple them.
    expect(lookups()).toBe(0);
  });

  it('does not accept the stored hash itself as a token', async () => {
    const h = hashToken(good);
    const { db } = dbWith([row({ tokenHash: h })]);
    // No prefix -> rejected before any lookup.
    expect(await verifyToken(db, h)).toBeNull();
  });
});

describe('token entropy', () => {
  it('carries 256 bits of randomness, so guessing is not feasible', () => {
    const raw = mintToken().slice(TOKEN_PREFIX.length);
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32);
  });

  it('hash matches a plain sha256 of the full token including prefix', () => {
    const t = mintToken();
    expect(hashToken(t)).toBe(crypto.createHash('sha256').update(t).digest('hex'));
  });
});
