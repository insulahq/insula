import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const mockTenant = {
  id: 'c1',
  provisioningStatus: 'provisioned',
  kubernetesNamespace: 'tenant-c1',
  // notNull default 'idle' in the real schema — the storage-op guard reads it.
  storageLifecycleState: 'idle',
};

// Mutable so individual tests can simulate an in-flight storage operation
// (resize/snapshot/restore) by swapping the row the tenant lookup returns.
let tenantRows: unknown[] = [mockTenant];

const mockDb = {
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockImplementation(async () => tenantRows),
      }),
    }),
  }),
};

vi.mock('./service.js', () => ({
  fileManagerRequest: vi.fn().mockResolvedValue({
    status: 200,
    body: JSON.stringify({ path: '/', entries: [] }),
    bodyBuffer: Buffer.from(JSON.stringify({ path: '/', entries: [] })),
    headers: {},
  }),
  streamFromFileManager: vi.fn().mockImplementation(async (
    _kc: string | undefined,
    _ns: string,
    _path: string,
    tenantRes: import('node:http').ServerResponse,
  ) => {
    // Default success: write a small buffer through to the tenant.
    tenantRes.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="test.txt"',
    });
    tenantRes.end(Buffer.from('hello world binary content'));
  }),
  streamToFileManager: vi.fn().mockResolvedValue({
    status: 200, body: '{}', bodyBuffer: Buffer.from('{}'), headers: {},
  }),
  resolveFmServiceUrlForRoute: vi.fn().mockResolvedValue(null),
  ensureFileManagerReady: vi.fn().mockResolvedValue({ directUrl: null }),
  getFileManagerStatus: vi.fn().mockResolvedValue({ ready: true, phase: 'ready' }),
  ensureFileManagerRunning: vi.fn().mockResolvedValue(undefined),
  stopFileManager: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../k8s-provisioner/k8s-client.js', () => ({
  createK8sClients: vi.fn().mockReturnValue({
    coreV1Api: {},
    appsV1Api: {},
    networkingV1Api: {},
  }),
}));

vi.mock('../../db/schema.js', () => ({
  tenants: { id: 'tenants.id' },
}));

const { fileManagerRoutes } = await import('./routes.js');

describe('file-manager routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let tenantToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', mockDb);
    app.decorate('config', { KUBECONFIG_PATH: '/tmp/kubeconfig', PLATFORM_ENCRYPTION_KEY: '0'.repeat(64) });
    await app.register(fileManagerRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({
      sub: 'admin-1', role: 'super_admin', panel: 'admin',
      iat: Math.floor(Date.now() / 1000),
    });
    tenantToken = app.jwt.sign({
      sub: 'tenant-1', role: 'tenant_admin', panel: 'tenant', tenantId: 'c1',
      iat: Math.floor(Date.now() / 1000),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  // ─── Auth ───────────────────────────────────────────────────────────────

  it('GET /tenants/c1/files without auth returns 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/c1/files',
    });
    expect(res.statusCode).toBe(401);
  });

  // ─── Status ─────────────────────────────────────────────────────────────

  it('GET /tenants/c1/files/status returns 200', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/c1/files/status',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.ready).toBe(true);
    expect(body.data.phase).toBe('ready');
  });

  // ─── List directory ─────────────────────────────────────────────────────

  it('GET /tenants/c1/files with auth returns directory listing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/c1/files',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(body.data.path).toBe('/');
    expect(body.data.entries).toEqual([]);
  });

  // ─── Read file ──────────────────────────────────────────────────────────

  it('GET /tenants/c1/files/read without path query returns 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/c1/files/read',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  // ─── Mkdir ──────────────────────────────────────────────────────────────

  it('POST /tenants/c1/files/mkdir with valid body returns 200', async () => {
    const { fileManagerRequest } = await import('./service.js');
    (fileManagerRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 201,
      body: JSON.stringify({ path: '/new-dir', created: true }),
      bodyBuffer: Buffer.from('{}'),
      headers: {},
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/c1/files/mkdir',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: '/new-dir' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
  });

  // ─── Delete ─────────────────────────────────────────────────────────────

  it('POST /tenants/c1/files/delete with valid body returns 200', async () => {
    const { fileManagerRequest } = await import('./service.js');
    (fileManagerRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ deleted: true }),
      bodyBuffer: Buffer.from('{}'),
      headers: {},
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/c1/files/delete',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { path: '/old-file.txt' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
  });

  // ─── Copy ───────────────────────────────────────────────────────────────

  it('POST /tenants/c1/files/copy with valid body returns 200', async () => {
    const { fileManagerRequest } = await import('./service.js');
    (fileManagerRequest as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ copied: true }),
      bodyBuffer: Buffer.from('{}'),
      headers: {},
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/c1/files/copy',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { sourcePath: '/file.txt', destPath: '/file-copy.txt' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
  });

  // ─── Start ──────────────────────────────────────────────────────────────

  it('POST /tenants/c1/files/start returns 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/c1/files/start',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
  });

  // ─── Stop (admin only) ─────────────────────────────────────────────────

  it('POST /tenants/c1/files/stop with tenant token returns 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/c1/files/stop',
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /tenants/c1/files/stop with admin token returns 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants/c1/files/stop',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.stopped).toBe(true);
  });

  // ─── Download ───────────────────────────────────────────────────────────

  it('GET /tenants/c1/files/download streams binary content through', async () => {
    const binaryContent = Buffer.from('hello world binary content');
    const { streamFromFileManager } = await import('./service.js');
    (streamFromFileManager as ReturnType<typeof vi.fn>).mockImplementationOnce(async (
      _kc: string | undefined,
      _ns: string,
      _path: string,
      tenantRes: import('node:http').ServerResponse,
    ) => {
      tenantRes.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="test.txt"',
      });
      tenantRes.end(binaryContent);
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/c1/files/download?path=/test.txt',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(Buffer.from(res.rawPayload)).toEqual(binaryContent);
  });

  // ─── Storage-op guard ──────────────────────────────────────────────────
  // While a destructive PVC resize is quiescing the namespace, file-manager
  // start/access must be refused so the tenant-panel keepalive can't restart
  // the sidecar and hang the resize. status + stop stay reachable.

  describe('blocked while a storage operation is in progress', () => {
    afterAll(() => { tenantRows = [mockTenant]; });

    it('POST …/files/start returns 409 STORAGE_OP_IN_PROGRESS', async () => {
      tenantRows = [{ ...mockTenant, storageLifecycleState: 'quiescing' }];
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/files/start',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('STORAGE_OP_IN_PROGRESS');
    });

    it('GET …/files (list) returns 409 during a resize', async () => {
      tenantRows = [{ ...mockTenant, storageLifecycleState: 'restoring' }];
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/c1/files',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('STORAGE_OP_IN_PROGRESS');
    });

    it('GET …/files/status stays reachable (200) during a resize', async () => {
      tenantRows = [{ ...mockTenant, storageLifecycleState: 'snapshotting' }];
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tenants/c1/files/status',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('POST …/files/stop stays reachable (200) during a resize', async () => {
      tenantRows = [{ ...mockTenant, storageLifecycleState: 'quiescing' }];
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/files/stop',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('allows access again once the op has rolled back to failed', async () => {
      tenantRows = [{ ...mockTenant, storageLifecycleState: 'failed' }];
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tenants/c1/files/start',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
