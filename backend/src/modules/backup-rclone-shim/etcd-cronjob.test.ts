/**
 * Unit tests for backup-rclone-shim etcd-cronjob.ts (R-X7).
 *
 * Covers:
 *   - reconcile: SYSTEM bound → suspend=false (patch fires)
 *   - reconcile: SYSTEM unbound → suspend=true (patch fires if live=false)
 *   - idempotency: live already matches desired → no patch
 *   - 404 from readNamespacedCronJob → STATE_NOT_INSTALLED (Flux race)
 *   - patch failure → STATE_ERROR
 */

import { describe, expect, it, vi } from 'vitest';

import {
  reconcileEtcdCronJob,
  ETCD_CRONJOB_NAME,
  ETCD_CRONJOB_NAMESPACE,
} from './etcd-cronjob.js';
import type { Database } from '../../db/index.js';

interface FakeRow {
  enabled: number;
}

function fakeDb(rows: FakeRow[]): Database {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (rows: FakeRow[]) => unknown) => Promise.resolve(rows).then(resolve);
  return {
    select: vi.fn(() => chain),
  } as unknown as Database;
}

function fakeBatch(opts: { live?: boolean | undefined; read404?: boolean; patchFail?: Error } = {}) {
  return {
    readNamespacedCronJob: vi.fn(async () => {
      if (opts.read404) throw { statusCode: 404 };
      return { spec: { suspend: opts.live ?? true } };
    }),
    patchNamespacedCronJob: vi.fn(async () => {
      if (opts.patchFail) throw opts.patchFail;
      return {};
    }),
  };
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('reconcileEtcdCronJob', () => {
  it('SYSTEM bound + live suspend=true → patches to suspend=false', async () => {
    const db = fakeDb([{ enabled: 1 }]);
    const batch = fakeBatch({ live: true });
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.state).toBe('STATE_OK');
    expect(r.suspended).toBe(false);
    expect(r.patched).toBe(true);
    expect(batch.patchNamespacedCronJob).toHaveBeenCalledTimes(1);
    const body = (batch.patchNamespacedCronJob.mock.calls[0][0] as { body: unknown }).body;
    expect(body).toEqual([
      { op: 'replace', path: '/spec/suspend', value: false },
    ]);
  });

  it('SYSTEM unbound + live suspend=false → patches to suspend=true', async () => {
    const db = fakeDb([]);
    const batch = fakeBatch({ live: false });
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.state).toBe('STATE_NO_SYSTEM_TARGET');
    expect(r.suspended).toBe(true);
    expect(r.patched).toBe(true);
    const body = (batch.patchNamespacedCronJob.mock.calls[0][0] as { body: unknown }).body;
    expect((body as Array<{ value: boolean }>)[0].value).toBe(true);
  });

  it('idempotent: live already matches desired → no patch', async () => {
    const db = fakeDb([{ enabled: 1 }]);
    const batch = fakeBatch({ live: false }); // already running
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.state).toBe('STATE_OK');
    expect(r.patched).toBe(false);
    expect(batch.patchNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('idempotent suspend case: unbound + already suspended → no patch', async () => {
    const db = fakeDb([]);
    const batch = fakeBatch({ live: true }); // already suspended
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.state).toBe('STATE_NO_SYSTEM_TARGET');
    expect(r.patched).toBe(false);
    expect(batch.patchNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('STATE_NOT_INSTALLED when CronJob missing (Flux not yet synced)', async () => {
    const db = fakeDb([{ enabled: 1 }]);
    const batch = fakeBatch({ read404: true });
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.state).toBe('STATE_NOT_INSTALLED');
    expect(r.patched).toBe(false);
    expect(batch.patchNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('STATE_ERROR on patch failure', async () => {
    const db = fakeDb([{ enabled: 1 }]);
    const batch = fakeBatch({ live: true, patchFail: new Error('apiserver down') });
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.state).toBe('STATE_ERROR');
    expect(r.errorMessage).toContain('apiserver down');
  });

  it('ignores disabled target row (treats as unbound)', async () => {
    const db = fakeDb([{ enabled: 0 }]);
    const batch = fakeBatch({ live: false });
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.state).toBe('STATE_NO_SYSTEM_TARGET');
    expect(r.patched).toBe(true);
    const body = (batch.patchNamespacedCronJob.mock.calls[0][0] as { body: unknown }).body;
    expect((body as Array<{ value: boolean }>)[0].value).toBe(true);
  });

  it('exports canonical CronJob name + namespace constants', () => {
    expect(ETCD_CRONJOB_NAME).toBe('etcd-snap-via-shim');
    expect(ETCD_CRONJOB_NAMESPACE).toBe('platform');
  });
});
