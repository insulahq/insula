/**
 * WAL-archive circuit-breaker persistence.
 *
 * When archiving keeps failing against an unreachable sink and pg_wal climbs
 * toward a full volume, the scheduler TRIPS this breaker: it persists a
 * "tripped" flag AND removes the barman plugin. The flag is what makes the
 * disable STICK — the postgres-objectstore reconciler reads it every tick and
 * keeps the plugin absent while tripped, so it doesn't re-add the failing
 * archiver behind the breaker's back. An operator clears it (reset) after
 * fixing the sink, and the reconciler re-attaches archiving.
 *
 * Stored as a single JSON row in platform_settings (no migration needed).
 */
import { eq } from 'drizzle-orm';
import { platformSettings } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export const CIRCUIT_BREAKER_KEY = 'wal_archive_circuit_breaker';

export interface CircuitBreakerState {
  readonly tripped: boolean;
  /** Human-readable reason the breaker tripped (for the alert + UI). */
  readonly reason: string;
  /** ISO-8601 timestamp the breaker tripped. */
  readonly trippedAt: string;
  readonly clusterName: string;
}

export const UNTRIPPED: CircuitBreakerState = { tripped: false, reason: '', trippedAt: '', clusterName: '' };

/** Read the breaker state; UNTRIPPED when absent or unparseable. */
export async function readCircuitBreaker(db: Database): Promise<CircuitBreakerState> {
  const [row] = await db
    .select()
    .from(platformSettings)
    .where(eq(platformSettings.key, CIRCUIT_BREAKER_KEY))
    .limit(1);
  if (!row?.value) return UNTRIPPED;
  try {
    const parsed = JSON.parse(row.value) as Partial<CircuitBreakerState>;
    return {
      tripped: parsed.tripped === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      trippedAt: typeof parsed.trippedAt === 'string' ? parsed.trippedAt : '',
      clusterName: typeof parsed.clusterName === 'string' ? parsed.clusterName : '',
    };
  } catch {
    return UNTRIPPED;
  }
}

async function writeCircuitBreaker(db: Database, state: CircuitBreakerState): Promise<void> {
  const value = JSON.stringify(state);
  await db
    .insert(platformSettings)
    .values({ key: CIRCUIT_BREAKER_KEY, value })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value } });
}

/** Trip the breaker (idempotent — preserves the original trippedAt if already tripped). */
export async function tripCircuitBreaker(
  db: Database,
  opts: { readonly reason: string; readonly clusterName: string; readonly nowIso: string },
): Promise<void> {
  const current = await readCircuitBreaker(db);
  await writeCircuitBreaker(db, {
    tripped: true,
    reason: opts.reason,
    // Keep the first trip time so "tripped 3 days ago" stays accurate.
    trippedAt: current.tripped && current.trippedAt ? current.trippedAt : opts.nowIso,
    clusterName: opts.clusterName,
  });
}

/** Clear the breaker (operator re-enable after fixing the sink). */
export async function resetCircuitBreaker(db: Database): Promise<void> {
  await writeCircuitBreaker(db, UNTRIPPED);
}
