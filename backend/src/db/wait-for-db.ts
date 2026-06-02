/**
 * Block until Postgres accepts QUERIES (not just TCP), then exit 0; exit 1 on
 * timeout. Run by docker-entrypoint.sh BEFORE migrations.
 *
 * Why: the previous `nc -z` TCP gate passed the moment the socket opened, but
 * during a CNPG primary restart the postgres pod accepts TCP connections while
 * still in recovery ("the database system is starting up", backend_startup.c).
 * `migrate.js` then connected too early, hit that FATAL, and exited 1 —
 * crashlooping every platform-api pod that (re)started during a system-db
 * restart, which CNPG does on every backup-target enable/disable
 * (project_wal_archive_runaway flap). A real `SELECT 1` only succeeds once the
 * primary is actually serving, so this gate waits for that.
 */
import pg from 'pg';

const url = process.env.DATABASE_URL;
const maxSeconds = Number(process.env.PG_WAIT_SECONDS ?? '240') || 240;
const INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (!url) {
    console.error('wait-for-db: DATABASE_URL is required');
    process.exit(1);
  }
  const deadline = Date.now() + maxSeconds * 1000;
  let attempt = 0;
  let lastErr = '';
  while (Date.now() < deadline) {
    attempt += 1;
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    // A connection reset mid-restart surfaces as an async 'error' event; without
    // a listener node-postgres would turn it into an uncaught exception + crash.
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end().catch(() => undefined);
      console.log(`wait-for-db: postgres is accepting queries (after ${attempt} attempt(s))`);
      process.exit(0);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      await client.end().catch(() => undefined);
      await sleep(INTERVAL_MS);
    }
  }
  console.error(`wait-for-db: postgres not query-ready within ${maxSeconds}s — last error: ${lastErr}`);
  process.exit(1);
}

void main();
