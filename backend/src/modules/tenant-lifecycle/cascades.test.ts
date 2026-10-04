/**
 * applyDeleted — what a tenant delete leaves behind for its recovery.
 *
 * The tenant row goes, but its `deleted` lifecycle transition and its off-site
 * bundles stay. The transition is the only place that can still say who the
 * tenant was, so the recover screens can list it by name.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { runTransition, release, order } = vi.hoisted(() => ({
  runTransition: vi.fn(async () => ({ transitionId: 'tx-1' })),
  release: vi.fn(async () => [] as string[]),
  order: [] as string[],
}));
vi.mock('./registry/index.js', () => ({ runTransition }));
vi.mock('./reap-namespace-volumes.js', () => ({
  reapNamespaceVolumes: vi.fn(async () => ({ pvsReaped: [], lhVolsReaped: [], timedOut: false })),
  realReapDeps: () => ({}),
}));
vi.mock('../tenant-placement/relocate.js', () => ({
  releaseRelocationsInNamespace: vi.fn(async () => { order.push('release'); return release(); }),
}));

const { applyDeleted } = await import('./cascades.js');

function ctx(nameRows: Array<{ name: string }> | Error) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => (nameRows instanceof Error ? Promise.reject(nameRows) : Promise.resolve(nameRows)),
  };
  return {
    db: {
      select: () => chain,
      delete: () => ({ where: async () => undefined }),
    },
    k8s: { core: { deleteNamespace: vi.fn(async () => { order.push('deleteNamespace'); }) } },
  } as never;
}

beforeEach(() => { runTransition.mockClear(); order.length = 0; });

describe('applyDeleted', () => {
  it('records the tenant\'s name on its delete transition', async () => {
    await applyDeleted(ctx([{ name: 'ACME LEARNING' }]), 't-1', 'tenant-example-0a1b2c3d');
    expect(runTransition).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      transition: 'deleted', detail: { tenantName: 'ACME LEARNING' },
    }));
  });

  it('still deletes when the name cannot be read', async () => {
    const id = await applyDeleted(ctx(new Error('db down')), 't-1', 'tenant-example-0a1b2c3d');
    expect(id).toBe('tx-1');
    expect(order).toContain('deleteNamespace');
  });

  it('releases a pending data relocation before deleting the namespace', async () => {
    await applyDeleted(ctx([{ name: 'Acme' }]), 't-1', 'tenant-example-0a1b2c3d');
    expect(order).toEqual(['release', 'deleteNamespace']);
  });
});
