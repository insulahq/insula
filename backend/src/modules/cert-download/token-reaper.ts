/**
 * Reaps expired certificate download links.
 *
 * Links live 15 minutes to 24 hours. An expired link is already refused on
 * use (token-service verifyToken); this deletes the row, so a dead credential
 * does not sit in the table or the panel's list. Every few minutes, on one
 * replica (a lease): two replicas deleting the same rows is harmless, but
 * every timer in platform-api runs behind a lease or states why it does not.
 */
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import type { Database } from '../../db/index.js';
import { reapExpiredTokens } from './token-service.js';

export const CERT_TOKEN_REAP_INTERVAL_MS = 5 * 60_000;

export interface ReaperLog {
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
}

/** One pass, under the lease. Exported for tests. */
export async function reapCertTokensOnce(db: Database, log: ReaperLog): Promise<void> {
  try {
    const leased = await withSchedulerLease(db, 'cert-token-reaper', CERT_TOKEN_REAP_INTERVAL_MS * 1.5,
      () => reapExpiredTokens(db));
    if (leased.ran && leased.value > 0) {
      log.info({ removed: leased.value }, 'cert-token-reaper: expired certificate download links removed');
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'cert-token-reaper failed; retried next interval');
  }
}

export function startCertTokenReaper(db: Database, log: ReaperLog): NodeJS.Timeout {
  return setInterval(() => { void reapCertTokensOnce(db, log); }, CERT_TOKEN_REAP_INTERVAL_MS);
}
