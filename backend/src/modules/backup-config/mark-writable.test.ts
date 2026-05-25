import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../../shared/errors.js';

// Mock resumeCnpgArchiving so unit tests don't dial the cluster.
const resumeMock = vi.fn().mockResolvedValue(true);
vi.mock('../system-backup/wal-suspend.js', () => ({
  resumeCnpgArchiving: (...args: unknown[]) => resumeMock(...args),
}));

const { markBackupTargetWritable } = await import('./mark-writable.js');

const TARGET_ROW = {
  id: 'cfg-1',
  name: 'Hetzner SSH',
  storageType: 'ssh' as const,
  readOnly: true,
};

const WAL_ROWS_NONE: Array<{ clusterNamespace: string; clusterName: string }> = [];

interface MockDbOpts {
  target?: typeof TARGET_ROW | null;
  archivingClusters?: Array<{ clusterNamespace: string; clusterName: string }>;
  bindings?: Array<{ backupClass: string }>;
}

function createMockDb(opts: MockDbOpts = {}) {
  const target = opts.target === undefined ? TARGET_ROW : opts.target;
  const archivingClusters = opts.archivingClusters ?? WAL_ROWS_NONE;
  const bindings = opts.bindings ?? [];

  let queryCount = 0;
  const limitFn = vi.fn().mockImplementation(() => Promise.resolve(target ? [target] : []));
  const whereSelect = vi.fn().mockImplementation(() => {
    queryCount++;
    const chain: PromiseLike<unknown[]> & { limit: typeof limitFn } = {
      limit: limitFn,
      then: (onFulfilled, onRejected) => {
        // Second/third queries return archivingClusters / bindings
        // depending on the order of execution in markBackupTargetWritable.
        if (queryCount === 2) {
          return Promise.resolve(archivingClusters).then(onFulfilled, onRejected);
        }
        if (queryCount === 3) {
          return Promise.resolve(bindings).then(onFulfilled, onRejected);
        }
        return Promise.resolve([]).then(onFulfilled, onRejected);
      },
    };
    return chain;
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereSelect });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  // UPDATE chain: .set(...).where(...).returning(...) — returns one
  // affected row by default so the TOCTOU mismatch branch only fires
  // when a test sets updateReturning=[].
  const updateReturning = opts.target ? [{ id: opts.target ? (opts.target as { id: string }).id : 'cfg-1' }] : [{ id: 'cfg-1' }];
  const updateReturningFn = vi.fn().mockResolvedValue(updateReturning);
  const updateWhereFn = vi.fn().mockReturnValue({ returning: updateReturningFn });
  const updateSetFn = vi.fn().mockReturnValue({ where: updateWhereFn });
  const updateFn = vi.fn().mockReturnValue({ set: updateSetFn });

  const insertValuesFn = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValuesFn });

  const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ update: updateFn, insert: insertFn }),
  );

  return {
    db: {
      select: selectFn,
      transaction: txFn,
    } as unknown as Parameters<typeof markBackupTargetWritable>[0]['db'],
    mocks: { selectFn, updateFn, updateSetFn, insertFn, insertValuesFn, txFn, updateReturningFn },
  };
}

function fakeK8s() {
  return { custom: { patchNamespacedCustomObject: vi.fn() } } as unknown as Parameters<typeof markBackupTargetWritable>[0]['k8s'];
}

beforeEach(() => {
  resumeMock.mockClear();
});

describe('markBackupTargetWritable', () => {
  it('throws BACKUP_CONFIG_NOT_FOUND when target is missing', async () => {
    const { db } = createMockDb({ target: null });
    await expect(markBackupTargetWritable({
      db, k8s: fakeK8s(), targetId: 'missing', confirmation: 'whatever',
      operatorUserId: 'u-1', operatorIp: null,
    })).rejects.toMatchObject({ code: 'BACKUP_CONFIG_NOT_FOUND', status: 404 });
  });

  it('throws CONFIRMATION_MISMATCH when typed name does not match target name (case-sensitive)', async () => {
    const { db } = createMockDb({ target: TARGET_ROW });
    await expect(markBackupTargetWritable({
      db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'hetzner ssh', // wrong case
      operatorUserId: 'u-1', operatorIp: null,
    })).rejects.toMatchObject({ code: 'CONFIRMATION_MISMATCH', status: 400 });
  });

  it('refuses generic ApiError (not 500) on confirmation mismatch — does NOT leak the expected value', async () => {
    const { db } = createMockDb({ target: TARGET_ROW });
    try {
      await markBackupTargetWritable({
        db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'GUESS',
        operatorUserId: 'u-1', operatorIp: null,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const e = err as ApiError;
      expect(e.message).not.toContain('Hetzner SSH');
    }
  });

  it('flips read_only=false + writes audit log on successful confirmation', async () => {
    const { db, mocks } = createMockDb({ target: TARGET_ROW });
    const result = await markBackupTargetWritable({
      db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'Hetzner SSH',
      operatorUserId: 'admin-42', operatorIp: '10.0.0.5',
    });
    expect(result.targetId).toBe('cfg-1');
    expect(result.targetName).toBe('Hetzner SSH');
    // Update was called inside a transaction; the transaction mock
    // passes the same update/insert mocks through.
    expect(mocks.updateSetFn).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
    expect(mocks.insertValuesFn).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'backup_target_mark_writable',
      resourceType: 'backup_configuration',
      resourceId: 'cfg-1',
      actorId: 'admin-42',
      ipAddress: '10.0.0.5',
    }));
  });

  it('calls resumeCnpgArchiving once per CNPG cluster routing through the target', async () => {
    const { db } = createMockDb({
      target: TARGET_ROW,
      archivingClusters: [
        { clusterNamespace: 'platform', clusterName: 'system-db' },
        { clusterNamespace: 'mail', clusterName: 'mail-pg' },
      ],
    });
    const k8s = fakeK8s();
    const result = await markBackupTargetWritable({
      db, k8s, targetId: 'cfg-1', confirmation: 'Hetzner SSH',
      operatorUserId: 'u-1', operatorIp: null,
    });
    expect(resumeMock).toHaveBeenCalledTimes(2);
    expect(resumeMock).toHaveBeenCalledWith(k8s, 'platform', 'system-db');
    expect(resumeMock).toHaveBeenCalledWith(k8s, 'mail', 'mail-pg');
    expect(result.cnpgArchivingResumed).toHaveLength(2);
  });

  it('does not throw when resumeCnpgArchiving fails — reports per-cluster outcome', async () => {
    resumeMock.mockRejectedValueOnce(new Error('cluster gone'));
    const { db } = createMockDb({
      target: TARGET_ROW,
      archivingClusters: [{ clusterNamespace: 'platform', clusterName: 'system-db' }],
    });
    const result = await markBackupTargetWritable({
      db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'Hetzner SSH',
      operatorUserId: 'u-1', operatorIp: null,
    });
    expect(result.cnpgArchivingResumed[0].wasAlreadyAttached).toBe(false);
  });

  it('flags mailReconcilerTriggered=true when target is bound to the mail class', async () => {
    const { db } = createMockDb({
      target: TARGET_ROW,
      bindings: [{ backupClass: 'mail' }],
    });
    const result = await markBackupTargetWritable({
      db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'Hetzner SSH',
      operatorUserId: 'u-1', operatorIp: null,
    });
    expect(result.mailReconcilerTriggered).toBe(true);
  });

  it('flags mailReconcilerTriggered=false when target only carries non-mail bindings', async () => {
    const { db } = createMockDb({
      target: TARGET_ROW,
      bindings: [{ backupClass: 'system' }, { backupClass: 'tenant' }],
    });
    const result = await markBackupTargetWritable({
      db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'Hetzner SSH',
      operatorUserId: 'u-1', operatorIp: null,
    });
    expect(result.mailReconcilerTriggered).toBe(false);
  });

  it('idempotent: target already writable -> early return + NO audit log written + NO CNPG resume', async () => {
    const alreadyWritable = { ...TARGET_ROW, readOnly: false };
    const { db, mocks } = createMockDb({ target: alreadyWritable });
    const result = await markBackupTargetWritable({
      db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'Hetzner SSH',
      operatorUserId: 'u-1', operatorIp: null,
    });
    expect(result.targetId).toBe('cfg-1');
    expect(result.cnpgArchivingResumed).toEqual([]);
    expect(result.mailReconcilerTriggered).toBe(false);
    expect(mocks.insertValuesFn).not.toHaveBeenCalled();
    expect(mocks.txFn).not.toHaveBeenCalled();
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('TOCTOU rename race: UPDATE WHERE id=$1 AND name=$2 returns 0 rows -> CONFIRMATION_MISMATCH', async () => {
    const { db, mocks } = createMockDb({ target: TARGET_ROW });
    mocks.updateReturningFn.mockResolvedValueOnce([]); // simulate name changed between SELECT and UPDATE
    try {
      await markBackupTargetWritable({
        db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'Hetzner SSH',
        operatorUserId: 'u-1', operatorIp: null,
      });
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as ApiError;
      expect(e.code).toBe('CONFIRMATION_MISMATCH');
      expect(e.status).toBe(400);
      // Same generic message — leaks nothing about the new name.
      expect(e.message).not.toContain('Hetzner SSH');
    }
  });

  it('forensic capture: audit log row carries jti + userAgent when provided', async () => {
    const { db, mocks } = createMockDb({ target: TARGET_ROW });
    await markBackupTargetWritable({
      db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'Hetzner SSH',
      operatorUserId: 'u-1', operatorIp: '203.0.113.5',
      operatorJti: 'jti-abc-123', operatorUserAgent: 'Mozilla/5.0 (test)',
    });
    expect(mocks.insertValuesFn).toHaveBeenCalledWith(expect.objectContaining({
      changes: expect.objectContaining({
        operatorJti: 'jti-abc-123',
        operatorUserAgent: 'Mozilla/5.0 (test)',
      }),
    }));
  });

  it('audit log row carries operatorJti/UserAgent=null when caller omits them', async () => {
    const { db, mocks } = createMockDb({ target: TARGET_ROW });
    await markBackupTargetWritable({
      db, k8s: fakeK8s(), targetId: 'cfg-1', confirmation: 'Hetzner SSH',
      operatorUserId: 'u-1', operatorIp: null,
    });
    expect(mocks.insertValuesFn).toHaveBeenCalledWith(expect.objectContaining({
      changes: expect.objectContaining({
        operatorJti: null,
        operatorUserAgent: null,
      }),
    }));
  });
});
