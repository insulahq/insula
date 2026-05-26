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
  /** mailPortExposureMode returned by probeClusterState (sets cluster.mailPortMode). */
  systemSettingsMode?: 'allServerNodes' | 'thisNodeOnly' | null;
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

  // probeClusterState makes TWO .select().from().limit() calls now:
  // first platform_storage_policy.tier, then system_settings.mode. The
  // mock returns them in that order via a call counter.
  let probeCallIndex = 0;
  const limitFn = vi.fn().mockImplementation(() => {
    const idx = probeCallIndex++;
    if (idx === 0) {
      if (opts.storagePolicyTier === undefined) return Promise.resolve([]);
      return Promise.resolve(opts.storagePolicyTier === null ? [] : [{ tier: opts.storagePolicyTier }]);
    }
    if (idx === 1) {
      if (opts.systemSettingsMode === undefined) return Promise.resolve([]);
      return Promise.resolve(opts.systemSettingsMode === null ? [] : [{ mode: opts.systemSettingsMode }]);
    }
    return Promise.resolve([]);
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
  apexDomain: 'staging.phoenix-host.net',
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
  // NOTE (DB review D-L4): this test verifies the IMPORTER's loop
  // sequencing against a mock, NOT the Postgres FK enforcement. The
  // real FK (backup_target_assignments.targetId → backup_configurations.id
  // ON DELETE RESTRICT, not DEFERRABLE) is exercised by Phase G of
  // scripts/integration-dr-bundle.sh, which runs the importer against
  // an ephemeral docker-postgres-18-alpine with the actual schema.
  // A future refactor that moves assignments into Promise.all would
  // pass this mock test while breaking the live FK — Phase G catches
  // that.
  it('inserts configs BEFORE assignments (FK order)', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: null, mailPortMode: null },
    });
    // After the config + assignment inserts, the importer ALSO writes
    // one audit_log row (security review M-S3). The mock dispatches
    // anything past the config budget through assignValues — so the
    // audit insert shows up as a third entry. We assert the FIRST two
    // are in the right order; the audit row is verified separately.
    expect(mocks.insertedTables[0]).toBe('backup_configurations');
    expect(mocks.insertedTables[1]).toBe('backup_target_assignments');
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
      cluster: { apex: null, platformVersion: null, topology: null, mailPortMode: null },
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
      cluster: { apex: null, platformVersion: null, topology: null, mailPortMode: null },
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
      cluster: { apex: null, platformVersion: null, topology: null, mailPortMode: null },
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
      cluster: { apex: null, platformVersion: null, topology: null, mailPortMode: null },
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
      cluster: { apex: null, platformVersion: null, topology: null, mailPortMode: null },
    })).rejects.toThrow(/FK violation/);
    // Transaction callback was invoked once + the insert promise
    // rejected — the outer txFn re-throws (no catch in our mock).
    expect(mocks.txFn).toHaveBeenCalledTimes(1);
  });
});

// ─── Drift detection ─────────────────────────────────────────────────

describe('importDrRows — drift report', () => {
  // Audit log row (security review M-S3): one row per successful
  // import, inside the same transaction so rollback also discards it.
  it('writes one audit_log row with actionType=dr_bundle_import inside the txn', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: null, mailPortMode: null },
    });
    // The audit row lands in the assignValues mock (anything past the
    // config budget is dispatched through it). Find the call that
    // carries an actionType field — that's the audit row.
    const auditCall = mocks.assignValues.mock.calls.find((c) => {
      const v = c[0] as { actionType?: string };
      return v?.actionType === 'dr_bundle_import';
    });
    expect(auditCall).toBeDefined();
    const row = auditCall![0] as Record<string, unknown>;
    expect(row.resourceType).toBe('backup_configuration');
    expect(row.actorType).toBe('system');
    const changes = row.changes as Record<string, unknown>;
    expect(changes.bundleApex).toBe(SAMPLE_INPUTS.apexDomain);
    expect(changes.configsInserted).toBeDefined();
  });

  it('returns hasDrift=false when bundle matches cluster', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    const result = await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: {
        apex: 'staging.phoenix-host.net',
        platformVersion: '0.1.0-abc1234',
        topology: 'ha',
        mailPortMode: 'haproxy',
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
      cluster: { apex: 'prod.phoenix-host.net', platformVersion: null, topology: null, mailPortMode: null },
    });
    expect(result.drift.hasDrift).toBe(true);
    expect(result.drift.notes[0]).toContain('apex');
    expect(result.drift.notes[0]).toContain('staging.phoenix-host.net');
    expect(result.drift.notes[0]).toContain('prod.phoenix-host.net');
  });

  it('detects topology mismatch (single bundle into ha cluster)', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    const singleInputs = { ...SAMPLE_INPUTS, bundleTopology: 'single' as const };
    const result = await importDrRows({
      db,
      drInputs: singleInputs,
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: 'ha', mailPortMode: null },
    });
    expect(result.drift.notes.find((n) => n.includes('topology'))).toBeDefined();
  });

  it('throws DrImportError BEFORE any INSERT when strict + drift', async () => {
    const { db, mocks } = createMockDb();
    await expect(importDrRows({
      db,
      drInputs: SAMPLE_INPUTS,
      drRows: SAMPLE_ROWS,
      cluster: { apex: 'wrong.example', platformVersion: null, topology: null, mailPortMode: null },
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
      cluster: { apex: null, platformVersion: null, topology: null, mailPortMode: null },
    });
    expect(result.drift.hasDrift).toBe(false);
  });

  // TS review M-4: mailPortMode drift must be surfaced because the
  // wrong port-exposure mode silently misconfigures the mail stack
  // (see feedback_mail_arch_changes.md).
  it('detects mailPortMode mismatch (haproxy bundle into hostport cluster)', async () => {
    const { db, mocks } = createMockDb();
    mocks.setConfigBudget(SAMPLE_ROWS.backupConfigurations.length);
    const result = await importDrRows({
      db,
      drInputs: SAMPLE_INPUTS, // bundle says 'haproxy'
      drRows: SAMPLE_ROWS,
      cluster: { apex: null, platformVersion: null, topology: null, mailPortMode: 'hostport' },
    });
    expect(result.drift.hasDrift).toBe(true);
    expect(result.drift.notes.find((n) => n.includes('mailPortMode'))).toBeDefined();
    expect(result.drift.bundleMailPortMode).toBe('haproxy');
    expect(result.drift.clusterMailPortMode).toBe('hostport');
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

  it('maps system_settings.mailPortExposureMode to the bundle enum', async () => {
    const { db: db1 } = createMockDb({ systemSettingsMode: 'allServerNodes' });
    const s1 = await probeClusterState(db1, {});
    expect(s1.mailPortMode).toBe('haproxy');
    const { db: db2 } = createMockDb({ systemSettingsMode: 'thisNodeOnly' });
    const s2 = await probeClusterState(db2, {});
    expect(s2.mailPortMode).toBe('hostport');
  });

  it('returns null mailPortMode when system_settings is empty (fresh bootstrap)', async () => {
    const { db } = createMockDb({ systemSettingsMode: null });
    const state = await probeClusterState(db, {});
    expect(state.mailPortMode).toBeNull();
  });
});
