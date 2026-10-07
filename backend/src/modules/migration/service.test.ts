import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { BackupMetaV2 } from '@insula/api-contracts';

const T1 = '11111111-1111-4111-8111-111111111111';

// Three bundles of one tenant, listed by the store in an order where the
// newest is NOT first (bundle ids are random, so any order is possible).
const META: Record<string, Partial<BackupMetaV2>> = {
  'bkp-c': { capturedAt: '2026-10-01T02:00:00.000Z', platformVersion: '2026.10.1' },
  'bkp-a': { capturedAt: '2026-10-05T02:00:00.000Z', platformVersion: '2026.10.5' },
  'bkp-b': { capturedAt: '2026-10-03T02:00:00.000Z', platformVersion: '2026.10.3' },
};

const store = {
  listBundleIds: vi.fn(async () => ['bkp-c', 'bkp-a', 'bkp-b', 'bkp-in-flight']),
  open: vi.fn(async (id: string) => ({ id })),
  getMeta: vi.fn(async (h: { id: string }) => {
    const m = META[h.id];
    if (!m) throw new Error('meta.json not found');
    return {
      backupId: h.id,
      tenantId: T1,
      tenant: { name: 'Acme', primaryEmail: 'ops@example.test', effectiveResources: null },
      components: { files: { sizeBytes: 100, fileCount: 1, sha256: 'x' }, config: { sizeBytes: 5, rowCount: 1 } },
      ...m,
    } as unknown as BackupMetaV2;
  }),
};

vi.mock('../backup-restore/shared.js', () => ({
  resolveDirectStoreForBundle: vi.fn(async () => store),
}));

const { listMigrationTenants } = await import('./service.js');

function fakeApp(presentIds: string[] = []): FastifyInstance {
  const where = vi.fn(async () => presentIds.map((id) => ({ id })));
  return { db: { select: () => ({ from: () => ({ where }) }) } } as unknown as FastifyInstance;
}

describe('listMigrationTenants', () => {
  it('offers the newest bundle of each tenant and says when it was captured', async () => {
    const scan = await listMigrationTenants(fakeApp(), 'target-1');
    expect(scan.scanned).toBe(4);
    expect(scan.skipped).toBe(1); // the bundle with no meta.json yet
    expect(scan.tenants).toHaveLength(1);
    const [t] = scan.tenants;
    expect(t).toMatchObject({
      tenantId: T1,
      tenantName: 'Acme',
      latestBundleId: 'bkp-a',
      latestCreatedAt: '2026-10-05T02:00:00.000Z',
      platformVersion: '2026.10.5',
      bundleCount: 3,
      totalSizeBytes: 105,
      alreadyPresent: false,
    });
    expect(t.components.sort()).toEqual(['config', 'files']);
  });

  it('marks a tenant that already exists on this cluster', async () => {
    const scan = await listMigrationTenants(fakeApp([T1]), 'target-1');
    expect(scan.tenants[0].alreadyPresent).toBe(true);
  });
});
