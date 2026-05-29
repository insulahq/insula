/**
 * Unit tests for mail-admin snapshot-cronjob-reconciler.ts.
 *
 * Covers suspend gating (mail target bound ↔ suspend), schedule SSA
 * assertion (default + operator override), idempotency, the 404 Flux
 * race, and patch-failure handling.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  reconcileMailSnapshotCronJob,
  MAIL_SNAPSHOT_CRONJOB_NAME,
  MAIL_SNAPSHOT_CRONJOB_NAMESPACE,
  DEFAULT_MAIL_SNAPSHOT_SCHEDULE,
} from './snapshot-cronjob-reconciler.js';
import type { Database } from '../../db/index.js';

// Reconciler issues two selects per pass: (1) target binding,
// (2) backup_schedules.mail.cron_expression schedule. Return in order.
function fakeDb(targetRows: Array<{ enabled: number }>, scheduleRows: Array<{ v: string | null }>): Database {
  const results: unknown[][] = [targetRows, scheduleRows];
  let i = 0;
  const makeChain = (rows: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  };
  return { select: vi.fn(() => makeChain(results[i++] ?? [])) } as unknown as Database;
}

function fakeBatch(opts: { liveSuspend?: boolean; liveSchedule?: string; read404?: boolean; patchFail?: Error } = {}) {
  return {
    readNamespacedCronJob: vi.fn(async () => {
      if (opts.read404) throw { statusCode: 404 };
      return { spec: { suspend: opts.liveSuspend ?? false, schedule: opts.liveSchedule ?? DEFAULT_MAIL_SNAPSHOT_SCHEDULE } };
    }),
    patchNamespacedCronJob: vi.fn(async () => {
      if (opts.patchFail) throw opts.patchFail;
      return {};
    }),
  };
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

const suspendCalls = (batch: ReturnType<typeof fakeBatch>) =>
  batch.patchNamespacedCronJob.mock.calls.filter((c) => Array.isArray((c[0] as { body: unknown }).body));
const scheduleCalls = (batch: ReturnType<typeof fakeBatch>) =>
  batch.patchNamespacedCronJob.mock.calls.filter((c) => !Array.isArray((c[0] as { body: unknown }).body));

describe('reconcileMailSnapshotCronJob', () => {
  it('mail target bound + suspended → unsuspends (suspend=false), schedule already default → no schedule write', async () => {
    const db = fakeDb([{ enabled: 1 }], [{ v: null }]);
    const batch = fakeBatch({ liveSuspend: true, liveSchedule: DEFAULT_MAIL_SNAPSHOT_SCHEDULE });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());

    expect(r.state).toBe('STATE_OK');
    expect(r.suspended).toBe(false);
    expect(r.patched).toBe(true);
    expect(suspendCalls(batch)).toHaveLength(1);
    expect((suspendCalls(batch)[0][0] as { body: Array<{ value: boolean }> }).body[0].value).toBe(false);
    expect(scheduleCalls(batch)).toHaveLength(0);
  });

  it('no mail target → suspends (suspend=true), STATE_NO_MAIL_TARGET', async () => {
    const db = fakeDb([], [{ v: null }]);
    const batch = fakeBatch({ liveSuspend: false });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());

    expect(r.state).toBe('STATE_NO_MAIL_TARGET');
    expect(r.suspended).toBe(true);
    expect((suspendCalls(batch)[0][0] as { body: Array<{ value: boolean }> }).body[0].value).toBe(true);
  });

  it('disabled target config is treated as unbound', async () => {
    const db = fakeDb([{ enabled: 0 }], [{ v: null }]);
    const batch = fakeBatch({ liveSuspend: false });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());
    expect(r.state).toBe('STATE_NO_MAIL_TARGET');
    expect(r.suspended).toBe(true);
  });

  it('schedule drift (live */2, no override) → SSA-asserts default */30', async () => {
    const db = fakeDb([{ enabled: 1 }], [{ v: null }]);
    const batch = fakeBatch({ liveSuspend: false, liveSchedule: '*/2 * * * *' });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());

    expect(r.schedule).toBe(DEFAULT_MAIL_SNAPSHOT_SCHEDULE);
    expect(scheduleCalls(batch)).toHaveLength(1);
    const body = (scheduleCalls(batch)[0][0] as { body: { spec: { schedule: string } } }).body;
    expect(body.spec.schedule).toBe(DEFAULT_MAIL_SNAPSHOT_SCHEDULE);
    expect(suspendCalls(batch)).toHaveLength(0); // already running
  });

  it('operator override is honoured (backup_schedules.mail.cron_expression)', async () => {
    const db = fakeDb([{ enabled: 1 }], [{ v: '*/10 * * * *' }]);
    const batch = fakeBatch({ liveSuspend: false, liveSchedule: DEFAULT_MAIL_SNAPSHOT_SCHEDULE });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());

    expect(r.schedule).toBe('*/10 * * * *');
    const body = (scheduleCalls(batch)[0][0] as { body: { spec: { schedule: string } } }).body;
    expect(body.spec.schedule).toBe('*/10 * * * *');
  });

  it('idempotent: bound + running + schedule matches → no writes', async () => {
    const db = fakeDb([{ enabled: 1 }], [{ v: null }]);
    const batch = fakeBatch({ liveSuspend: false, liveSchedule: DEFAULT_MAIL_SNAPSHOT_SCHEDULE });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());
    expect(r.patched).toBe(false);
    expect(batch.patchNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('404 → STATE_NOT_INSTALLED (Flux not yet synced)', async () => {
    const db = fakeDb([{ enabled: 1 }], [{ v: null }]);
    const batch = fakeBatch({ read404: true });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());
    expect(r.state).toBe('STATE_NOT_INSTALLED');
    expect(batch.patchNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('suspend patch failure (schedule already matches) → STATE_ERROR', async () => {
    const db = fakeDb([{ enabled: 1 }], [{ v: null }]);
    const batch = fakeBatch({ liveSuspend: true, patchFail: new Error('apiserver down') });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());
    expect(r.state).toBe('STATE_ERROR');
    expect(r.errorMessage).toContain('apiserver down');
  });

  it('schedule patch failure aborts before suspend (only the schedule write is attempted)', async () => {
    const db = fakeDb([{ enabled: 1 }], [{ v: null }]);
    // schedule diverges (write attempted + fails) AND suspend would also
    // diverge — verify we abort after the schedule failure, not attempt suspend.
    const batch = fakeBatch({ liveSuspend: true, liveSchedule: '*/2 * * * *', patchFail: new Error('apiserver down') });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());
    expect(r.state).toBe('STATE_ERROR');
    expect(batch.patchNamespacedCronJob).toHaveBeenCalledTimes(1); // schedule only; suspend not reached
  });

  it('schedule drift + suspended + bound → BOTH writes in one pass', async () => {
    const db = fakeDb([{ enabled: 1 }], [{ v: null }]);
    const batch = fakeBatch({ liveSuspend: true, liveSchedule: '*/2 * * * *' });
    const r = await reconcileMailSnapshotCronJob(db, { batch } as never, log());
    expect(r.state).toBe('STATE_OK');
    expect(r.patched).toBe(true);
    expect(scheduleCalls(batch)).toHaveLength(1);
    expect(suspendCalls(batch)).toHaveLength(1);
    expect((suspendCalls(batch)[0][0] as { body: Array<{ value: boolean }> }).body[0].value).toBe(false);
  });

  it('default cadence is 30 minutes', () => {
    expect(DEFAULT_MAIL_SNAPSHOT_SCHEDULE).toBe('*/30 * * * *');
    expect(MAIL_SNAPSHOT_CRONJOB_NAME).toBe('stalwart-snapshot');
    expect(MAIL_SNAPSHOT_CRONJOB_NAMESPACE).toBe('mail');
  });
});
