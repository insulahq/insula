import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { drRecoverRoutes } from './routes.js';
import { errorHandler } from '../../middleware/error-handler.js';

// The absent-tenant branch dynamic-imports './recreate.js'; stub it so the
// route tests exercise the branch WIRING (fall-through + response shape)
// without touching the off-site store. recreate.ts is covered by recreate.test.ts.
vi.mock('./recreate.js', () => ({ recreateTenantFromBundle: vi.fn() }));
import { recreateTenantFromBundle } from './recreate.js';

const JWT_SECRET = 'test-jwt-secret-for-dr-recover-routes';

type Row = Record<string, unknown>;

/**
 * Minimal drizzle-shaped mock. The recover handler only READS (tenant,
 * bundle, components); every write goes through `app.inject`. A single
 * thenable builder returns queued result-sets in the order the handler
 * awaits them (tenant → bundle → components).
 */
interface MockBuilder {
  from: () => MockBuilder;
  where: () => MockBuilder;
  orderBy: () => MockBuilder;
  limit: () => MockBuilder;
  then: (resolve: (rows: Row[]) => void) => void;
}

function makeMockDb(queue: readonly Row[][]): { select: () => MockBuilder } {
  const results = queue.map((r) => [...r]);
  const builder: MockBuilder = {
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (resolve) => resolve(results.shift() ?? []),
  };
  return { select: () => builder };
}

interface RecordedCall {
  method: string;
  url: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

interface StubOptions {
  provisionStatus?: string; // provision/status task status (default 'completed')
  execStatus?: string; // execute terminal cart status (default 'done')
  provisionTriggerCode?: number; // POST provision statusCode (default 202)
}

/** Sibling plugin exposing recording stubs for every injected sub-route. */
function stubRoutesPlugin(calls: RecordedCall[], opts: StubOptions) {
  return async (app: FastifyInstance): Promise<void> => {
    const record = (req: { method: string; url: string; headers: Record<string, unknown>; body: unknown }): void => {
      calls.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization as string | undefined,
        contentType: req.headers['content-type'] as string | undefined,
        body: req.body,
      });
    };
    app.post('/admin/tenants/:tenantId/provision', async (req, reply) => {
      record(req);
      reply.status(opts.provisionTriggerCode ?? 202).send({ data: { taskId: 'task-1', status: 'pending' } });
    });
    app.get('/admin/tenants/:tenantId/provision/status', async (req, reply) => {
      record(req);
      reply.status(200).send({ data: { status: opts.provisionStatus ?? 'completed' } });
    });
    app.post('/admin/restores/carts', async (req, reply) => {
      record(req);
      reply.status(201).send({ data: { id: 'rstr-cart-1', tenantId: 't-1', status: 'draft' } });
    });
    app.post('/admin/restores/carts/:id/items', async (req, reply) => {
      record(req);
      reply.status(201).send({ data: { id: 'item-x' } });
    });
    app.post('/admin/restores/carts/:id/execute', async (req, reply) => {
      record(req);
      reply.status(200).send({ data: { id: 'rstr-cart-1', status: opts.execStatus ?? 'done', items: [] } });
    });
  };
}

async function setupApp(queue: readonly Row[][], opts: StubOptions = {}) {
  const app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  app.decorate('db', makeMockDb(queue) as unknown);
  app.decorate('config', { KUBECONFIG_PATH: undefined });

  const calls: RecordedCall[] = [];
  await app.register(drRecoverRoutes, { prefix: '/api/v1' });
  await app.register(stubRoutesPlugin(calls, opts), { prefix: '/api/v1' });
  await app.ready();

  const adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin' });
  const tenantToken = app.jwt.sign({ sub: 'tenant-1', role: 'tenant_admin', panel: 'tenant', tenantId: 't-1' });
  return { app, calls, adminToken, tenantToken };
}

const TENANT: Row = { id: 't-1', name: 'Acme', status: 'active', provisioningStatus: 'provisioned' };
const BUNDLE: Row = { id: 'bundle-9', tenantId: 't-1', status: 'completed' };
const ALL_COMPONENTS: Row[] = [
  { component: 'config', status: 'completed' },
  { component: 'files', status: 'completed' },
  { component: 'mailboxes', status: 'completed' },
  { component: 'secrets', status: 'completed' }, // must be ignored by the handler
];

function recoverUrl(tenantId = 't-1'): string {
  return `/api/v1/admin/dr/tenants/${tenantId}/recover`;
}

function itemCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.url.endsWith('/items'));
}

describe('POST /api/v1/admin/dr/tenants/:tenantId/recover', () => {
  describe('auth', () => {
    it('returns 401 without a token', async () => {
      const { app } = await setupApp([[TENANT]]);
      const res = await app.inject({ method: 'POST', url: recoverUrl(), payload: {} });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 for a tenant-panel token', async () => {
      const { app, tenantToken } = await setupApp([[TENANT]]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${tenantToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('bundle + tenant resolution', () => {
    it('returns 404 when the tenant does not exist', async () => {
      const { app, adminToken } = await setupApp([[]]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl('nope'),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('TENANT_NOT_FOUND');
    });

    it('returns 404 DR_NO_BUNDLE when no completed bundle exists', async () => {
      const { app, adminToken } = await setupApp([[TENANT], []]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('DR_NO_BUNDLE');
    });

    it('resolves the newest completed bundle when bundleId is omitted', async () => {
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).data.bundleId).toBe('bundle-9');
      // Cart description references the resolved bundle.
      const cartCall = calls.find((c) => c.url.endsWith('/carts'));
      expect((cartCall!.body as { description: string }).description).toBe('dr-recover bundle-9');
      // Items reference the resolved bundle id.
      expect((itemCalls(calls)[0].body as { bundleId: string }).bundleId).toBe('bundle-9');
    });

    it('rejects a bundle belonging to another tenant (400)', async () => {
      const otherBundle: Row = { id: 'bundle-x', tenantId: 'other', status: 'completed' };
      const { app, adminToken } = await setupApp([[TENANT], [otherBundle]]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { bundleId: 'bundle-x' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('DR_BUNDLE_TENANT_MISMATCH');
    });

    it('rejects a non-completed explicit bundle (400)', async () => {
      const partial: Row = { id: 'bundle-p', tenantId: 't-1', status: 'partial' };
      const { app, adminToken } = await setupApp([[TENANT], [partial]]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { bundleId: 'bundle-p' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('DR_BUNDLE_NOT_COMPLETED');
    });
  });

  describe('orchestration sequence + ordering', () => {
    it('drives provision → poll → cart → items(config,files,databases,mailboxes) → execute in order', async () => {
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body).data;
      expect(body.cartId).toBe('rstr-cart-1');
      expect(body.provisioned).toBe(true);
      expect(body.status).toBe('done');
      // 'secrets' component is ignored; the response components stay the
      // 3-value contract enum (databases rides on 'files', not a component).
      expect(body.components).toEqual(['config', 'files', 'mailboxes']);

      // Injected call sequence — a databases-by-id item is queued right
      // after the files item, so there are FOUR item POSTs.
      const seq = calls.map((c) => `${c.method} ${c.url.replace('/api/v1', '')}`);
      expect(seq).toEqual([
        'POST /admin/tenants/t-1/provision',
        'GET /admin/tenants/t-1/provision/status',
        'POST /admin/restores/carts',
        'POST /admin/restores/carts/rstr-cart-1/items',
        'POST /admin/restores/carts/rstr-cart-1/items',
        'POST /admin/restores/carts/rstr-cart-1/items',
        'POST /admin/restores/carts/rstr-cart-1/items',
        'POST /admin/restores/carts/rstr-cart-1/execute',
      ]);

      // Item ordering + selectors — databases-by-id lands after files-paths.
      const items = itemCalls(calls).map((c) => c.body as { type: string; selector: Record<string, unknown> });
      expect(items.map((i) => i.type)).toEqual([
        'config-tables', 'files-paths', 'databases-by-id', 'mailboxes-by-address',
      ]);
      expect(items[0].selector).toEqual({ kind: 'all' });
      expect(items[1].selector).toEqual({ kind: 'full' });
      expect(items[2].selector).toEqual({ kind: 'all' });
      expect(items[3].selector).toEqual({ kind: 'all', mode: 'merge-skip-duplicates' });
    });

    it('forwards the caller Authorization header into every injected call', async () => {
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.auth).toBe(`Bearer ${adminToken}`);
      }
    });
  });

  describe('component intersection', () => {
    it('honours an explicit components subset (config only)', async () => {
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { components: ['config'] },
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).data.components).toEqual(['config']);
      const items = itemCalls(calls);
      expect(items).toHaveLength(1);
      expect((items[0].body as { type: string }).type).toBe('config-tables');
    });

    it('returns 400 DR_COMPONENT_UNAVAILABLE when requesting a component not in the bundle', async () => {
      const configOnly: Row[] = [{ component: 'config', status: 'completed' }];
      const { app, adminToken } = await setupApp([[TENANT], [BUNDLE], configOnly]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { components: ['mailboxes'] },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('DR_COMPONENT_UNAVAILABLE');
    });

    it('applies only components present in the bundle when defaulting', async () => {
      const filesConfig: Row[] = [
        { component: 'files', status: 'completed' },
        { component: 'config', status: 'completed' },
      ];
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], filesConfig]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).data.components).toEqual(['config', 'files']);
      // config + files + the databases item that rides on files = 3.
      const items = itemCalls(calls).map((c) => (c.body as { type: string }).type);
      expect(items).toEqual(['config-tables', 'files-paths', 'databases-by-id']);
    });

    it('does NOT queue a databases item when files is not applied (config only)', async () => {
      const configOnly: Row[] = [{ component: 'config', status: 'completed' }];
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], configOnly]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const items = itemCalls(calls).map((c) => (c.body as { type: string }).type);
      expect(items).toEqual(['config-tables']);
      expect(items).not.toContain('databases-by-id');
    });
  });

  describe('mailbox mode + provision toggle', () => {
    it('passes mailboxMode through to the mailboxes selector', async () => {
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { mailboxMode: 'merge-overwrite' },
      });
      const mailbox = itemCalls(calls).find((c) => (c.body as { type: string }).type === 'mailboxes-by-address');
      expect((mailbox!.body as { selector: Record<string, unknown> }).selector).toEqual({ kind: 'all', mode: 'merge-overwrite' });
    });

    it('adds confirmDestructive for a replace mailbox mode', async () => {
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { mailboxMode: 'replace' },
      });
      const mailbox = itemCalls(calls).find((c) => (c.body as { type: string }).type === 'mailboxes-by-address');
      expect((mailbox!.body as { selector: Record<string, unknown> }).selector).toEqual({ kind: 'all', mode: 'replace', confirmDestructive: true });
    });

    it('skips provisioning when provision:false', async () => {
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { provision: false },
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).data.provisioned).toBe(false);
      // No provision / provision-status calls at all.
      expect(calls.some((c) => c.url.includes('/provision'))).toBe(false);
      expect(calls[0].url).toContain('/restores/carts');
    });
  });

  describe('node targeting (gap G2)', () => {
    it('forwards targetNode into the provision call body', async () => {
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { targetNode: 'worker-2' },
      });
      expect(res.statusCode).toBe(202);
      const provisionCall = calls.find((c) => c.url.endsWith('/provision'));
      expect(provisionCall).toBeDefined();
      expect(provisionCall!.body).toEqual({ targetNode: 'worker-2' });
    });

    it('sends a provision body without targetNode when it is omitted', async () => {
      const { app, calls, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      const provisionCall = calls.find((c) => c.url.endsWith('/provision'));
      expect(provisionCall).toBeDefined();
      expect((provisionCall!.body as Record<string, unknown>).targetNode).toBeUndefined();
    });
  });

  describe('provision failure', () => {
    it('returns 502 DR_PROVISION_FAILED when the provision task fails', async () => {
      const { app, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS], { provisionStatus: 'failed' });
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(502);
      expect(JSON.parse(res.body).error.code).toBe('DR_PROVISION_FAILED');
    });
  });

  describe('execute result reflection', () => {
    it('reflects a failed cart status without throwing (synchronous execute)', async () => {
      const { app, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS], { execStatus: 'failed' });
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      expect(JSON.parse(res.body).data.status).toBe('failed');
    });
  });

  describe('deleted-tenant re-create (S4)', () => {
    it('returns 404 when the tenant is absent AND no bundleId is given', async () => {
      const { app, adminToken } = await setupApp([[]]); // tenant lookup empty
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl('gone-1'),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {}, // no bundleId
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('TENANT_NOT_FOUND');
      expect(vi.mocked(recreateTenantFromBundle)).not.toHaveBeenCalled();
    });

    it('re-creates from the bundle then falls through to provision + restore', async () => {
      vi.mocked(recreateTenantFromBundle).mockResolvedValue({ residualGaps: ['redeploy workloads'] });
      // Queue after the (empty) tenant lookup: §2 bundle row, §3 components.
      const { app, calls, adminToken } = await setupApp([[], [BUNDLE], ALL_COMPONENTS]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { bundleId: 'bundle-9', targetNode: 'worker-2' },
      });
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body).data;
      expect(body.recreated).toBe(true);
      expect(body.residualGaps).toEqual(['redeploy workloads']);
      expect(body.bundleId).toBe('bundle-9');

      // Re-create ran with the path tenantId + explicit bundleId + node.
      expect(vi.mocked(recreateTenantFromBundle)).toHaveBeenCalledWith(
        expect.anything(), 't-1', 'bundle-9', { targetNode: 'worker-2' },
      );
      // …and the existing orchestration still ran (provision + cart + execute).
      const seq = calls.map((c) => `${c.method} ${c.url.replace('/api/v1', '')}`);
      expect(seq[0]).toBe('POST /admin/tenants/t-1/provision');
      expect(seq).toContain('POST /admin/restores/carts/rstr-cart-1/execute');
    });

    it('surfaces the re-create ApiError (e.g. plan/region missing) as-is', async () => {
      const { ApiError } = await import('../../shared/errors.js');
      vi.mocked(recreateTenantFromBundle).mockRejectedValue(
        new ApiError('DR_PLAN_REGION_MISSING', 'plan missing', 400),
      );
      const { app, adminToken } = await setupApp([[]]); // tenant absent
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { bundleId: 'bundle-9' },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error.code).toBe('DR_PLAN_REGION_MISSING');
    });

    it('normal recover of an EXISTING tenant reports recreated:false', async () => {
      vi.mocked(recreateTenantFromBundle).mockReset();
      const { app, adminToken } = await setupApp([[TENANT], [BUNDLE], ALL_COMPONENTS]);
      const res = await app.inject({
        method: 'POST',
        url: recoverUrl(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const body = JSON.parse(res.body).data;
      expect(body.recreated).toBe(false);
      expect(body.residualGaps).toEqual([]);
      expect(vi.mocked(recreateTenantFromBundle)).not.toHaveBeenCalled();
    });
  });
});
