/**
 * Every 15 minutes, delete agent credentials that can never be used again
 * (expired OAuth tokens, long-dead PATs, unanswered or redeemed authorization
 * requests). One replica does it (lease).
 */
import type { Database } from '../../db/index.js';
import { withSchedulerLease } from '../../shared/scheduler-lease.js';
import { reapExpired } from './tokens.js';

export const MCP_REAPER_INTERVAL_MS = 15 * 60_000;

export function startMcpTokenReaper(db: Database, log: { warn: (obj: unknown, msg?: string) => void }): () => void {
  const tick = (): void => {
    withSchedulerLease(db, 'mcp-token-reaper', MCP_REAPER_INTERVAL_MS * 1.5, () => reapExpired(db))
      .catch((err: unknown) => log.warn({ err: err instanceof Error ? err.message : String(err) }, 'mcp token reaper failed'));
  };
  const timer = setInterval(tick, MCP_REAPER_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
