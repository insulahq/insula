/**
 * Retry a database call across a short PostgreSQL outage.
 *
 * A CNPG primary failover or switchover takes roughly 30–60 s. During it every
 * query fails: the `-rw` Service has no endpoint (ECONNREFUSED), the old primary
 * is shut down under the connection (57P01), or a just-demoted primary refuses
 * writes (25006). Long-running work that records its progress in the database
 * must ride that out — a mail DR failover lost on a 3-server HA cluster exactly
 * this way: the node that died also held the database primary, one progress
 * UPDATE failed during the promotion, and the whole failover was abandoned with
 * its run row stuck in `running` and mail already serving from the standby.
 *
 * Only transient (connection / availability) errors are retried; a constraint
 * or SQL error is thrown at once.
 */

/** SQLSTATEs that mean "the server is not available right now". */
const TRANSIENT_SQLSTATES = new Set([
  '57P01', // admin_shutdown — the old primary going down under the connection
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — starting up / in recovery
  '25006', // read_only_sql_transaction — connected to a just-demoted primary
  '08000', '08001', '08003', '08004', '08006', // connection exceptions
]);

const TRANSIENT_ERRNOS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'EAI_AGAIN']);

const TRANSIENT_MESSAGES = [
  /Connection terminated/i,
  /terminating connection/i,
  /the database system is (starting up|shutting down|in recovery)/i,
  /timeout exceeded when trying to connect/i,
];

/** True when `err` (or any error in its `cause` chain) is a transient database outage. */
export function isTransientDbError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_ERRNOS.has(code))) return true;
    if (TRANSIENT_MESSAGES.some((re) => re.test(cur instanceof Error ? cur.message : ''))) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export interface DbRetryOptions {
  /** Total attempts, first one included. Default 24 (× 5 s ≈ 2 min of retries). */
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: (attempt: number, err: unknown) => void;
}

export async function withDbRetry<T>(fn: () => Promise<T>, opts: DbRetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 24);
  const delayMs = opts.delayMs ?? 5_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransientDbError(err)) throw err;
      opts.onRetry?.(attempt, err);
      await sleep(delayMs);
    }
  }
}
