import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Restore deploys every application again from its row, then puts back what
 * the suspension scaled each down from — 0 included: an application the
 * tenant had stopped before the suspension is stopped again.
 */

const { redeployCatalog, redeployCustom } = vi.hoisted(() => ({
  redeployCatalog: vi.fn(async () => undefined),
  redeployCustom: vi.fn(async () => undefined),
}));
vi.mock('../deployments/service.js', () => ({ redeployWithCurrentConfig: redeployCatalog }));
vi.mock('../custom-deployments/service.js', () => ({ redeployCustomDeploymentRow: redeployCustom }));

const { redeployTenantWorkloads } = await import('./restore-workloads.js');

function db(rows: unknown[], quiesceSnapshot: unknown) {
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => {
          call += 1;
          if (call === 1) return Promise.resolve(rows);
          return { orderBy: () => ({ limit: async () => (quiesceSnapshot ? [{ params: { quiesceSnapshot } }] : []) }) };
        },
      }),
    }),
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('redeployTenantWorkloads', () => {
  it('redeploys every row the way its source deploys, then sets each replica count back, 0 included', async () => {
    const patch = vi.fn(async () => undefined);
    const k8s = { apps: { patchNamespacedDeployment: patch } } as never;
    const r = await redeployTenantWorkloads(
      db(
        [{ id: 'a', name: 'blog', source: 'catalog', status: 'stopped' }, { id: 'b', name: 'api', source: 'custom', status: 'stopped' }],
        { deployments: [{ name: 'blog', replicas: 1 }, { name: 'api', replicas: 0 }], cronJobs: [] },
      ),
      k8s,
      't1',
      'tenant-t1',
    );
    expect(redeployCatalog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'a' }), k8s, { armPasswordReset: true });
    expect(redeployCustom).toHaveBeenCalledWith(expect.anything(), k8s, 't1', expect.objectContaining({ id: 'b' }));
    expect(patch.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { name: 'blog', namespace: 'tenant-t1', body: { spec: { replicas: 1 } } },
      { name: 'api', namespace: 'tenant-t1', body: { spec: { replicas: 0 } } },
    ]);
    expect(r).toMatchObject({ total: 2, redeployed: 2, failures: [] });
  });

  it('one application that will not deploy is reported, the others come back', async () => {
    redeployCatalog.mockRejectedValueOnce(new Error('image gone'));
    const k8s = { apps: { patchNamespacedDeployment: vi.fn(async () => undefined) } } as never;
    const r = await redeployTenantWorkloads(
      db([{ id: 'a', name: 'blog', source: 'catalog', status: 'stopped' }, { id: 'c', name: 'shop', source: 'catalog', status: 'stopped' }], null),
      k8s, 't1', 'tenant-t1',
    );
    expect(r).toMatchObject({ total: 2, redeployed: 1, failures: ['blog: image gone'] });
  });

  it('a replica count for a Deployment that no longer exists is not a failure', async () => {
    const patch = vi.fn(async () => { throw Object.assign(new Error('nf'), { statusCode: 404 }); });
    const r = await redeployTenantWorkloads(db([], { deployments: [{ name: 'old', replicas: 1 }], cronJobs: [] }), { apps: { patchNamespacedDeployment: patch } } as never, 't1', 'tenant-t1');
    expect(r.failures).toEqual([]);
  });
});
