import { describe, it, expect, vi } from 'vitest';
import {
  buildDrInputs,
  buildDrRows,
  parseDrInputs,
  parseDrRows,
  serializeDrInputs,
  serializeDrRows,
  BundleVersionError,
} from './dr-sidecars.js';
import { DR_BUNDLE_VERSION } from '@insula/api-contracts';

// ─── Shared mock-DB helper ───────────────────────────────────────────

interface MockDbOpts {
  configRows?: Array<Record<string, unknown>>;
  assignmentRows?: Array<Record<string, unknown>>;
  systemSettingsMode?: 'allServerNodes' | 'thisNodeOnly' | null;
  storagePolicyTier?: 'local' | 'ha' | null;
}

function createMockDb(opts: MockDbOpts = {}) {
  // Track call order so we can route .from(<table>) → the right result.
  // We don't have real Drizzle table references in mocks; instead we
  // index by call order matching the builder's exact sequence:
  //   buildDrInputs: systemSettings → platformStoragePolicy (lazy)
  //   buildDrRows:   backupConfigurations → backupTargetAssignments
  const callQueue: Array<unknown> = [];
  if (opts.systemSettingsMode !== undefined) {
    callQueue.push(opts.systemSettingsMode === null
      ? []
      : [{ mode: opts.systemSettingsMode }]);
  }
  if (opts.storagePolicyTier !== undefined) {
    callQueue.push(opts.storagePolicyTier === null
      ? []
      : [{ tier: opts.storagePolicyTier }]);
  }
  if (opts.configRows !== undefined) {
    callQueue.push(opts.configRows);
  }
  if (opts.assignmentRows !== undefined) {
    callQueue.push(opts.assignmentRows);
  }

  let cursor = 0;
  const limitFn = vi.fn().mockImplementation(() => {
    return Promise.resolve(callQueue[cursor++] ?? []);
  });
  const fromFn = vi.fn().mockImplementation(() => {
    // Some calls chain .from().limit() (selects with limit), others
    // chain just .from() and resolve directly (selects without limit
    // for whole-table reads). Use a thenable + limit shape.
    const result = callQueue[cursor] ?? [];
    const chain: PromiseLike<unknown[]> & { limit: typeof limitFn } = {
      limit: limitFn,
      then: (onFulfilled, onRejected) => {
        const r = callQueue[cursor++];
        return Promise.resolve(r ?? []).then(onFulfilled, onRejected);
      },
    };
    return chain;
  });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  // buildDrRows now wraps both selects in db.transaction(). The mock
  // tx exposes the same select chain so the existing fixture works
  // transparently — the tx callback runs synchronously against the
  // same queue cursor.
  const txFn = vi.fn().mockImplementation(async (cb: (tx: { select: typeof selectFn }) => unknown) =>
    cb({ select: selectFn }),
  );
  return {
    db: { select: selectFn, transaction: txFn } as unknown as Parameters<typeof buildDrRows>[0],
  };
}

// ─── k8s mock helpers ───────────────────────────────────────────────

function k8sWithCidr(cidr: string | null) {
  return {
    core: {
      readNamespacedConfigMap: vi.fn().mockImplementation(() => {
        if (cidr === null) return Promise.reject(new Error('cm not found'));
        return Promise.resolve({ data: { POD_CIDR: cidr } });
      }),
    },
    custom: {},
  } as unknown as Parameters<typeof buildDrInputs>[0]['k8s'];
}

function makeClusterCRReader(plugins: Array<{ name?: string; parameters?: Record<string, string> }> | null) {
  return {
    readClusterCR: vi.fn().mockResolvedValue(
      plugins === null ? null : { spec: { plugins } },
    ),
  };
}

// ─── buildDrInputs ──────────────────────────────────────────────────

describe('buildDrInputs', () => {
  it('emits a schema-valid v1 record with all fields populated', async () => {
    const { db } = createMockDb({
      systemSettingsMode: 'allServerNodes',
      storagePolicyTier: 'ha',
    });
    const reader = makeClusterCRReader([
      { name: 'barman-cloud.cloudnative-pg.io', parameters: { barmanObjectName: 'system-db-objectstore' } },
    ]);
    const result = await buildDrInputs({
      db,
      k8s: k8sWithCidr('10.42.0.0/16'),
      config: { PLATFORM_BASE_DOMAIN: 'staging.phoenix-host.net', PLATFORM_VERSION: '0.1.0-abc1234' },
      clusterCRReader: reader,
    });
    expect(result.drBundleVersion).toBe(DR_BUNDLE_VERSION);
    expect(result.apexDomain).toBe('staging.phoenix-host.net');
    expect(result.clusterName).toBe('staging');
    expect(result.platformVersion).toBe('0.1.0-abc1234');
    expect(result.meshCidr).toBe('10.42.0.0/16');
    expect(result.mailPortMode).toBe('haproxy');
    expect(result.bundleTopology).toBe('ha');
    expect(result.cnpgClusters).toHaveLength(1);
    expect(result.cnpgClusters[0]).toEqual({
      namespace: 'platform',
      clusterName: 'system-db',
      serverName: 'system-db',
      objectStoreName: 'system-db-objectstore',
    });
  });

  it('falls back to safe defaults when env + tables are sparse', async () => {
    const { db } = createMockDb({}); // no rows
    const reader = makeClusterCRReader(null); // cluster CR missing
    const result = await buildDrInputs({
      db,
      k8s: k8sWithCidr(null), // CM missing -> default 10.42.0.0/16
      config: {}, // no env
      clusterCRReader: reader,
    });
    expect(result.apexDomain).toBe('unknown.example');
    expect(result.clusterName).toBe('unknown');
    expect(result.platformVersion).toBe('0.0.0');
    expect(result.meshCidr).toBe('10.42.0.0/16');
    expect(result.mailPortMode).toBe('haproxy'); // safe default per A2 spec
    expect(result.bundleTopology).toBe('single');
    expect(result.cnpgClusters).toEqual([]);
  });

  it('emits hostport mode when systemSettings says thisNodeOnly', async () => {
    const { db } = createMockDb({ systemSettingsMode: 'thisNodeOnly' });
    const reader = makeClusterCRReader(null);
    const result = await buildDrInputs({
      db,
      k8s: k8sWithCidr('10.42.0.0/16'),
      config: { PLATFORM_BASE_DOMAIN: 'test.example' },
      clusterCRReader: reader,
    });
    expect(result.mailPortMode).toBe('hostport');
  });

  it('omits cnpgClusters entry when the cluster has no barman plugin attached', async () => {
    const { db } = createMockDb({});
    const reader = makeClusterCRReader([
      { name: 'some-other-plugin', parameters: {} },
    ]);
    const result = await buildDrInputs({
      db,
      k8s: k8sWithCidr('10.42.0.0/16'),
      config: { PLATFORM_BASE_DOMAIN: 'test.example' },
      clusterCRReader: reader,
    });
    expect(result.cnpgClusters).toEqual([]);
  });

  it('emits ISO-8601 createdAt within the last few seconds', async () => {
    const { db } = createMockDb({});
    const reader = makeClusterCRReader(null);
    const before = Date.now();
    const result = await buildDrInputs({
      db,
      k8s: k8sWithCidr('10.42.0.0/16'),
      config: { PLATFORM_BASE_DOMAIN: 'test.example' },
      clusterCRReader: reader,
    });
    const after = Date.now();
    const created = new Date(result.createdAt).getTime();
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(after);
  });
});

// ─── buildDrRows ────────────────────────────────────────────────────

const SAMPLE_CFG_ROW = {
  id: '11111111-2222-4333-8444-555555555555',
  name: 'Hetzner SSH',
  storageType: 'ssh' as const,
  sshHost: 'backup.example.com',
  sshPort: 22,
  sshUser: 'backupuser',
  sshKeyEncrypted: 'AES256:abc123',
  sshPasswordEncrypted: null,
  sshPath: '/backups',
  s3Endpoint: null,
  s3Bucket: null,
  s3Region: null,
  s3AccessKeyEncrypted: null,
  s3SecretKeyEncrypted: null,
  s3Prefix: null,
  s3UsePathStyle: true,
  cifsHost: null,
  cifsPort: null,
  cifsShare: null,
  cifsUser: null,
  cifsPasswordEncrypted: null,
  cifsDomain: null,
  cifsPath: null,
  retentionDays: 30,
  scheduleExpression: '0 2 * * *',
  enabled: 1,
  active: false,
  drainTimeoutSeconds: 300,
  readOnly: false, // INPUT: cluster's live state (writable); builder FORCES this to true on export
};

const SAMPLE_ASSIGNMENT_ROW = {
  backupClass: 'system' as const,
  targetId: '11111111-2222-4333-8444-555555555555',
  priority: 0,
};

describe('buildDrRows', () => {
  it('serialises rows with readOnly forced to true regardless of source', async () => {
    const { db } = createMockDb({
      configRows: [SAMPLE_CFG_ROW],
      assignmentRows: [SAMPLE_ASSIGNMENT_ROW],
    });
    const result = await buildDrRows(db);
    expect(result.drBundleVersion).toBe(DR_BUNDLE_VERSION);
    expect(result.backupConfigurations).toHaveLength(1);
    expect(result.backupConfigurations[0].readOnly).toBe(true);
    expect(result.backupConfigurations[0].name).toBe('Hetzner SSH');
    expect(result.backupConfigurations[0].sshKeyEncrypted).toBe('AES256:abc123');
    expect(result.backupTargetAssignments).toHaveLength(1);
    expect(result.backupTargetAssignments[0]).toEqual(SAMPLE_ASSIGNMENT_ROW);
  });

  it('emits empty arrays when no rows exist', async () => {
    const { db } = createMockDb({
      configRows: [],
      assignmentRows: [],
    });
    const result = await buildDrRows(db);
    expect(result.backupConfigurations).toEqual([]);
    expect(result.backupTargetAssignments).toEqual([]);
  });

  // Documenting intentional behavior: the Zod schemas have NO
  // cross-array FK constraint. The transaction wrapping in
  // buildDrRows prevents the orphan-assignment scenario at write
  // time (REPEATABLE READ snapshot), but Unit B's importer must
  // still INSERT configs before assignments to honor the live
  // FK (ON DELETE RESTRICT) — see project memory.
  it('serialises orphan assignments without rejection (Unit B importer is the FK enforcer)', async () => {
    const { db } = createMockDb({
      configRows: [], // no configs
      assignmentRows: [SAMPLE_ASSIGNMENT_ROW], // but assignments present
    });
    const result = await buildDrRows(db);
    expect(result.backupConfigurations).toEqual([]);
    expect(result.backupTargetAssignments).toHaveLength(1);
  });
});

// ─── serialise + parse round-trip ──────────────────────────────────

describe('serialize/parse round-trip', () => {
  it('dr-inputs.yaml round-trips losslessly', async () => {
    const { db } = createMockDb({
      systemSettingsMode: 'allServerNodes',
      storagePolicyTier: 'ha',
    });
    const reader = makeClusterCRReader([
      { name: 'barman-cloud.cloudnative-pg.io', parameters: { barmanObjectName: 'system-db-objectstore' } },
    ]);
    const built = await buildDrInputs({
      db,
      k8s: k8sWithCidr('10.42.0.0/16'),
      config: { PLATFORM_BASE_DOMAIN: 'prod.example.com', PLATFORM_VERSION: '0.1.0-deadbeef' },
      clusterCRReader: reader,
    });
    const bytes = serializeDrInputs(built);
    const parsed = parseDrInputs(bytes);
    expect(parsed).toEqual(built);
  });

  it('dr-rows.json round-trips losslessly', async () => {
    const { db } = createMockDb({
      configRows: [SAMPLE_CFG_ROW],
      assignmentRows: [SAMPLE_ASSIGNMENT_ROW],
    });
    const built = await buildDrRows(db);
    const bytes = serializeDrRows(built);
    const parsed = parseDrRows(bytes);
    expect(parsed).toEqual(built);
  });
});

// ─── Forward-compat: reject unknown drBundleVersion ────────────────

describe('parser version checks', () => {
  it('parseDrInputs rejects an unknown version with BundleVersionError', () => {
    // Use raw YAML so we can set version=99 without going through the
    // serialiser (which would not allow it past the literal schema).
    const yaml = `drBundleVersion: 99\napexDomain: x\n`;
    expect(() => parseDrInputs(yaml)).toThrow(BundleVersionError);
  });

  it('parseDrInputs rejects missing version', () => {
    expect(() => parseDrInputs('apexDomain: x\n')).toThrow(BundleVersionError);
  });

  it('parseDrRows rejects an unknown version with BundleVersionError', () => {
    const json = JSON.stringify({ drBundleVersion: 2, backupConfigurations: [] });
    expect(() => parseDrRows(json)).toThrow(BundleVersionError);
  });

  it('parseDrRows surfaces a clear error for non-JSON input', () => {
    expect(() => parseDrRows('this is not json')).toThrow(/not valid JSON/);
  });
});
