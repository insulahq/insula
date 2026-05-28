/**
 * Notification rate-limit buckets.
 *
 * Fixed-window counter keyed by bucket-key string. Composite key shape:
 *   `cat:<categoryId>:user:<userId>:win:<windowStartUnix>`
 *
 * Compared against (windowS, max) supplied per call:
 *   - INSERT new row with count=1 when no row for this window
 *   - UPDATE existing row with count = count + 1
 *   - allowed=false when post-increment count > max
 *
 * Cleanup: the daily `purgeStaleBuckets` job removes rows where
 * window_end < NOW(). The bucket-key index keeps lookups O(1).
 */
import { eq, lt, sql } from 'drizzle-orm';
import { notificationRateLimitBuckets } from '../../../db/schema.js';
import type { Database } from '../../../db/index.js';

export interface IncrementBucketResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly count: number;
  readonly windowEnd: Date;
}

/**
 * Build a stable composite key. The window-start (unix seconds floored
 * to windowS) ensures hits in the same window land on the same row.
 */
export function makeBucketKey(opts: {
  categoryId: string;
  userId: string;
  windowS: number;
  now?: Date;
}): { bucketKey: string; windowStart: Date; windowEnd: Date } {
  const now = opts.now ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  const windowStartS = Math.floor(nowS / opts.windowS) * opts.windowS;
  const windowEndS = windowStartS + opts.windowS;
  const bucketKey = `cat:${opts.categoryId}:user:${opts.userId}:win:${windowStartS}`;
  return {
    bucketKey,
    windowStart: new Date(windowStartS * 1000),
    windowEnd: new Date(windowEndS * 1000),
  };
}

/**
 * Atomic increment-or-create.
 *
 * Single round-trip via INSERT ... ON CONFLICT DO UPDATE RETURNING count.
 * Returns allowed=false when the post-increment count exceeds max.
 */
export async function incrementBucket(
  db: Database,
  bucketKey: string,
  windowS: number,
  max: number,
  now: Date = new Date(),
): Promise<IncrementBucketResult> {
  // Derive window-start from the key suffix so we don't drift if the
  // caller passed a stale `now`.
  const m = /:win:(\d+)$/.exec(bucketKey);
  const windowStartS = m ? Number.parseInt(m[1], 10) : Math.floor(now.getTime() / 1000);
  const windowEndS = windowStartS + windowS;
  const windowStart = new Date(windowStartS * 1000);
  const windowEnd = new Date(windowEndS * 1000);

  const [row] = await db
    .insert(notificationRateLimitBuckets)
    .values({
      bucketKey,
      count: 1,
      windowStart,
      windowEnd,
    })
    .onConflictDoUpdate({
      target: notificationRateLimitBuckets.bucketKey,
      set: { count: sql`${notificationRateLimitBuckets.count} + 1` },
    })
    .returning({ count: notificationRateLimitBuckets.count });

  const count = row?.count ?? 1;
  const remaining = Math.max(0, max - count);
  return {
    allowed: count <= max,
    remaining,
    count,
    windowEnd,
  };
}

/**
 * Daily cron: delete rows whose window has elapsed. Returns deletion count.
 */
export async function purgeStaleBuckets(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const result = await db
    .delete(notificationRateLimitBuckets)
    .where(lt(notificationRateLimitBuckets.windowEnd, now))
    .returning({ key: notificationRateLimitBuckets.bucketKey });
  return result.length;
}

/**
 * One-shot helper used by the dispatcher: build key + increment + return result.
 */
export async function consumeRateLimit(
  db: Database,
  opts: {
    categoryId: string;
    userId: string;
    windowS: number;
    max: number;
    now?: Date;
  },
): Promise<IncrementBucketResult> {
  const { bucketKey } = makeBucketKey(opts);
  return incrementBucket(db, bucketKey, opts.windowS, opts.max, opts.now);
}

// Helper: lookup current count without incrementing (used in tests).
export async function getBucketCount(db: Database, bucketKey: string): Promise<number> {
  const [row] = await db
    .select({ count: notificationRateLimitBuckets.count })
    .from(notificationRateLimitBuckets)
    .where(eq(notificationRateLimitBuckets.bucketKey, bucketKey))
    .limit(1);
  return row?.count ?? 0;
}
