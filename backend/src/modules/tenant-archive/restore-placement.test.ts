import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RestoreNodeFacts } from './restore-placement.js';

const { autoPick } = vi.hoisted(() => ({ autoPick: vi.fn(async (): Promise<string | null> => 'sv2') }));
vi.mock('../tenants/auto-pick-node.js', () => ({ autoPickWorkerNode: autoPick }));

const { restoreNodeProblem, chooseRestoreNode } = await import('./restore-placement.js');

const ok: RestoreNodeFacts = { name: 'sv1', present: true, ready: true, cordoned: false, serverOnly: false, hosting: 'all' };

describe('restoreNodeProblem', () => {
  it('a node that hosts tenants and is up takes the restore', () => {
    expect(restoreNodeProblem(ok, 'local')).toBeNull();
    expect(restoreNodeProblem(ok, 'ha')).toBeNull();
  });
  it('says why a node cannot take it', () => {
    expect(restoreNodeProblem(undefined, 'local')).toBe('is no longer part of the cluster');
    expect(restoreNodeProblem({ ...ok, present: false }, 'local')).toBe('is no longer part of the cluster');
    expect(restoreNodeProblem({ ...ok, ready: false }, 'local')).toBe('is down (not Ready)');
    expect(restoreNodeProblem({ ...ok, hosting: 'none' }, 'local')).toBe('does not host tenants');
    expect(restoreNodeProblem({ ...ok, cordoned: true }, 'local')).toBe('is cordoned');
    expect(restoreNodeProblem({ ...ok, serverOnly: true }, 'local')).toBe('takes no tenants (server only)');
  });
  it('a pinned-only node takes a Local tenant, not an HA one', () => {
    expect(restoreNodeProblem({ ...ok, hosting: 'pinned' }, 'local')).toBeNull();
    expect(restoreNodeProblem({ ...ok, hosting: 'pinned' }, 'ha')).toContain('pinned tenants only');
  });
});

/** The platform's node table and the cluster's Node list. */
function fakes(nodes: Array<{ name: string; canHost?: boolean; labels?: Record<string, string>; ready?: boolean; cordoned?: boolean; inK8s?: boolean }>) {
  const db = {
    select: () => ({
      from: async () => nodes.map((n) => ({ name: n.name, canHostTenantWorkloads: n.canHost ?? true, labels: n.labels ?? {} })),
    }),
  } as never;
  const k8s = {
    core: {
      listNode: async () => ({
        items: nodes.filter((n) => n.inK8s !== false).map((n) => ({
          metadata: { name: n.name },
          spec: { unschedulable: n.cordoned ?? false },
          status: { conditions: [{ type: 'Ready', status: n.ready === false ? 'False' : 'True' }] },
        })),
      }),
    },
  } as never;
  return { db, k8s };
}

beforeEach(() => vi.clearAllMocks());

describe('chooseRestoreNode', () => {
  it('keeps a pin that can take the restore', async () => {
    const { db, k8s } = fakes([{ name: 'sv1' }, { name: 'sv2' }]);
    await expect(chooseRestoreNode(db, k8s, { nodeName: 'sv1', storageTier: 'local' }, undefined)).resolves.toBe('sv1');
  });

  it('refuses a pin to a node that is down, saying which and why', async () => {
    const { db, k8s } = fakes([{ name: 'sv1', ready: false }, { name: 'sv2' }]);
    await expect(chooseRestoreNode(db, k8s, { nodeName: 'sv1', storageTier: 'local' }, undefined)).rejects.toMatchObject({
      code: 'RESTORE_NODE_UNAVAILABLE', status: 409, message: "The tenant's node sv1 is down (not Ready)",
    });
  });

  it('refuses a pin to a node the cluster no longer has', async () => {
    const { db, k8s } = fakes([{ name: 'sv2' }]);
    await expect(chooseRestoreNode(db, k8s, { nodeName: 'gone-1', storageTier: 'local' }, undefined)).rejects.toMatchObject({
      code: 'RESTORE_NODE_UNAVAILABLE', message: expect.stringContaining('no longer part of the cluster'),
    });
  });

  it('takes a named node that can take it, and refuses one that cannot', async () => {
    const { db, k8s } = fakes([{ name: 'sv1', ready: false }, { name: 'sv2' }, { name: 'sv3', cordoned: true }]);
    await expect(chooseRestoreNode(db, k8s, { nodeName: 'sv1', storageTier: 'local' }, 'sv2')).resolves.toBe('sv2');
    await expect(chooseRestoreNode(db, k8s, { nodeName: 'sv1', storageTier: 'local' }, 'sv3')).rejects.toMatchObject({ code: 'RESTORE_NODE_UNAVAILABLE' });
    await expect(chooseRestoreNode(db, k8s, { nodeName: 'sv1', storageTier: 'local' }, 'nope')).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('Auto on the Local tier picks among the nodes that can take it, never one that cannot', async () => {
    const { db, k8s } = fakes([{ name: 'sv1', ready: false }, { name: 'sv2' }, { name: 'sv3', canHost: false }]);
    await expect(chooseRestoreNode(db, k8s, { nodeName: 'sv1', storageTier: 'local' }, null)).resolves.toBe('sv2');
    const exclude = (autoPick.mock.calls[0] as unknown as [unknown, unknown, { exclude: Set<string> }])[2].exclude;
    expect([...exclude].sort()).toEqual(['sv1', 'sv3']);
  });

  it('a Local tenant without a pin is placed as Auto', async () => {
    const { db, k8s } = fakes([{ name: 'sv2' }]);
    await expect(chooseRestoreNode(db, k8s, { nodeName: null, storageTier: 'local' }, undefined)).resolves.toBe('sv2');
  });

  it('Auto on the HA tier leaves the tenant unpinned', async () => {
    const { db, k8s } = fakes([{ name: 'sv1' }]);
    await expect(chooseRestoreNode(db, k8s, { nodeName: 'sv1', storageTier: 'ha' }, null)).resolves.toBeNull();
    expect(autoPick).not.toHaveBeenCalled();
  });

  it('Auto with no node to pick says so', async () => {
    autoPick.mockResolvedValueOnce(null);
    const { db, k8s } = fakes([{ name: 'sv1', ready: false }]);
    await expect(chooseRestoreNode(db, k8s, { nodeName: 'sv1', storageTier: 'local' }, null)).rejects.toMatchObject({ code: 'NO_NODE_FOR_RESTORE' });
  });
});
