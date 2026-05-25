import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importDrRows, DrImportError, probeClusterState } from './db-import.js';
import { DR_BUNDLE_VERSION, type DrInputs, type DrRows } from '@k8s-hosting/api-contracts';

// ─── Mock DB ─────────────────────────────────────────────────────────
//
// importDrRows uses db.transaction → tx.insert(table).values(...)
// .onConflictDoNothing(...).returning(...). We mirror that chain with
// a configurable returning() result so tests can drive both "new
// insert" and "skip existing" paths.

interface MockOpts {
  /** Per-config-row returning result. Order matches drRows.backupConfigurations. */
  configReturns?: Array<Array<{ id: string }>>;
  /** Per-assignment-row returning result. */
  assignReturns?: Array<Array<{ targetId: string }>>;
  /** Throw from the assignment INSERT (FK violation simulation). */
  assignThrowOn?: number;
  /** Storage policy tier returned by probeClusterState (sets cluster.topology). */
  storagePolicyTier?: 'local' | 'ha' | null;
}

function createMockDb(opts: MockOpts = {}) {
  let configCursor = 0;
  let assignCursor = 0;

  const configReturning = vi.fn().mockImplementation(() => {
    const result = opts.configReturns?.[configCursor] ?? [{ id: 'mocked-id' }];
    configCursor++;
    return Promise.resolve(result);
  });
  const assignReturning = vi.fn().mockImplementation(() => {
    const idx = assignCursor++;
    if (opts.assignThrowOn === idx) {
      return Promise.reject(new Error('simulated FK violation on assignment row'));
    }
    const result = opts.assignReturns?.[idx] ?? [{ targetId: 'mocked-target' }];
    return Promise.resolve(result);
  });

  const configOnConflict = vi.fn().mockReturnValue({ returning: configReturning });
  const assignOnConflict = vi.fn().mockReturnValue({ returning: assignReturning });
  const configValues = vi.fn().mockReturnValue({ onConflictDoNothing: configOnConflict });
  const assignValues = vi.fn().mockReturnValue({ onConflictDoNothing: assignOnConflict });

  // Distinguish config vs assignment insert by call order: importDrRows
  // ALWAYS does N config inserts before any assignment insert (FK order).
  // The test fixtures hold N == drRows.backupConfigurations.length. Once
  // the config queue is exhausted, subsequent calls route to assignments.
  const insertedTables: string[] = [];
  let configBudget = 0;
  const insertFn = vi.fn().mockImplementation(() => {
    if (configBudget > 0) {
      configBudget--;
      insertedTables.push('backup_configurations');
      return { values: configValues };
    }
    insertedTables.push('backup_target_assignments');
    return { values: assignValues };
  });
  const setConfigBudget = (n: number) => { configBudget = n; };

  // probeClusterState's storage-policy lookup
  const limitFn = vi.fn().mockImplementation(() => {
    if (opts.storagePolicyTier === undefined) return Promise.resolve([]);
    return Promise.resolve(opts.storagePolicyTier === null ? [] : [{ tier: opts.storagePolicyTier }]);
  });
  const fromFn = vi.fn().mockReturnValue({ limit: limitFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  // Transaction passes the same `tx` (with insert + select). On
  // rejection the outer transaction propagates the error — we model
  // that by NOT catching here; the test asserts the throw.
  const txFn = vi.fn().mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ insert: insertFn, select: selectFn }),
  );

  return {
    db: { transaction: txFn, select: selectFn } as unknown as Parameters<typeof importDrRows>[0]['db'],
    mocks: { txFn, insertFn, configValues, assignValues, configReturning, assignReturning, insertedTables, setConfigBudget },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────

const SAMPLE_INPUTS: DrInputs = {
  drBundleVersion: DR_BUNDLE_VERSION,
  createdAt: '2026-05-25T20:00:00.000Z',
  apexDomain: 'staging.example.test',
  clusterName: 'staging',
  meshCidr: '10.42.0.0/16',
  platformVersion: '0.1.0-abc1234',
  cnpgClusters: [],
  mailPortMode: 'haproxy',
  bundleTopology: 'ha',
};

const SAMPLE_CONFIG = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'Test Target',
  storageType: 's3' as const,
  sshHost: null, sshPort: null, sshUser: null,
  sshKeyEncrypted: null, sshPasswordEncrypted: null, sshPath: null,
  s3Endpoint: 'https://s3.example.com',
  s3Bucket: 'backups', s3Region: 'eu-west-1',
  s3AccessKeyEncrypted: 'enc-access',
  s3SecretKeyEncrypted: 'enc-secret',
  s3Prefix: 'prod/', s3UsePathStyle: true,
  cifsHost: null, cifsPort: null, cifsShare: null, cifsUser: null,
  cifsPasswordEncrypted: null, cifsDomain: null, cifsPath: null,
  retentionDays: 30,
  scheduleExpression: '0 2 * * *',
  enabled: 0,  // DISABLED — verify importer preserves this (D-L4)
  active: false,
  drainTimeoutSeconds: 300,
  readOnly: true as const,
};

const SAMPLE_ASSIGN = {
  backupClass: 'system' as const,
  targetId: '11111111-2222-4333-8444-555555555555',
  priority: 0,
};

const SAMPLE_ROWS: DrRows = {
  drBundleVersion: DR_BUNDLE_VERSION,
  createdAt: '2026-05-25T20:00:00.000Z',
  backupConfigurations: [SAMPLE_CONFIG],
  backupTargetAssignments: [SAMPLE_ASSIGN],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── importDrRows ────────────────────────────────────────────────────

describe('importDrRows — invariants', () => {
  it('inserts configs BEFORE assignments (FK order)', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: null },
    });
    expect(mocks.insertedTables).toEqual(['backup_configurations', 'backup_target_assignments']);
  });

  it('forces readOnly=true and active=false on every config row', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    // Even if the Zod schema let a writable row through (it doesn't, but
    // defense in depth), the row mapper MUST force these invariants.
    await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: null },
    });
    const inserted = mocks.configValues.mock.calls[0][0];
    expect(inserted.readOnly).toBe(true);
    expect(inserted.active).toBe(false);
  });

  it('preserves source `enabled` value (does NOT force enabled=1)', async () => {
    // Per DB review D-L4: a disabled target must stay disabled on
    // import; operator reviews before flipping. The fixture above has
    // enabled=0 — verify it's passed through unchanged.
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: null },
    });
    const inserted = mocks.configValues.mock.calls[0][0];
    expect(inserted.enabled).toBe(0);
  });

  it('propagates encrypted credential blobs verbatim', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: null },
    });
    const inserted = mocks.configValues.mock.calls[0][0];
    expect(inserted.s3AccessKeyEncrypted).toBe('enc-access');
    expect(inserted.s3SecretKeyEncrypted).toBe('enc-secret');
  });

  it('counts inserted vs skipped-existing rows', async () => {
    const { db, mocks } = createMockDb({
      // First config returns a row (new insert); second returns empty (skipped).
      configReturns: [[{ id: 'a' }], []],
      assignReturns: [[{ targetId: 'a' }]],
    });
    mocks.setConfigBudget(2);  // 2 configs in the test fixture below
    const result = await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: {
        ...SAMPLE_ROWS,
        backupConfigurations: [SAMPLE_CONFIG, { ...SAMPLE_CONFIG, id: '22222222-3333-4444-8555-666666666666' }],
      },
      cluster: { apex: null, platformVersion: null, topology: null },
    });
    expect(result.configsInserted).toBe(1);
    expect(result.configsSkippedExisting).toBe(1);
    expect(result.assignmentsInserted).toBe(1);
  });

  it('rolls back the transaction on assignment FK failure', async () => {
    const { db, mocks } = createMockDb({ assignThrowOn: 0 });
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    await expect(importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: null },
    })).rejects.toThrow(/FK violation/);
    // Transaction callback was invoked once + the insert promise
    // rejected — the outer txFn re-throws (no catch in our mock).
    expect(mocks.txFn).toHaveBeenCalledTimes(1);
  });
});

// ─── Drift detection ─────────────────────────────────────────────────

describe('importDrRows — drift report', () => {
  it('returns hasDrift=false when bundle matches cluster', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    const result = await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: {
        apex: 'staging.example.test',
        platformVersion: '0.1.0-abc1234',
        topology: 'ha',
      },
    });
    expect(result.drift.hasDrift).toBe(false);
    expect(result.drift.notes).toEqual([]);
  });

  it('detects apex mismatch', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    const result = await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: 'prod.example.test', platformVersion: null, topology: null },
    });
    expect(result.drift.hasDrift).toBe(true);
    expect(result.drift.notes[0]).toContain('apex');
    expect(result.drift.notes[0]).toContain('staging.example.test');
    expect(result.drift.notes[0]).toContain('prod.example.test');
  });

  it('detects topology mismatch (single bundle into ha cluster)', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    const singleInputs = { ...SAMPLE_INPUTS, bundleTopology: 'single' as const };
    const result = await importDrRows({
      db,
      drInputs: singleInputs,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: 'ha' },
    });
    expect(result.drift.notes.find((n) => n.includes('topology'))).toBeDefined();
  });

  it('throws DrImportError BEFORE any INSERT when strict + drift', async () => {
    const { db, mocks } = createMockDb();
    await expect(importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: 'wrong.example', platformVersion: null, topology: null },
      strict: true,
    })).rejects.toThrowError(DrImportError);
    expect(mocks.txFn).not.toHaveBeenCalled();
  });

  it('treats null cluster fields as no-mismatch (fresh bootstrap)', async () => {
    // On a freshly bootstrapped box, platform_storage_policy may have
    // no rows yet. probeClusterState returns null; drift detector
    // treats that as "unknown" rather than "definitely a mismatch."
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    const result = await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: null },
    });
    expect(result.drift.hasDrift).toBe(false);
  });
});

// ─── probeClusterState ───────────────────────────────────────────────

describe('probeClusterState', () => {
  it('reads apex + version from config and topology from DB', async () => {
    const { db } = createMockDb({ storagePolicyTier: 'ha' });
    const state = await probeClusterState(db, {
      PLATFORM_BASE_DOMAIN: 'test.example.com',
      PLATFORM_VERSION: '0.1.0-deadbeef',
    });
    expect(state.apex).toBe('test.example.com');
    expect(state.platformVersion).toBe('0.1.0-deadbeef');
    expect(state.topology).toBe('ha');
  });

  it('returns null topology when storage policy row is missing', async () => {
    const { db } = createMockDb({ storagePolicyTier: null });
    const state = await probeClusterState(db, { PLATFORM_BASE_DOMAIN: 'x.example' });
    expect(state.topology).toBeNull();
  });

  it('falls back to INGRESS_BASE_DOMAIN when PLATFORM_BASE_DOMAIN is absent', async () => {
    const { db } = createMockDb();
    const state = await probeClusterState(db, { INGRESS_BASE_DOMAIN: 'legacy.example' });
    expect(state.apex).toBe('legacy.example');
  });

  it('maps storage tier "local" to topology "single"', async () => {
    const { db } = createMockDb({ storagePolicyTier: 'local' });
    const state = await probeClusterState(db, {});
    expect(state.topology).toBe('single');
  });
});
