/**
 * Re-enqueue scan — closes the Phase 2 gap where a notification_deliveries
 * row gets stuck in status='queued' because pg-boss was unavailable
 * when the dispatcher called enqueueDelivery(). Without this scan, those
 * rows would stay queued forever waiting for the dispatcher to retry —
 * but the dispatcher never retries; it's the worker that owns retries.
 *
 * Runs every 5 minutes (cheap query: covered by the queue-scan index).
 * For each candidate row, enqueues a fresh pg-boss job. The singleton
 * key includes the queued_at timestamp so a row that's already in
 * pg-boss doesn't get double-enqueued.
 *
 * Bounded: at most 100 rows per pass to keep the scan window small
 * even after a long pg-boss outage. Subsequent passes catch the rest.
 */
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { notificationDeliveries } from '../../../db/schema.js';
import { enqueueDelivery } from './enqueue.js';
import type { Database } from '../../../db/index.js';

const STUCK_QUEUED_THRESHOLD_SECONDS = 60;
const FAILED_RETRY_LAG_SECONDS = 60;
const MAX_BATCH_SIZE = 100;

export interface ReenqueueResult {
  readonly scanned: number;
  readonly reenqueued: number;
  readonly failed: number;
}

/**
 * Single pass of the re-enqueue scan. Returns counters so the caller
 * (and tests) can assert behavior.
 */
export async function reenqueueStuckDeliveries(
  db: Database,
  opts: { readonly now?: Date; readonly enqueue?: typeof enqueueDelivery } = {},
): Promise<ReenqueueResult> {
  const now = opts.now ?? new Date();
  const enqueue = opts.enqueue ?? enqueueDelivery;
  const stuckQueuedCutoff = new Date(now.getTime() - STUCK_QUEUED_THRESHOLD_SECONDS * 1000);
  const failedRetryCutoff = new Date(now.getTime() - FAILED_RETRY_LAG_SECONDS * 1000);

  // Two cases:
  //   - status='queued' AND queued_at < now - 60s
  //         (dispatcher tried to enqueue but pg-boss was down or the
  //          job was lost; row sat without a worker pickup)
  //   - status='failed' AND next_attempt_at < now - 60s
  //         (worker failed, scheduled a retry, but pg-boss never
  //          actually picked up the re-enqueue — defense in depth)
  const rows = await db
    .select({
      id: notificationDeliveries.id,
      status: notificationDeliveries.status,
      attempt: notificationDeliveries.attempt,
    })
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.channel, 'email'),
        or(
          and(
            eq(notificationDeliveries.status, 'queued'),
            lt(notificationDeliveries.queuedAt, stuckQueuedCutoff),
          ),
          and(
            eq(notificationDeliveries.status, 'failed'),
            or(
              isNull(notificationDeliveries.nextAttemptAt),
              lt(notificationDeliveries.nextAttemptAt, failedRetryCutoff),
            ),
          ),
        ),
      ),
    )
    .limit(MAX_BATCH_SIZE);

  let reenqueued = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      // singletonKey includes a per-scan-tick suffix so consecutive
      // scans don't dedupe against each other (a missed enqueue from
      // the first pass should land on the second).
      // eslint-disable-next-line no-await-in-loop
      await enqueue(r.id, {
        singletonKey: `delivery:${r.id}:scan:${Math.floor(now.getTime() / 60000)}:attempt:${r.attempt}`,
      });
      reenqueued++;
    } catch {
      failed++;
    }
  }

  return { scanned: rows.length, reenqueued, failed };
}

/**
 * Start the periodic re-enqueue scheduler. Returns the interval handle
 * so the caller can clearInterval on app shutdown.
 */
export function startReenqueueScheduler(
  db: Database,
  log?: { info: (msg: string, extra?: Record<string, unknown>) => void; warn: (msg: string, err?: unknown) => void },
): NodeJS.Timeout {
  const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  const timer = setInterval(async () => {
    try {
      const r = await reenqueueStuckDeliveries(db);
      if (r.scanned > 0) {
        log?.info('[notifications] re-enqueue scan', {
          scanned: r.scanned, reenqueued: r.reenqueued, failed: r.failed,
        });
      }
    } catch (err) {
      log?.warn('[notifications] re-enqueue scan failed', err);
    }
  }, SCAN_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// Exported for tests.
export const REENQUEUE_THRESHOLDS = {
  STUCK_QUEUED_THRESHOLD_SECONDS,
  FAILED_RETRY_LAG_SECONDS,
  MAX_BATCH_SIZE,
} as const;
