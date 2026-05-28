/**
 * pg-boss singleton bootstrap.
 *
 * pg-boss installs its own schema (default 'pgboss') on first start.
 * It is safe to call `getBoss()` repeatedly — the underlying instance
 * is constructed once per process. Tests inject a fake via
 * `setBossForTesting()`.
 */
import { PgBoss } from 'pg-boss';
import { NOTIFICATIONS_EMAIL_QUEUE } from './types.js';

/** Minimum surface of pg-boss the rest of the queue module relies on.
 *  Lets us inject a fake in tests without polyfilling the whole class. */
export interface BossLike {
  start(): Promise<unknown>;
  stop(opts?: { graceful?: boolean; timeout?: number }): Promise<unknown>;
  createQueue(queue: string): Promise<unknown>;
  send(
    queue: string,
    data: unknown,
    options?: { startAfter?: Date | number | string; singletonKey?: string; retryLimit?: number },
  ): Promise<string | null>;
  work<T>(
    queue: string,
    options: { teamSize?: number; teamConcurrency?: number; batchSize?: number },
    handler: (jobs: ReadonlyArray<{ id: string; data: T }>) => Promise<void>,
  ): Promise<string>;
}

let instance: BossLike | null = null;

function buildBoss(): BossLike {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL required for pg-boss bootstrap');
  }
  // We track retries in notification_deliveries ourselves and re-enqueue
  // via startAfter, so pg-boss-side retry is disabled at queue/send time.
  return new PgBoss({
    connectionString,
    // pg-boss internal schema — isolated from our migration namespace.
    schema: 'pgboss',
  }) as unknown as BossLike;
}

export async function getBoss(): Promise<BossLike> {
  if (!instance) {
    instance = buildBoss();
    await instance.start();
    await instance.createQueue(NOTIFICATIONS_EMAIL_QUEUE);
  }
  return instance;
}

export async function stopBoss(): Promise<void> {
  if (instance) {
    await instance.stop({ graceful: true, timeout: 5_000 });
    instance = null;
  }
}

/** Test-only seam. Production code MUST NOT call this. */
export function setBossForTesting(b: BossLike | null): void {
  instance = b;
}
