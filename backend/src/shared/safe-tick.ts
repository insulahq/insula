/**
 * safeTick — run a scheduler tick as fire-and-forget WITHOUT letting a rejection
 * kill the process.
 *
 * The bug this exists to prevent, observed on DEV 2026-08-09:
 *
 *     Error: Connection terminated due to connection timeout
 *       at loadAlreadyNotifiedKeys (modules/cnpg-backup-health/scheduler.js:94)
 *       at runTick (modules/cnpg-backup-health/scheduler.js:82)
 *     exitCode: 1, reason: Error
 *
 * platform-api died mid-PITR because a scheduler tick was launched as
 * `void runTick(...)`. The `void` operator DISCARDS the promise, so a rejection
 * inside the tick has no handler and Node terminates the process. The tick had a
 * try/catch — around its Kubernetes read, not around the DB query that actually
 * failed. Partial guarding reads as guarded.
 *
 * This is the same class as the pg-boss / pg.Pool `'error'` listeners added the
 * same day, and NOT covered by them: those catch EMITTED error events on an
 * EventEmitter, while this is an unhandled promise rejection. Auditing for one
 * does not find the other, which is why the second wave outlived the first fix.
 *
 * Consequence beyond the crash: schedulers own in-process work. When the process
 * dies mid-flight, rows that only that process would have finalised are left
 * behind — the 2026-08-09 crash is why a completed PITR's task chip was never
 * written (`chip.status=''`), failing a suite for a restore that had in fact
 * succeeded.
 *
 * A tick that throws is a bug worth seeing, so failures are logged loudly — they
 * are simply not worth terminating the API for. An ordinary CNPG failover, minor
 * upgrade, PITR promote or node drain must not take the platform down.
 */

export interface TickLogger {
  readonly warn: (msg: string, err?: unknown) => void;
}

/**
 * Launch `fn()` fire-and-forget with a terminal catch attached.
 *
 * @param name  scheduler name, used in the log line so a recurring failure is
 *              attributable without a stack trace.
 * @param fn    the tick. May reject; that is the whole point.
 * @param log   destination for failures. Defaults to console.warn so a caller
 *              without a logger still cannot crash the process.
 */
export function safeTick(
  name: string,
  fn: () => Promise<unknown>,
  log?: TickLogger,
): void {
  const warn = log?.warn
    // eslint-disable-next-line no-console
    ?? ((msg: string, err?: unknown) => console.warn(msg, err ?? ''));
  try {
    void fn().catch((err: unknown) => {
      warn(`[${name}] tick failed (continuing — a scheduler tick must never terminate the API)`, err);
    });
  } catch (err) {
    // A tick that throws SYNCHRONOUSLY never produces a promise, so the .catch
    // above is never reached. Rare, but it is the same fatal outcome.
    warn(`[${name}] tick threw synchronously (continuing)`, err);
  }
}
