/**
 * pg-boss singleton bootstrap.
 *
 * pg-boss installs its own schema (default 'pgboss') on first start.
 * It is safe to call `getBoss()` repeatedly — the underlying instance
 * is constructed once per process. Tests inject a fake via
 * `setBossForTesting()`.
 */
import { PgBoss } from 'pg-boss';
import { NOTIFICATIONS_EMAIL_QUEUE, NOTIFICATIONS_NTFY_QUEUE } from './types.js';

/** Minimum surface of pg-boss the rest of the queue module relies on.
 *  Lets us inject a fake in tests without polyfilling the whole class. */
export interface BossLike {
  start(): Promise<unknown>;
  stop(opts?: { graceful?: boolean; timeout?: number }): Promise<unknown>;
  createQueue(queue: string): Promise<unknown>;
  /** EventEmitter surface. Present so the mandatory 'error' listener below is
   *  type-checked; fakes may omit it (see attachErrorHandler). */
  on?(event: 'error', listener: (err: unknown) => void): unknown;
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

/**
 * pg-boss is an EventEmitter, and an EventEmitter that emits 'error' with NO
 * listener makes Node throw and KILL THE PROCESS. pg-boss's background poller
 * emits 'error' for any transient database problem, so without this listener a
 * routine Postgres restart takes platform-api down with it.
 *
 * Observed 2026-08-09 during a DR suite that restarts the CNPG cluster:
 *
 *     error: the database system is shutting down     (SQLSTATE 57P03)
 *       at async #onPoll (pg-boss/dist/navigator.js)
 *     Emitted 'error' event on PgBoss instance
 *     -> container Terminated, Reason: Error, Exit Code: 1
 *
 * That is a self-inflicted outage on every ordinary DB event — CNPG failover,
 * a minor-version upgrade, a PITR promote, a node drain. It also defeats a
 * deliberate design choice elsewhere: the liveness/readiness probe uses a
 * SHALLOW /healthz specifically "so a RUNNING pod survives a brief DB blip"
 * (backend-deployment.yaml). The pod cannot survive a blip it is killed by.
 *
 * Log and carry on: pg-boss reconnects by itself, and the delivery rows are
 * tracked in notification_deliveries with a re-enqueue scan, so a poll lost
 * during the outage is recovered rather than dropped.
 */
function attachErrorHandler(boss: BossLike): void {
  // Fakes injected by tests may not implement `on`.
  if (typeof boss.on !== 'function') return;
  boss.on('error', (err: unknown) => {
    const e = err as { code?: string; message?: string } | undefined;
    // eslint-disable-next-line no-console
    console.error(
      '[pg-boss] background error (queue keeps running, pg-boss reconnects): ' +
        `${e?.code ? `[${e.code}] ` : ''}${e?.message ?? String(err)}`,
    );
  });
}

export async function getBoss(): Promise<BossLike> {
  if (!instance) {
    instance = buildBoss();
    // BEFORE start(): the poller can emit as soon as it is running, and an
    // unhandled 'error' at that point is fatal to the process.
    attachErrorHandler(instance);
    await instance.start();
    await instance.createQueue(NOTIFICATIONS_EMAIL_QUEUE);
    await instance.createQueue(NOTIFICATIONS_NTFY_QUEUE);
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
