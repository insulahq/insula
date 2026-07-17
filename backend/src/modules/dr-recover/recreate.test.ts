import { describe, it, expect, vi, beforeEach } from 'vitest';

// createTenant is exercised end-to-end in tenants/service.test.ts; here we only
// care that recreateTenantFromBundle CALLS it with the preserved id + namespace,
// so stub the whole module (recreate.ts dynamic-imports it).
vi.mock('../tenants/service.js', () => ({ createTenant: vi.fn() }));

import { createTenant } from '../tenants/service.js';
import {
  recreateTenantFromBundle,
  resolveTenantClassBundleStore,
  DR_RECREATE_RESIDUAL_GAPS,
  type ResolvedBundleStore,
} from './recreate.js';
import type { BackupMetaV2 } from '@insula/api-contracts';
import type { BackupStore } from '../tenant-bundles/bundle-store.js';

type Row = Record<string, unknown>;

interface InsertRecord {
  values: unknown;
}

/** Queue-driven drizzle-shaped mock: select() drains `selectQueue`; insert()
 *  records the values passed. */
function makeDb(selectQueue: readonly Row[][]) {
  const inserts: InsertRecord[] = [];
  const q = selectQueue.map((r) => [...r]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (resolve: (rows: Row[]) => void) => resolve(q.shift() ?? []),
  };
  const db = {
    select: () => builder,
    insert: () => ({
      values: (v: unknown) => {
        inserts.push({ values: v });
        return Promise.resolve(undefined);
      },
    }),
    // Idempotent pre-clear of any retained catalog rows before re-registration.
    delete: () => ({ where: () => Promise.resolve(undefined) }),
  };
  return { db, inserts };
}

function makeApp(selectQueue: readonly Row[][]) {
  const { db, inserts } = makeDb(selectQueue);
  const app = {
    db,
    config: {},
    log: { warn: vi.fn(), info: vi.fn() },
  } as unknown as Parameters<typeof recreateTenantFromBundle>[0];
  return { app, inserts };
}

const BUNDLE_ID = 'bkp-abc';
const TENANT_ID = '11111111-2222-4333-8444-555555555555';
const PLAN_ID = '550e8400-e29b-41d4-a716-446655440000';
const REGION_ID = '550e8400-e29b-41d4-a716-446655440001';
const NAMESPACE = 'tenant-acme-deadbeef';

function makeMeta(overrides: Partial<BackupMetaV2> = {}): BackupMetaV2 {
  return {
    schemaVersion: 2,
    backupId: BUNDLE_ID,
    tenantId: TENANT_ID,
    capturedAt: '2026-07-01T00:00:00.000Z',
    platformVersion: '1.0.0',
    initiator: 'admin',
    systemTrigger: null,
    label: 'nightly',
    components: {
      config: { sizeBytes: 12, rowCount: 4 },
      files: { sizeBytes: 200, fileCount: 3, sha256: 'a'.repeat(64) },
      mailboxes: { sizeBytes: 40, mailboxCount: 2, addresses: [], sha256: 'b'.repeat(64) },
    },
    nodePlacement: null,
    expiresAt: null,
    retentionDays: 30,
    description: 'desc',
    tenant: {
      name: 'Acme',
      primaryEmail: 'admin@acme.test',
      secondaryEmail: null,
      status: 'active',
      kubernetesNamespace: NAMESPACE,
      regionId: REGION_ID,
      planId: PLAN_ID,
      nodeName: 'src-node-that-does-not-exist-here',
      storageTier: 'local',
      timezone: 'UTC',
      storageLimitOverride: null,
      cpuLimitOverride: null,
      memoryLimitOverride: null,
      maxSubUsersOverride: null,
      maxMailboxesOverride: null,
      monthlyPriceOverride: null,
      emailSendRateLimit: null,
      subscriptionExpiresAt: null,
      counts: { mailboxes: 2, domains: 1, deployments: 1 },
    },
    domainsSummary: [],
    deploymentsSummary: [],
    ...overrides,
  };
}

function makeStore(meta: BackupMetaV2 | 'missing' | 'throws'): BackupStore {
  return {
    kind: 's3',
    open: vi.fn(async () => (meta === 'missing' ? null : { bundleId: BUNDLE_ID, _backend: {} })),
    getMeta: vi.fn(async () => {
      if (meta === 'throws') throw new Error('NoSuchKey');
      if (meta === 'missing') throw new Error('unreachable');
      return meta;
    }),
  } as unknown as BackupStore;
}

function inject(store: BackupStore): (app: unknown) => Promise<ResolvedBundleStore> {
  return async () => ({ store, targetConfigId: 'cfg-1' });
}

beforeEach(() => {
  vi.mocked(createTenant).mockReset();
});

describe('recreateTenantFromBundle', () => {
  it('re-creates the tenant with the ORIGINAL id + namespace and registers the bundle index', async () => {
    vi.mocked(createTenant).mockResolvedValue({
      id: TENANT_ID, kubernetesNamespace: NAMESPACE, status: 'pending',
    } as unknown as Awaited<ReturnType<typeof createTenant>>);
    const meta = makeMeta();
    // Select order: plan lookup → region lookup (both present).
    const { app, inserts } = makeApp([[{ id: PLAN_ID }], [{ id: REGION_ID }]]);

    const result = await recreateTenantFromBundle(app, TENANT_ID, BUNDLE_ID, {
      targetNode: 'worker-2',
      resolveStore: inject(makeStore(meta)),
    });

    // createTenant is called with the preserved id + namespace + mapped fields.
    expect(createTenant).toHaveBeenCalledTimes(1);
    const call = vi.mocked(createTenant).mock.calls[0];
    expect(call[1]).toMatchObject({
      name: 'Acme',
      primary_email: 'admin@acme.test',
      plan_id: PLAN_ID,
      region_id: REGION_ID,
      node_name: 'worker-2', // operator targetNode, NOT the stale meta node
      storage_tier: 'local',
    });
    expect(call[2]).toBe('system');
    expect(call[3]).toEqual({ tenantIdOverride: TENANT_ID, namespaceOverride: NAMESPACE, skipAdminUser: true });

    // backup_jobs + backup_components rows registered so the fall-through finds
    // the bundle: job first, then a components batch (config/files/mailboxes).
    expect(inserts).toHaveLength(2);
    const job = inserts[0].values as Row;
    expect(job).toMatchObject({
      id: BUNDLE_ID, tenantId: TENANT_ID, targetConfigId: 'cfg-1',
      targetKind: 's3', status: 'completed',
    });
    const comps = inserts[1].values as Row[];
    expect(comps.map((c) => c.component).sort()).toEqual(['config', 'files', 'mailboxes']);
    // The restic snapshot id from meta is repopulated onto backup_components.
    // sha256 for BOTH files and mailboxes — the DB rows were cascade-dropped
    // with the tenant, and the restore executors resolve the snapshot from
    // this column (regression: mailboxes previously lacked it in meta).
    const byName = Object.fromEntries(comps.map((c) => [c.component, c])) as Record<string, Row>;
    expect(byName.files.sha256).toBe('a'.repeat(64));
    expect(byName.mailboxes.sha256).toBe('b'.repeat(64));

    expect(result.residualGaps).toEqual([...DR_RECREATE_RESIDUAL_GAPS]);
  });

  it('rejects a bundle whose meta.tenantId does not match (400)', async () => {
    const meta = makeMeta({ tenantId: '99999999-2222-4333-8444-555555555555' });
    const { app } = makeApp([]);
    await expect(
      recreateTenantFromBundle(app, TENANT_ID, BUNDLE_ID, { resolveStore: inject(makeStore(meta)) }),
    ).rejects.toMatchObject({ code: 'DR_BUNDLE_TENANT_MISMATCH', status: 400 });
    expect(createTenant).not.toHaveBeenCalled();
  });

  it('rejects a legacy v1 bundle with no tenant block (400)', async () => {
    const meta = makeMeta({ tenant: null });
    const { app } = makeApp([]);
    await expect(
      recreateTenantFromBundle(app, TENANT_ID, BUNDLE_ID, { resolveStore: inject(makeStore(meta)) }),
    ).rejects.toMatchObject({ code: 'DR_CANNOT_RECREATE_LEGACY_BUNDLE', status: 400 });
    expect(createTenant).not.toHaveBeenCalled();
  });

  it('rejects when the plan/region are missing on this cluster (400)', async () => {
    const meta = makeMeta();
    // plan lookup empty → missing plan; region present.
    const { app } = makeApp([[], [{ id: REGION_ID }]]);
    await expect(
      recreateTenantFromBundle(app, TENANT_ID, BUNDLE_ID, { resolveStore: inject(makeStore(meta)) }),
    ).rejects.toMatchObject({ code: 'DR_PLAN_REGION_MISSING', status: 400 });
    expect(createTenant).not.toHaveBeenCalled();
  });

  it('returns DR_BUNDLE_NOT_FOUND when the bundle handle is absent (404)', async () => {
    const { app } = makeApp([]);
    await expect(
      recreateTenantFromBundle(app, TENANT_ID, BUNDLE_ID, { resolveStore: inject(makeStore('missing')) }),
    ).rejects.toMatchObject({ code: 'DR_BUNDLE_NOT_FOUND', status: 404 });
  });

  it('returns DR_BUNDLE_NOT_FOUND when getMeta throws (404)', async () => {
    const { app } = makeApp([]);
    await expect(
      recreateTenantFromBundle(app, TENANT_ID, BUNDLE_ID, { resolveStore: inject(makeStore('throws')) }),
    ).rejects.toMatchObject({ code: 'DR_BUNDLE_NOT_FOUND', status: 404 });
  });
});

describe('resolveTenantClassBundleStore', () => {
  it('throws NO_BACKUP_TARGET when no tenant-class target is assigned/active', async () => {
    // assignment lookup empty, then active=true config lookup empty.
    const { app } = makeApp([[], []]);
    await expect(resolveTenantClassBundleStore(app)).rejects.toMatchObject({
      code: 'NO_BACKUP_TARGET',
      status: 409,
    });
  });
});
