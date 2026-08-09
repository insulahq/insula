import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

let pool: pg.Pool | null = null;

export function getDb(connectionString: string) {
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      max: 25,                          // Max connections in the pool
      idleTimeoutMillis: 60_000,        // Close idle connections after 60s
      connectionTimeoutMillis: 10_000,  // Timeout for new connections
    });
    // MANDATORY. pg.Pool is an EventEmitter and emits 'error' when an IDLE
    // pooled client's backend goes away — which is exactly what a Postgres
    // restart does to every idle connection at once. An EventEmitter that
    // emits 'error' with no listener makes Node throw and kill the process,
    // so without this a CNPG failover, minor-version upgrade, PITR promote or
    // node drain takes platform-api down with the database.
    //
    // Found alongside the identical bug in the pg-boss bootstrap, which was
    // caught crashing the API in a DR run (SQLSTATE 57P03, exit code 1). Two
    // independent paths, same root shape; fixing only one leaves the door open.
    //
    // Errors on an IDLE client are not tied to a caller — the query path
    // surfaces its own errors through the awaited promise — so log and carry
    // on. pg removes the broken client from the pool and reconnects on demand.
    // The deployment's shallow /healthz exists precisely so a RUNNING pod
    // rides out a brief DB blip; it cannot ride out one that kills it.
    pool.on('error', (err: Error & { code?: string }) => {
      // eslint-disable-next-line no-console
      console.error(
        `[db] idle client error (pool recovers, no request affected): ${err.code ? `[${err.code}] ` : ''}${err.message}`,
      );
    });
  }
  return drizzle(pool, { schema });
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Borrow a raw pg.Client from the same pool the Drizzle instance uses.
 * Required for long-lived `LISTEN` consumers (the Task Tracker SSE
 * stream) — Drizzle has no surface for `LISTEN/NOTIFY`. Caller MUST
 * release the tenant when done. The pool is initialised on first
 * `getDb()` call; this throws if called before `getDb()`.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('db pool not initialised — call getDb(connectionString) first');
  }
  return pool;
}

export type Database = ReturnType<typeof getDb>;
