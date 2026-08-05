/**
 * Spam-training-sample cleanup for the mailbox/domain teardown flow.
 *
 * Stalwart blob storage is REFERENCE-COUNTED. A message blob survives until
 * every reference is gone, and a `SpamTrainingSample` row is one such
 * reference — held as a `BlobLink::Temporary { until }` stamped AT INGEST as
 * `midnight + SpamClassifier.holdSamplesFor`, i.e. **180 days** on a default
 * install.
 *
 * Destroying the Account does not drop it: Stalwart's `destroy_account_blobs`
 * unlinks only `Collection::{Email,FileNode,SieveScript}` hard links. So
 * without this module a deleted tenant's mail keeps occupying the mail PVC for
 * up to 180 days — invisibly, because the mailbox is gone and the account
 * quota reads 0 B.
 *
 * Measured on Stalwart v0.16.16 (2026-08-04 spike, 2 GiB corpus):
 *   - samples present  → blob purge reports `expires 0    / total 4221`, 0 bytes freed
 *   - samples destroyed → blob purge reports `expires 4200 / total 21`, and the
 *     next CF[t] compaction dropped the store from 2,142,844 KB to 11,156 KB.
 *
 * This is the FAST path (space back within a compaction cycle). The slow path —
 * the `until` timer plus Stalwart's daily 04:00 blob cleanup — remains the
 * backstop for anything this misses, bounded by `holdSamplesFor`
 * (set to 30 d by bootstrap; see scripts/bootstrap.sh configure_stalwart_full).
 */

import { spamTrainingSampleDestroyPage } from '../stalwart-jmap/client.js';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'spam-sample-cleanup' });

/** Rows destroyed per JMAP round-trip. Bounds in-flight ids, not total work. */
export const SPAM_SAMPLE_PAGE_SIZE = 200;

/**
 * Wall-clock budget per principal. Teardown runs inside a lifecycle hook whose
 * caller (the FK cascade) is about to delete the platform rows — it must not
 * hang there. Whatever is left is reported, never silently dropped, and the
 * `holdSamplesFor` timer still collects it.
 */
export const SPAM_SAMPLE_DEADLINE_MS = 15_000;

export interface SpamSampleCleanupResult {
  /** Number of sample rows destroyed. */
  readonly destroyed: number;
  /**
   * Rows still matching the filter when we stopped. > 0 means the deadline or
   * page cap was hit — NOT that the purge failed.
   */
  readonly remaining: number;
  /** True when the drain ended because the deadline expired. */
  readonly deadlineHit: boolean;
}

/**
 * Destroy every spam training sample owned by one Stalwart principal.
 *
 * Drains page-by-page until the server stops returning ids. Each page is a
 * single query+destroy round-trip, so peak memory is one page of id strings
 * regardless of backlog size.
 *
 * MUST be called BEFORE the principal is destroyed — the samples are addressed
 * by `filter.accountId`, and the caller needs a valid principal id to pass.
 *
 * Best-effort by design, matching the rest of the teardown path: a mail-server
 * outage must never wedge a tenant deletion. Errors propagate to the caller,
 * which logs and continues.
 */
export async function purgeSpamTrainingSamplesForPrincipal(params: {
  principalId: string;
  baseUrl?: string;
  pageSize?: number;
  deadlineMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}): Promise<SpamSampleCleanupResult> {
  const {
    principalId,
    baseUrl,
    pageSize = SPAM_SAMPLE_PAGE_SIZE,
    deadlineMs = SPAM_SAMPLE_DEADLINE_MS,
    now = Date.now,
  } = params;

  const startedAt = now();
  let destroyed = 0;
  let remaining = 0;
  let deadlineHit = false;

  for (;;) {
    if (now() - startedAt >= deadlineMs) {
      deadlineHit = true;
      break;
    }
    const page = await spamTrainingSampleDestroyPage({ principalId, limit: pageSize, baseUrl });
    remaining = Math.max(0, page.total - page.destroyed.length);
    destroyed += page.destroyed.length;
    // An empty page means the filter is exhausted. Also stop on a short page
    // that the server refused to destroy, so a permanently-undeletable row
    // cannot spin this loop until the deadline.
    if (page.destroyed.length === 0) break;
  }

  if (remaining > 0) {
    log.warn(
      { principalId, destroyed, remaining, deadlineHit },
      'spam training samples partially purged — the holdSamplesFor timer will collect the rest',
    );
  } else if (destroyed > 0) {
    log.info({ principalId, destroyed }, 'spam training samples purged (blob references released)');
  }

  return { destroyed, remaining, deadlineHit };
}
