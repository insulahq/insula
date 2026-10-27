import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A restored tenant comes back SUSPENDED: every application is deployed again
 * from its row at 0 replicas, every CronJob is paused, and what Reactivate
 * scales back to is returned — what the suspension before the archive wrote
 * down, 0 included; what a deploy runs for one it did not; 0 for a Deployment
 * no row explains.
 */

const { redeployCatalog, redeployCustom } = vi.hoisted(() => ({
  redeployCatalog: vi.fn(async () => undefined),
  redeployCustom: vi.fn(async () => undefined),
}));
vi.mock('../deployments/service.js', () => ({ redeployWithCurrentConfig: redeployCatalog }));
vi.mock('../custom-deployments/service.js', () => ({ redeployCustomDeploymentRow: redeployCustom }));

const { redeployTenantWorkloads, resumeSnapshotFor } = await import('./restore-workloads.js');

/** Reads, in order: the deployment rows, the newest suspend, the newest finished resume. */
function db(rows: unknown[], quiesceSnapshot: unknown, resumedAfter = false) {
  let call = 0;
  const suspendAt = new Date('2026-10-01T00:00:00Z');
  return {
    select: () => ({
      from: () => ({
        where: () => {
          call += 1;
          if (call === 1) return Promise.resolve(rows);
          const result = call === 2
            ? (quiesceSnapshot ? [{ params: { quiesceSnapshot }, createdAt: suspendAt }] : [])
            : (resumedAfter ? [{ params: {}, createdAt: new Date(suspendAt.getTime() + 1000) }] : []);
          return { orderBy: () => ({ limit: async () => result }) };
        },
      }),
    }),
  } as never;
}

const dep = (name: string, labels: Record<string, string>) => ({ metadata: { name, labels: { 'platform.io/managed': 'true', ...labels } } });

function k8s(deployments: unknown[], cronJobs: Array<{ metadata: { name: string }; spec?: { suspend?: boolean } }> = [], patchCron = vi.fn(async () => undefined)) {
  return {
    apps: { listNamespacedDeployment: vi.fn(async () => ({ items: deployments })) },
    batch: { listNamespacedCronJob: vi.fn(async () => ({ items: cronJobs })), patchNamespacedCronJob: patchCron },
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('redeployTenantWorkloads', () => {
  it('deploys every row stopped, the way its source deploys', async () => {
    const client = k8s([]);
    const r = await redeployTenantWorkloads(
      db([{ id: 'a', name: 'blog', source: 'catalog', status: 'stopped' }, { id: 'b', name: 'api', source: 'custom', status: 'stopped' }], null),
      client, 't1', 'tenant-t1',
    );
    expect(redeployCatalog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'a' }), client, { armPasswordReset: true, replicas: 0 });
    expect(redeployCustom).toHaveBeenCalledWith(expect.anything(), client, 't1', expect.objectContaining({ id: 'b' }), { stopped: true });
    expect(r).toMatchObject({ total: 2, redeployed: 2, failures: [] });
  });

  it('pauses every CronJob that runs, and remembers it ran', async () => {
    const patchCron = vi.fn(async () => undefined);
    const r = await redeployTenantWorkloads(
      db([], null),
      k8s([], [{ metadata: { name: 'blog-cron' } }, { metadata: { name: 'paused' }, spec: { suspend: true } }], patchCron),
      't1', 'tenant-t1',
    );
    expect(patchCron.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { name: 'blog-cron', namespace: 'tenant-t1', body: { spec: { suspend: true } } },
    ]);
    expect(r.resumeTo.cronJobs).toEqual([
      { name: 'blog-cron', wasSuspended: false },
      { name: 'paused', wasSuspended: false },
    ]);
  });

  it('one application that will not deploy is reported, the others come back', async () => {
    redeployCatalog.mockRejectedValueOnce(new Error('image gone'));
    const r = await redeployTenantWorkloads(
      db([{ id: 'a', name: 'blog', source: 'catalog', status: 'stopped' }, { id: 'c', name: 'shop', source: 'catalog', status: 'stopped' }], null),
      k8s([]), 't1', 'tenant-t1',
    );
    expect(r).toMatchObject({ total: 2, redeployed: 1, failures: ['blog: image gone'] });
  });

  it('returns what the suspension before the archive wrote down as what Reactivate brings back', async () => {
    const r = await redeployTenantWorkloads(
      db([{ id: 'a', name: 'blog', source: 'catalog', status: 'stopped', replicaCount: 1 }],
        { deployments: [{ name: 'blog', replicas: 0 }], cronJobs: [] }),
      k8s([dep('blog', { app: 'blog' })]), 't1', 'tenant-t1',
    );
    expect(r.resumeTo.deployments).toEqual([{ name: 'blog', replicas: 0 }]);
  });
});

describe('the suspension record a restore reads', () => {
  it('is not used when a resume came after it — the tenant ran again since', async () => {
    const r = await redeployTenantWorkloads(
      db([{ id: 'a', name: 'blog', source: 'catalog', status: 'stopped', replicaCount: 1 }],
        { deployments: [{ name: 'blog', replicas: 0 }], cronJobs: [] }, true),
      k8s([dep('blog', { app: 'blog' })]), 't1', 'tenant-t1',
    );
    // Not the stale 0: what a deploy runs.
    expect(r.resumeTo.deployments).toEqual([{ name: 'blog', replicas: 1 }]);
  });
});

describe('resumeSnapshotFor', () => {
  const rows = [
    { id: 'r-blog', name: 'blog', source: 'catalog', replicaCount: 2 },
    { id: 'r-api', name: 'api', source: 'custom', replicaCount: null },
  ];

  it('takes the count the suspension wrote down, 0 included', () => {
    const s = resumeSnapshotFor([dep('blog', { app: 'blog' })], [], rows, { deployments: [{ name: 'blog', replicas: 0 }], cronJobs: [] });
    expect(s.deployments).toEqual([{ name: 'blog', replicas: 0 }]);
  });

  it('without a record: a catalog component runs its row\'s count, every component of it', () => {
    const s = resumeSnapshotFor([dep('blog', { app: 'blog' }), dep('blog-worker', { app: 'blog' })], [], rows, null);
    expect(s.deployments).toEqual([{ name: 'blog', replicas: 2 }, { name: 'blog-worker', replicas: 2 }]);
  });

  it('without a record: a custom service runs 1', () => {
    const s = resumeSnapshotFor([dep('api-web', { app: 'api-web', 'insula.host/deployment-id': 'r-api' })], [], rows, undefined);
    expect(s.deployments).toEqual([{ name: 'api-web', replicas: 1 }]);
  });

  it('a Deployment no row explains stays at 0', () => {
    const s = resumeSnapshotFor([dep('file-manager', { app: 'file-manager' })], [], rows, null);
    expect(s.deployments).toEqual([{ name: 'file-manager', replicas: 0 }]);
  });

  it('a CronJob the tenant had paused stays paused', () => {
    const s = resumeSnapshotFor([], [{ metadata: { name: 'blog-cron' } }], rows, { deployments: [], cronJobs: [{ name: 'blog-cron', wasSuspended: true }] });
    expect(s.cronJobs).toEqual([{ name: 'blog-cron', wasSuspended: true }]);
  });
});
