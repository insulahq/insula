/**
 * Unit tests for backup-rclone-shim etcd-cronjob.ts (R-X7).
 *
 * Covers:
 *   - reconcile: SYSTEM bound → suspend=false (patch fires)
 *   - reconcile: SYSTEM unbound → suspend=true (patch fires if live=false)
 *   - idempotency: live already matches desired → no patch
 *   - 404 from readNamespacedCronJob → STATE_NOT_INSTALLED (Flux race)
 *   - patch failure → STATE_ERROR
 *   - cluster_id namespacing: SHIM_PREFIX patched to `etcd/<cluster_id>` on
 *     drift; left alone once converged; combined with the suspend toggle.
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

/**
 * A drizzle-ish DB double that answers BOTH queries the reconciler issues:
 *   - getClusterId()'s `select({ value }).from(platform_settings)` → the
 *     fixed cluster_id (routed by the `value` projection key).
 *   - isSystemTargetBound()'s `select({ enabled })…` → the supplied rows.
 * Includes a no-op `insert().values().onConflictDoNothing()` so getClusterId's
 * generate-once branch never throws even when the read returns the cluster_id.
 */
function fakeDb(rows: FakeRow[], clusterId = 'test-cluster-uuid'): Database {
  const makeChain = (result: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
      chain[m] = vi.fn(() => chain);
    }
    chain.then = (resolve: (r: unknown[]) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  };
  return {
    select: vi.fn((proj?: Record<string, unknown>) => {
      // getClusterId projects { value }; isSystemTargetBound projects { enabled }.
      if (proj && Object.prototype.hasOwnProperty.call(proj, 'value')) {
        return makeChain([{ value: clusterId }]);
      }
      return makeChain(rows);
    }),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => Promise.resolve()) })),
    })),
  } as unknown as Database;
}

function fakeBatch(
  opts: {
    live?: boolean | undefined;
    read404?: boolean;
    patchFail?: Error;
    /** When set, the live CronJob carries a `rclone` container with a
     *  SHIM_PREFIX env of this value (container 0, env 0). */
    prefixEnv?: string;
  } = {},
) {
  return {
    readNamespacedCronJob: vi.fn(async () => {
      if (opts.read404) throw { statusCode: 404 };
      const spec: Record<string, unknown> = { suspend: opts.live ?? true };
      if (opts.prefixEnv !== undefined) {
        spec.jobTemplate = {
          spec: {
            template: {
              spec: {
                containers: [
                  { name: 'rclone', env: [{ name: 'SHIM_PREFIX', value: opts.prefixEnv }] },
                ],
              },
            },
          },
        };
      }
      return { spec };
    }),
    patchNamespacedCronJob: vi.fn(async () => {
      if (opts.patchFail) throw opts.patchFail;
      return {};
    }),
  };
}

const SHIM_PREFIX_PATH = '/spec/jobTemplate/spec/template/spec/containers/0/env/0/value';

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

  it('namespaces SHIM_PREFIX to etcd/<cluster_id> when the live prefix is the legacy seed', async () => {
    const db = fakeDb([{ enabled: 1 }], 'cid-123');
    // Already running (suspend=false) so the only drift is the legacy prefix.
    const batch = fakeBatch({ live: false, prefixEnv: 'etcd' });
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.patched).toBe(true);
    const body = (batch.patchNamespacedCronJob.mock.calls[0][0] as { body: unknown }).body;
    expect(body).toEqual([
      { op: 'replace', path: SHIM_PREFIX_PATH, value: 'etcd/cid-123' },
    ]);
  });

  it('no prefix patch when SHIM_PREFIX already equals etcd/<cluster_id>', async () => {
    const db = fakeDb([{ enabled: 1 }], 'cid-123');
    const batch = fakeBatch({ live: false, prefixEnv: 'etcd/cid-123' });
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.patched).toBe(false);
    expect(batch.patchNamespacedCronJob).not.toHaveBeenCalled();
  });

  it('patches BOTH suspend and SHIM_PREFIX when both drift', async () => {
    const db = fakeDb([{ enabled: 1 }], 'cid-9');
    // Suspended (must flip to false) AND legacy prefix (must namespace).
    const batch = fakeBatch({ live: true, prefixEnv: 'etcd' });
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.patched).toBe(true);
    const body = (batch.patchNamespacedCronJob.mock.calls[0][0] as { body: unknown }).body;
    expect(body).toEqual([
      { op: 'replace', path: '/spec/suspend', value: false },
      { op: 'replace', path: SHIM_PREFIX_PATH, value: 'etcd/cid-9' },
    ]);
  });

  it('suspend-only patch is unchanged when the CronJob carries no SHIM_PREFIX env (Flux race)', async () => {
    // A CronJob read before its env is populated → no prefix op, suspend still fires.
    const db = fakeDb([{ enabled: 1 }], 'cid-7');
    const batch = fakeBatch({ live: true }); // no prefixEnv → no jobTemplate
    const r = await reconcileEtcdCronJob(db, { batch } as never, silentLog());

    expect(r.patched).toBe(true);
    const body = (batch.patchNamespacedCronJob.mock.calls[0][0] as { body: unknown }).body;
    expect(body).toEqual([
      { op: 'replace', path: '/spec/suspend', value: false },
    ]);
  });

  it('exports canonical CronJob name + namespace constants', () => {
    expect(ETCD_CRONJOB_NAME).toBe('etcd-snap-via-shim');
    expect(ETCD_CRONJOB_NAMESPACE).toBe('platform');
  });
});
