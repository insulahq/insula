/**
 * Enqueue helper — used by the dispatcher when an email channel
 * delivery row is written.
 */
import { getBoss, type BossLike } from './bootstrap.js';
import { NOTIFICATIONS_EMAIL_QUEUE, type NotificationSendJob } from './types.js';

export interface EnqueueOptions {
  /** Earliest the worker may pick the job up. Used for retry scheduling. */
  readonly startAfter?: Date;
  /** Singleton key (pg-boss dedupes within a window). When provided we
   *  use it to prevent double-enqueue of the same delivery from a
   *  concurrent retry-scheduler scan. */
  readonly singletonKey?: string;
}

/**
 * Enqueue a `notification_deliveries` row for the email worker.
 * Returns the pg-boss job id (NULL means the job was deduped by a
 * matching singletonKey already in the queue).
 */
export async function enqueueDelivery(
  deliveryId: string,
  options: EnqueueOptions = {},
  boss?: BossLike,
): Promise<string | null> {
  const b = boss ?? await getBoss();
  const payload: NotificationSendJob = { deliveryId };
  return await b.send(NOTIFICATIONS_EMAIL_QUEUE, payload, {
    startAfter: options.startAfter,
    singletonKey: options.singletonKey ?? `delivery:${deliveryId}`,
  });
}
