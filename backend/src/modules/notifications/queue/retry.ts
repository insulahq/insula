/**
 * Retry scheduler for failed deliveries.
 *
 * Pure function — no DB / clock side effects. Tests pass a fixed
 * `now` and assert the returned next-attempt timestamp.
 */
import { RETRY_BACKOFF_SECONDS, MAX_DELIVERY_ATTEMPTS } from './types.js';

export interface RetryDecision {
  /** Status to persist on the delivery row. */
  readonly status: 'failed' | 'dlq';
  /** When the worker should pick the row up next. NULL when status='dlq'. */
  readonly nextAttemptAt: Date | null;
}

/**
 * Decide what to do after a failed send.
 *
 * @param attempt The attempt count AFTER incrementing for this failure
 *                (so the first failed attempt passes attempt=1).
 * @param now Wall-clock used to compute nextAttemptAt. Injected for tests.
 */
export function decideRetry(attempt: number, now: Date = new Date()): RetryDecision {
  if (attempt >= MAX_DELIVERY_ATTEMPTS) {
    return { status: 'dlq', nextAttemptAt: null };
  }
  const backoffSeconds = RETRY_BACKOFF_SECONDS[attempt - 1] ?? RETRY_BACKOFF_SECONDS[RETRY_BACKOFF_SECONDS.length - 1];
  return {
    status: 'failed',
    nextAttemptAt: new Date(now.getTime() + backoffSeconds * 1000),
  };
}
