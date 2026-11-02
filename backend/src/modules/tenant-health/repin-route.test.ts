import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listDeployments, buildDrainImpact, repinTenantPlacement } = vi.hoisted(() => ({
  listDeployments: vi.fn(),
  buildDrainImpact: vi.fn(),
  repinTenantPlacement: vi.fn(),
}));

vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: vi.fn().mockReturnValue({
    apps: {
      listNamespacedDeployment: listDeployments,
      listNamespacedStatefulSet: vi.fn().mockResolvedValue({ items: [] }),
    },
    core: { readNode: vi.fn().mockResolvedValue({}) },
  }),
}));
vi.mock('../nodes/service.js', () => ({
  buildDrainImpact,
  repinTenantPlacement,
  makeLonghornHostTagEnsurer: vi.fn().mockReturnValue(async (n: string) => `node-${n}`),
}));

import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { tenantHealthRoutes } from './routes.js';

/**
 * POST /admin/tenants/:id/recover/repin for a tenant whose row says Auto while
 * its workloads still carry a pin — Auto moves nothing, so a tenant set to
 * Auto while it ran keeps the node it ran on. Production: the route read only
 * the row, answered TENANT_NOT_PINNED, and the operator drained the node.
 */
const TENANT = { id: 't1', name: 'Acme', ns: 'tenant-acme', pin: null, tier: 'local' };
const pinnedTo = (node: string) => ({
  metadata: { name: 'web' },
  spec: { template: { spec: { nodeSelector: { 'kubernetes.io/hostname': node } } } },
});

async function setup() {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  app.decorate('db', {
    select: () => ({ from: () => ({ where: async () => [TENANT] }) }),
    insert: () => ({ values: async () => undefined }),
  } as unknown);
  app.decorate('config', { KUBECONFIG_PATH: '/tmp/test-kubeconfig.yaml' });
  await app.register(fastifyJwt, { secret: 'test-secret-for-tenant-health-repin-route' });
  await app.register(tenantHealthRoutes, { prefix: '/api/v1' });
  await app.ready();
  const token = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin' });
  const repin = (targetNode: string) => app.inject({
    method: 'POST',
    url: '/api/v1/admin/tenants/t1/recover/repin',
    headers: { authorization: `Bearer ${token}` },
    payload: { targetNode, confirm: true, reason: 'move it off' },
  });
  return { app, repin };
}

beforeEach(() => {
  listDeployments.mockReset();
  buildDrainImpact.mockReset();
  repinTenantPlacement.mockReset().mockResolvedValue({
    pvcs: 1, workloads: 1, tenants: 1, evictedPods: 0, relocating: 0, relocation: null, autoNode: 'sv3',
  });
});

describe('recover/repin with no pin on the row', () => {
  it('releases the node the workloads are pinned to', async () => {
    listDeployments.mockResolvedValue({ items: [pinnedTo('sv2')] });
    buildDrainImpact.mockResolvedValue({
      pinnedTenants: [{ tenantId: 't1', namespace: 'tenant-acme', workloads: [{ kind: 'Deployment', name: 'web', pinKind: 'nodeSelector' }], pvcs: [], storageTier: 'local' }],
    });
    const { repin } = await setup();
    const res = await repin('');
    expect(res.statusCode).toBe(200);
    expect(buildDrainImpact).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'sv2');
    expect(repinTenantPlacement.mock.calls[0]![3]).toBe('');
    expect(repinTenantPlacement.mock.calls[0]![4]).toBe('sv2');
  });

  it('refuses, changing nothing, when the workloads are pinned to several nodes', async () => {
    listDeployments.mockResolvedValue({ items: [pinnedTo('sv2'), { ...pinnedTo('sv1'), metadata: { name: 'db' } }] });
    const { repin } = await setup();
    const res = await repin('');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TENANT_PINNED_TO_SEVERAL_NODES');
    expect(repinTenantPlacement).not.toHaveBeenCalled();
  });

  it('still answers TENANT_NOT_PINNED when nothing is pinned anywhere', async () => {
    listDeployments.mockResolvedValue({ items: [{ metadata: { name: 'web' }, spec: { template: { spec: {} } } }] });
    const { repin } = await setup();
    const res = await repin('');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TENANT_NOT_PINNED');
    expect(buildDrainImpact).not.toHaveBeenCalled();
  });
});
