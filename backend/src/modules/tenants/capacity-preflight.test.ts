import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assertHaTierFeasible, checkProvisioningCapacity, HA_MIN_TENANT_NODES } from './capacity-preflight.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function makeDb(rows: Array<{ name: string; canHostTenantWorkloads: boolean; labels?: Record<string, string> }>) {
  const eligible = rows.filter((r) => r.canHostTenantWorkloads).map((r) => ({ labels: {}, ...r }));
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => eligible),
      })),
    })),
  };
}

describe('assertHaTierFeasible', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(`passes when ${HA_MIN_TENANT_NODES} or more tenant-capable nodes exist`, async () => {
    const rows = Array.from({ length: HA_MIN_TENANT_NODES }, (_, i) => ({
      name: `node-${i}`, canHostTenantWorkloads: true,
    }));
    await expect(assertHaTierFeasible(makeDb(rows) as never)).resolves.toBeUndefined();
  });

  it('throws HA_REQUIRES_MULTI_NODE on a single-node cluster', async () => {
    const rows = [{ name: 'only-node', canHostTenantWorkloads: true }];
    await expect(assertHaTierFeasible(makeDb(rows) as never))
      .rejects.toMatchObject({ code: 'HA_REQUIRES_MULTI_NODE', status: 409 });
  });

  it('throws when nodes exist but none are tenant-capable (server-only cluster)', async () => {
    const rows = [
      { name: 'srv-1', canHostTenantWorkloads: false },
      { name: 'srv-2', canHostTenantWorkloads: false },
      { name: 'srv-3', canHostTenantWorkloads: false },
    ];
    await expect(assertHaTierFeasible(makeDb(rows) as never))
      .rejects.toMatchObject({ code: 'HA_REQUIRES_MULTI_NODE' });
  });

  it('does not count a node that takes pinned tenants only — it is no failover target', async () => {
    const rows = [
      { name: 'de-1', canHostTenantWorkloads: true },
      { name: 'de-2', canHostTenantWorkloads: true },
      { name: 'za-1', canHostTenantWorkloads: true, labels: { 'insula.host/tenant-placement': 'pinned' } },
    ];
    await expect(assertHaTierFeasible(makeDb(rows) as never))
      .rejects.toMatchObject({ code: 'HA_REQUIRES_MULTI_NODE', details: { operatorError: { diagnostics: { tenantCapableNodes: 2 } } } });
  });

  it('error envelope includes diagnostics for the operator UI', async () => {
    const rows = [
      { name: 'a', canHostTenantWorkloads: true },
      { name: 'b', canHostTenantWorkloads: true },
    ];
    try {
      await assertHaTierFeasible(makeDb(rows) as never);
      expect.fail('expected throw');
    } catch (err) {
      const e = err as { details?: { operatorError?: { diagnostics?: Record<string, number> } } };
      expect(e.details?.operatorError?.diagnostics).toMatchObject({
        tenantCapableNodes: 2,
        requiredNodes: HA_MIN_TENANT_NODES,
      });
    }
  });
});

describe('checkProvisioningCapacity — nodes that take pinned tenants only', () => {
  const GIB = 1024 ** 3;
  // A 10 GiB plan; only the pinned-only node has room.
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((tbl: unknown) => {
        const rows = (tbl as { storageLimit?: unknown }).storageLimit !== undefined
          ? [{ id: 'plan-1', storageLimit: '10' }]
          : [
            { name: 'de-1', canHostTenantWorkloads: true, labels: {} },
            { name: 'za-1', canHostTenantWorkloads: true, labels: { 'insula.host/tenant-placement': 'pinned' } },
          ];
        return Object.assign(Promise.resolve(rows), { where: vi.fn(async () => rows) });
      }),
    })),
  };
  const disk = (free: number) => ({ spec: { disks: { d: { allowScheduling: true } } }, status: { diskStatus: { d: { storageMaximum: free, storageScheduled: 0 } } } });
  const k8s = {
    custom: {
      listNamespacedCustomObject: vi.fn(async () => ({
        items: [{ metadata: { name: 'de-1' }, ...disk(2 * GIB) }, { metadata: { name: 'za-1' }, ...disk(50 * GIB) }],
      })),
    },
  } as unknown as K8sClients;

  it('Auto placement does not count room the platform will never use', async () => {
    const r = await checkProvisioningCapacity(db as never, k8s, 'plan-1', 'local', { autoPlacement: true });
    expect(r).toMatchObject({ ok: false, fittingNodes: 0 });
    expect(r.nodes.map((n) => n.nodeName)).toEqual(['de-1']);
    // Says why, rather than reading as a lack of disk.
    expect(r.reason).toContain('pick it');
  });

  it('an HA-tier tenant never counts a pinned-only node', async () => {
    const r = await checkProvisioningCapacity(db as never, k8s, 'plan-1', 'ha');
    expect(r.nodes.map((n) => n.nodeName)).toEqual(['de-1']);
  });

  it('Auto with only pinned-only nodes counts none — not every node', async () => {
    const onlyPinned = {
      select: vi.fn(() => ({
        from: vi.fn((tbl: unknown) => {
          const rows = (tbl as { storageLimit?: unknown }).storageLimit !== undefined
            ? [{ id: 'plan-1', storageLimit: '10' }]
            : [{ name: 'za-1', canHostTenantWorkloads: true, labels: { 'insula.host/tenant-placement': 'pinned' } }];
          return Object.assign(Promise.resolve(rows), { where: vi.fn(async () => rows) });
        }),
      })),
    };
    const r = await checkProvisioningCapacity(onlyPinned as never, k8s, 'plan-1', 'local', { autoPlacement: true });
    expect(r).toMatchObject({ ok: false, fittingNodes: 0, nodes: [] });
    expect(r.reason).toContain('pick it');
  });

  it('a chosen node may be a pinned-only one, so it counts', async () => {
    const r = await checkProvisioningCapacity(db as never, k8s, 'plan-1', 'local');
    expect(r).toMatchObject({ ok: true, fittingNodes: 1 });
  });
});
