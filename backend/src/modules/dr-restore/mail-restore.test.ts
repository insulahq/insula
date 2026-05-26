/**
 * Unit tests for mail-restore (Unit C.2).
 *
 * Real mail-stack restore requires a running Stalwart + Bulwark with a
 * populated PVC — that's staging E2E. These tests exercise the
 * preflight + the delegation pattern with mocked K8s clients.
 */

import { describe, it, expect, vi } from 'vitest';
import { restoreMailData, MailRestoreError } from './mail-restore.js';

const FAKE_DB = {} as never;

function makeCore(opts: { secretExists?: boolean; nodeReady?: boolean; nodeExists?: boolean }) {
  return {
    readNamespacedSecret: vi.fn(async (req: { namespace: string; name: string }) => {
      if (opts.secretExists === false) {
        const e: { code?: number } & Error = new Error('not found');
        e.code = 404;
        throw e;
      }
      return { metadata: { namespace: req.namespace, name: req.name } };
    }),
    readNode: vi.fn(async (req: { name: string }) => {
      if (opts.nodeExists === false) {
        const e: { code?: number } & Error = new Error('not found');
        e.code = 404;
        throw e;
      }
      return {
        metadata: { name: req.name },
        status: {
          conditions: [
            { type: 'Ready', status: opts.nodeReady === false ? 'False' : 'True' },
          ],
        },
      };
    }),
  };
}

describe('restoreMailData — preflight', () => {
  it('rejects empty targetMailNode', async () => {
    const core = makeCore({});
    await expect(restoreMailData({
      db: FAKE_DB,
      core: core as never,
      apps: {} as never,
      batch: {} as never,
      targetMailNode: '',
      _failoverImpl: vi.fn() as never,
    })).rejects.toThrow(/targetMailNode is required/);
  });

  it('rejects when restic Secret missing (412 — operator must run make secrets-restore)', async () => {
    const core = makeCore({ secretExists: false });
    await expect(restoreMailData({
      db: FAKE_DB,
      core: core as never,
      apps: {} as never,
      batch: {} as never,
      targetMailNode: 'node-1',
      _failoverImpl: vi.fn() as never,
    })).rejects.toMatchObject({
      name: 'MailRestoreError',
      code: 412,
      message: expect.stringContaining('make secrets-restore'),
    });
  });

  it('rejects when target node not found (412)', async () => {
    const core = makeCore({ nodeExists: false });
    await expect(restoreMailData({
      db: FAKE_DB,
      core: core as never,
      apps: {} as never,
      batch: {} as never,
      targetMailNode: 'ghost-node',
      _failoverImpl: vi.fn() as never,
    })).rejects.toThrow(/not found/);
  });

  it('rejects when target node Ready condition is not True (412)', async () => {
    const core = makeCore({ nodeReady: false });
    await expect(restoreMailData({
      db: FAKE_DB,
      core: core as never,
      apps: {} as never,
      batch: {} as never,
      targetMailNode: 'cordoned-node',
      _failoverImpl: vi.fn() as never,
    })).rejects.toThrow(/is not Ready/);
  });
});

describe('restoreMailData — happy path', () => {
  it('delegates to triggerRestoreBasedFailover after preflight passes', async () => {
    const core = makeCore({});
    const failoverImpl = vi.fn(async () => undefined);
    const result = await restoreMailData({
      db: FAKE_DB,
      core: core as never,
      apps: {} as never,
      batch: {} as never,
      targetMailNode: 'staging1',
      _failoverImpl: failoverImpl as never,
    });
    expect(failoverImpl).toHaveBeenCalledTimes(1);
    // Verify the targetNode pass-through — without this, the failover
    // pins mail to whatever systemSettings.mailActiveNode happens to be
    // (which in DR may be stale or null).
    expect(failoverImpl).toHaveBeenCalledWith('staging1', expect.objectContaining({
      db: FAKE_DB,
    }));
    expect(result.targetMailNode).toBe('staging1');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('wraps a failover failure in MailRestoreError with diagnostic hint', async () => {
    const core = makeCore({});
    const failoverImpl = vi.fn(async () => {
      throw new Error('migration state machine: deletePvcAndWait timeout');
    });
    await expect(restoreMailData({
      db: FAKE_DB,
      core: core as never,
      apps: {} as never,
      batch: {} as never,
      targetMailNode: 'staging1',
      _failoverImpl: failoverImpl as never,
    })).rejects.toMatchObject({
      name: 'MailRestoreError',
      code: 500,
      message: expect.stringContaining('mail_migration_runs'),
    });
  });
});

describe('MailRestoreError', () => {
  it('exposes the code field for the CLI runner label dispatch', () => {
    const err = new MailRestoreError('test', 412);
    expect(err.code).toBe(412);
    expect(err.name).toBe('MailRestoreError');
  });
});
