/**
 * In-memory revoked-serial cache for the mTLS ForwardAuth revocation gate.
 *
 * Traefik v3.7 OSS `TLSOption` enforces the CA at the TLS handshake but has
 * NO CRL field — so revocation is enforced by a per-request ForwardAuth to
 * `/internal/mtls/verify`. To keep that check cheap and decoupled from the
 * database, the set of revoked cert serials is held in memory and refreshed
 * on a timer (and on demand after a revoke). The per-request cost is then an
 * O(1) Set membership test — no DB query, no CRL parse per request.
 *
 * A down/stale cache never *grants* access it shouldn't: the CA gate at the
 * handshake still applies, and the verify handler fails closed on a serial it
 * cannot evaluate.
 */

import { isNotNull } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { tenantCertificates } from '../../db/schema.js';

const REFRESH_TTL_MS = 60_000;

let revokedSerials = new Set<string>();
let lastRefresh = 0;
let inFlight: Promise<void> | null = null;

function normalizeSerial(serialHex: string): string {
  // DB stores lowercase hex, no separators. Normalise inbound serials
  // (which may arrive uppercase and/or colon-separated from a cert parse).
  return serialHex.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

async function refresh(db: Database): Promise<void> {
  const rows = await db
    .select({ serialHex: tenantCertificates.serialHex })
    .from(tenantCertificates)
    .where(isNotNull(tenantCertificates.revokedAt));
  const next = new Set<string>();
  for (const r of rows) next.add(normalizeSerial(r.serialHex));
  revokedSerials = next;
  lastRefresh = Date.now();
}

/**
 * Ensure the cache is fresher than the TTL. Concurrent callers share one
 * in-flight refresh. Never throws — a failed refresh keeps the last-known
 * set (the caller's fail-closed logic covers the not-yet-loaded case).
 */
export async function ensureFreshRevocationCache(db: Database): Promise<void> {
  if (Date.now() - lastRefresh < REFRESH_TTL_MS) return;
  if (inFlight) {
    await inFlight;
    return;
  }
  inFlight = refresh(db)
    .catch((err: unknown) => {
      console.warn('[mtls-revocation] cache refresh failed:', err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      inFlight = null;
    });
  await inFlight;
}

/** True when the cache has been populated at least once. */
export function revocationCacheReady(): boolean {
  return lastRefresh > 0;
}

/** O(1) revocation test against the in-memory set. */
export function isSerialRevoked(serialHex: string): boolean {
  return revokedSerials.has(normalizeSerial(serialHex));
}

/** Force the next `ensureFreshRevocationCache` to reload (call after revoke/unrevoke). */
export function invalidateRevocationCache(): void {
  lastRefresh = 0;
}
