/**
 * Abandoned-draft restore-cart cleanup.
 *
 * Restore carts start life in `status='draft'` while the operator
 * (admin or tenant) browses bundle contents and adds items. Most
 * drafts either get executed (status → 'executing' → 'done') or
 * discarded by tab-close. The tab-close case leaves an orphan row
 * forever — it accumulates over time with no surface that lists or
 * cleans it up.
 *
 * This cleanup runs on a scheduler tick (15 min) and deletes any
 * draft cart older than `DRAFT_CART_RETENTION_DAYS` (default 7).
 * `restore_items.restore_job_id FK` has `ON DELETE CASCADE` so child
 * items go with the parent in one SQL statement.
 *
 * Why 7 days: an operator who started a restore but got pulled into
 * an incident should be able to come back the same week and finish.
 * Anything older is almost certainly abandoned, and the bundle the
 * draft was anchored to may itself have expired (retention policy).
 *
 * Non-draft carts are NEVER touched here. Executing carts must
 * complete or be explicitly rolled back; done/failed carts are
 * the audit trail for the destructive op and stay forever.
 */
import { and, eq, lt } from 'drizzle-orm';
import { restoreJobs } from '../../db/schema.js';
import type { Database } from '../../db/index.js';

export const DRAFT_CART_RETENTION_DAYS = 7;

export interface CleanupDraftCartsOpts {
  readonly db: Database;
  /** Clock injection — tests pass a frozen Date. */
  readonly now: () => Date;
  /** Override retention. Operator escape hatch; default 7d. */
  readonly retentionDays?: number;
  readonly logger?: { warn: (msg: string, err?: unknown) => void };
}

export interface CleanupDraftCartsResult {
  readonly deleted: number;
  readonly error?: string;
}

export async function cleanupDraftRestoreCarts(
  opts: CleanupDraftCartsOpts,
): Promise<CleanupDraftCartsResult> {
  const retentionDays = opts.retentionDays ?? DRAFT_CART_RETENTION_DAYS;
  const cutoff = new Date(opts.now().getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const log = opts.logger ?? {
    // eslint-disable-next-line no-console
    warn: (msg, err) => console.warn(`[restore-cart-cleanup] ${msg}`, err ?? ''),
  };

  try {
    // `.returning({id})` lets us count rows in a portable way + log
    // which carts were swept (helpful when chasing "why did my draft
    // disappear?" support tickets). The query plan is identical to
    // a plain DELETE — Postgres still scans by the
    // restore_jobs_status_idx + restore_jobs_created_idx composite
    // (status='draft' AND created_at < cutoff is sargable on both).
    const rows = await opts.db
      .delete(restoreJobs)
      .where(and(eq(restoreJobs.status, 'draft'), lt(restoreJobs.createdAt, cutoff)))
      .returning({ id: restoreJobs.id });
    return { deleted: rows.length };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn('cleanupDraftRestoreCarts failed — will retry on next tick', err);
    return { deleted: 0, error: errMsg };
  }
}
