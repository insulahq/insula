/**
 * `POST /admin/dr/tenants/recover-all` with `background: true` — the batch runs
 * as one `dr.recover-all` task, each tenant as a child `dr.recover` task.
 *
 * The encryption-key gate must still refuse BEFORE any task exists: a refusal
 * that had already enrolled a batch would leave the operator a "running"
 * recovery that does nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type { DrRecoverAllTenantProgress } from '@insula/api-contracts';
import { errorHandler } from '../../middleware/error-handler.js';
import { encrypt } from '../oidc/crypto.js';
import { tenants, backupJobs, backupComponents, backupConfigurations } from '../../db/schema.js';

let nextId = 0;
vi.mock('../tasks/service.js', () => ({
  start: vi.fn(async () => ({ id: `task-${++nextId}`, idempotent: false })),
  progress: vi.fn(async () => undefined),
  finish: vi.fn(async () => undefined),
  adoptChildByRef: vi.fn(async () => true),
  hasActiveTask: vi.fn(async () => false),
  failStaleActive: vi.fn(async () => 0),
}));
const taskService = await import('../tasks/service.js');
const { drRecoverRoutes } = await import('./routes.js');

const JWT_SECRET = 'test-jwt-secret-for-dr-recover-all-task';
const KEY_LOCAL = 'a'.repeat(64);
const KEY_SOURCE = 'b'.repeat(64);
type Row = Record<string, unknown>;

function makeDb(targetKey: string | null) {
  const rowsFor = (table: unknown, cols: Record<string, unknown> | undefined): Row[] => {
    const keys = Object.keys(cols ?? {});
    if (table === tenants) {
      if (keys.length === 2 && keys.includes('ns')) return [{ name: 'Acme', ns: 'tenant-t-1' }];
      if (keys.length === 1 && keys[0] === 'name') return [{ name: 'Acme' }];
      return [{ id: 't-1', name: 'Acme', status: 'active', kubernetesNamespace: 'tenant-t-1', provisioningStatus: 'provisioned' }];
    }
    if (table === backupComponents) return [{ component: 'config', status: 'completed' }];
    if (table === backupJobs) {
      if (keys.length === 1 && keys.includes('targetConfigId')) return targetKey ? [{ targetConfigId: 'cfg-1' }] : [];
      return [{ id: 'bundle-9', tenantId: 't-1', status: 'completed', createdAt: new Date('2026-09-01T00:00:00Z'), finishedAt: null }];
    }
    if (table === backupConfigurations) {
      if (!targetKey) return [];
      return [{
        id: 'cfg-1', name: 'offsite', storageType: 's3',
        s3AccessKeyEncrypted: encrypt('AKIA-example', targetKey), s3SecretKeyEncrypted: encrypt('s3-secret', targetKey),
        sshKeyEncrypted: null, sshPasswordEncrypted: null, cifsPasswordEncrypted: null,
      }];
    }
    return [];
  };
  const builder = (cols?: Record<string, unknown>) => {
    let table: unknown = null;
    const b: Record<string, unknown> = { from: (t: unknown) => { table = t; return b; } };
    for (const k of ['where', 'orderBy', 'limit', 'innerJoin']) b[k] = () => b;
    b.then = (resolve: (r: Row[]) => void) => resolve(rowsFor(table, cols));
    return b;
  };
  return {
    selectDistinct: () => builder({ tenantId: 1 }),
    select: (cols?: Record<string, unknown>) => builder(cols),
    execute: async () => ({ rows: [] }),
  };
}

async function setupApp(opts: { targetKey?: string | null; execStatus?: string } = {}) {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  app.decorate('db', makeDb(opts.targetKey === undefined ? KEY_LOCAL : opts.targetKey) as unknown);
  app.decorate('config', { KUBECONFIG_PATH: undefined, PLATFORM_ENCRYPTION_KEY: KEY_LOCAL });
  const provisioned: string[] = [];
  await app.register(drRecoverRoutes, { prefix: '/api/v1' });
  await app.register(async (a: FastifyInstance) => {
    a.post('/admin/tenants/:tenantId/provision', async (req, reply) => {
      provisioned.push((req.params as { tenantId: string }).tenantId);
      reply.status(202).send({ data: { taskId: 'prov-1', status: 'pending' } });
    });
    a.get('/admin/tenants/:tenantId/provision/status', async (_req, reply) => {
      reply.status(200).send({ data: { status: 'completed' } });
    });
    a.post('/admin/restores/carts', async (_req, reply) => {
      reply.status(201).send({ data: { id: 'rstr-cart-1' } });
    });
    a.post('/admin/restores/carts/:id/items', async (_req, reply) => {
      reply.status(201).send({ data: { id: 'item-x' } });
    });
    a.post('/admin/restores/carts/:id/execute', async (_req, reply) => {
      reply.status(200).send({ data: { id: 'rstr-cart-1', status: opts.execStatus ?? 'done', items: [] } });
    });
  }, { prefix: '/api/v1' });
  await app.ready();
  const token = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin' });
  const post = (payload: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/v1/admin/dr/tenants/recover-all',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
  return { post, provisioned };
}

const startCalls = () => vi.mocked(taskService.start).mock.calls.map((c) => c[1]);
const finishOf = (taskId: string) =>
  vi.mocked(taskService.finish).mock.calls.find((c) => c[1] === taskId)?.[2] as
    { status: string; error?: string | null; detailsPatch?: { tenants?: DrRecoverAllTenantProgress[]; recovered?: number; error?: { code: string; title: string } | null } } | undefined;

beforeEach(() => {
  nextId = 0;
  vi.mocked(taskService.start).mockClear();
  vi.mocked(taskService.progress).mockClear();
  vi.mocked(taskService.finish).mockClear();
  vi.mocked(taskService.hasActiveTask).mockReset().mockResolvedValue(false);
});

describe('background Recover All', () => {
  it('answers with the batch task, then recovers each tenant as a child task', async () => {
    const { post, provisioned } = await setupApp();
    const res = await post({ scope: 'all', background: true });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).data).toEqual({ taskId: 'task-1', total: 1 });

    await vi.waitFor(() => expect(finishOf('task-1')).toBeDefined());
    const [batch, child] = startCalls();
    expect(batch!.kind).toBe('dr.recover-all');
    expect(batch!.target).toEqual({ type: 'modal', modal: 'dr-recover-all', modalProps: {} });
    expect(child!.kind).toBe('dr.recover');
    expect(child!.parentTaskId).toBe('task-1');
    expect(child!.tenantId).toBe('t-1');
    expect(provisioned).toEqual(['t-1']);

    // The child has its own terminal result; the batch summarises.
    expect(finishOf('task-2')?.status).toBe('succeeded');
    const fin = finishOf('task-1')!;
    expect(fin.status).toBe('succeeded');
    expect(fin.detailsPatch?.recovered).toBe(1);
    expect(fin.detailsPatch?.tenants?.[0]).toMatchObject({ tenantId: 't-1', state: 'done', status: 'done', taskId: 'task-2' });
    expect(fin.detailsPatch?.error).toBeNull();
  });

  it('a tenant whose restore fails fails the batch, with the reason on its row', async () => {
    const { post } = await setupApp({ execStatus: 'failed' });
    await post({ scope: 'all', background: true });
    await vi.waitFor(() => expect(finishOf('task-1')).toBeDefined());
    const fin = finishOf('task-1')!;
    expect(fin.status).toBe('failed');
    expect(fin.error).toBe('1 of 1 tenants could not be recovered');
    expect(fin.detailsPatch?.tenants?.[0]).toMatchObject({ state: 'failed', status: 'failed' });
    expect(fin.detailsPatch?.tenants?.[0]?.error).toContain('The restore stopped at a failed item');
    // The modal renders this through <ErrorPanel>.
    expect(fin.detailsPatch?.error).toMatchObject({ code: 'DR_RECOVER_ALL_INCOMPLETE', title: '1 of 1 tenant could not be recovered' });
  });

  it('the encryption-key gate still refuses first — no batch task, nothing provisioned', async () => {
    const { post, provisioned } = await setupApp({ targetKey: KEY_SOURCE });
    const res = await post({ scope: 'all', background: true });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('DR_ENCRYPTION_KEY_MISMATCH');
    expect(taskService.start).not.toHaveBeenCalled();
    expect(provisioned).toHaveLength(0);
  });

  it('refuses a second batch while one runs', async () => {
    vi.mocked(taskService.hasActiveTask).mockResolvedValue(true);
    const { post, provisioned } = await setupApp();
    const res = await post({ scope: 'all', background: true });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe('DR_RECOVER_ALL_IN_PROGRESS');
    expect(taskService.start).not.toHaveBeenCalled();
    expect(provisioned).toHaveLength(0);
  });

  it('a dry run ignores background — it previews, starts nothing', async () => {
    const { post } = await setupApp();
    const res = await post({ scope: 'all', dryRun: true, background: true });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.targets).toHaveLength(1);
    expect(taskService.start).not.toHaveBeenCalled();
  });
});
