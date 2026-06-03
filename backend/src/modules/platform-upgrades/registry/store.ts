/**
 * W9 / ADR-045 — real {@link MigrationStore} backed by Postgres.
 *
 * `withLock` holds a SESSION-level `pg_try_advisory_lock` on a dedicated pool
 * client (the lock is tied to the connection). Non-blocking by design: a held
 * lock means another replica is mid-apply, so we return `acquired:false` and
 * let this pod boot immediately rather than block on a possibly-stuck peer.
 */
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import type { Database } from '../../../db/index.js';
import { platformMigrations } from '../../../db/schema.js';
import type { AppliedMigrationRecord, MigrationStore } from './types.js';

/**
 * Fixed 64-bit advisory-lock key shared by every replica (they must contend
 * for the SAME lock). Arbitrary constant namespaced to platform-migrations;
 * < 2^53 so it round-trips as a JS number with no precision loss.
 */
export const PLATFORM_MIGRATIONS_LOCK_KEY = 450_202_609_001;

export function realMigrationStore(db: Database, pool: pg.Pool): MigrationStore {
  return {
    async listApplied() {
      const rows = await db
        .select({ id: platformMigrations.id, checksum: platformMigrations.checksum })
        .from(platformMigrations);
      return new Map(rows.map((r) => [r.id, { checksum: r.checksum }]));
    },

    async recordApplied(rec: AppliedMigrationRecord) {
      // ON CONFLICT keeps recordApplied idempotent (a manual re-apply re-stamps
      // the checksum + duration rather than erroring on the PK).
      await db
        .insert(platformMigrations)
        .values({ id: rec.id, version: rec.version, checksum: rec.checksum, durationMs: rec.durationMs })
        .onConflictDoUpdate({
          target: platformMigrations.id,
          set: { version: rec.version, checksum: rec.checksum, durationMs: rec.durationMs, appliedAt: sql`now()` },
        });
    },

    async withLock<T>(fn: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
      const client = await pool.connect();
      // A session-level advisory lock lives on the CONNECTION, not the
      // transaction. release() returns the client to the pool WITHOUT ending the
      // session, so a swallowed unlock failure would leave the lock held on a
      // recycled connection until its idle-timeout. Guard: if unlock fails,
      // destroy the connection (`release(true)`) so the session — and the lock —
      // terminate immediately.
      let destroyClient = false;
      try {
        const got = await client.query<{ ok: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS ok',
          [PLATFORM_MIGRATIONS_LOCK_KEY],
        );
        if (!got.rows[0]?.ok) return { acquired: false };
        try {
          const result = await fn();
          return { acquired: true, result };
        } finally {
          try {
            await client.query('SELECT pg_advisory_unlock($1)', [PLATFORM_MIGRATIONS_LOCK_KEY]);
          } catch {
            destroyClient = true; // unlock failed → tear the session down to free the lock
          }
        }
      } finally {
        client.release(destroyClient);
      }
    },
  };
}
