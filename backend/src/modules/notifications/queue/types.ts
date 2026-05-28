/**
 * Notification queue contracts (Phase 2).
 *
 * pg-boss queue name + job payload. Kept narrow so the worker handler
 * can't accidentally widen its input surface; everything else lives
 * on the `notification_deliveries` row referenced by `deliveryId`.
 */

/** Single queue for Phase 2 — email only. Other channels join later. */
export const NOTIFICATIONS_EMAIL_QUEUE = 'notifications.send-email' as const;

export interface NotificationSendJob {
  readonly deliveryId: string;
}

/** Exp backoff schedule for failed deliveries (worker computes the
 *  `next_attempt_at` after each non-terminal failure). Values are
 *  seconds-from-now for attempts 1..6. After attempt 6 the row moves
 *  to dlq. */
export const RETRY_BACKOFF_SECONDS: readonly number[] = [
  30,         // attempt 1 → wait 30s
  2 * 60,     // attempt 2 → 2m
  8 * 60,     // attempt 3 → 8m
  32 * 60,    // attempt 4 → 32m
  2 * 3600,   // attempt 5 → 2h
  8 * 3600,   // attempt 6 → 8h
];

export const MAX_DELIVERY_ATTEMPTS = RETRY_BACKOFF_SECONDS.length;
