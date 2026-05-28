import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const sampleCategory = {
  id: 'security.password_changed',
  displayName: 'Password changed',
  description: 'desc',
  audience: 'tenant' as const,
  defaultSeverity: 'info' as const,
  defaultChannels: ['in_app', 'email'] as ('in_app' | 'email')[],
  isMandatory: true,
  gdprBasis: 'contract' as const,
  rateLimitWindowS: null,
  rateLimitMax: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};
const sampleTemplate = {
  id: 'tpl-1',
  categoryId: 'security.password_changed',
  channel: 'in_app' as const,
  locale: 'en',
  subjectTemplate: null,
  bodyTemplate: 'B',
  bodyFormat: 'plaintext' as const,
  variablesSchema: null,
  isActive: true,
  isSeed: true,
  version: 1,
  editedByUserId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const listCategoriesMock = vi.fn().mockResolvedValue([sampleCategory]);
const updateCategoryMock = vi.fn().mockResolvedValue(sampleCategory);
vi.mock('./categories/service.js', () => ({
  listCategories: listCategoriesMock,
  updateCategory: updateCategoryMock,
  getCategory: vi.fn().mockResolvedValue(sampleCategory),
}));

const listTemplatesMock = vi.fn().mockResolvedValue([sampleTemplate]);
const getTemplateMock = vi.fn().mockResolvedValue(sampleTemplate);
const updateTemplateMock = vi.fn().mockResolvedValue(sampleTemplate);
const previewTemplateMock = vi.fn().mockResolvedValue({ subject: 's', body: 'b', bodyFormat: 'plaintext' });
const restoreSeedTemplateMock = vi.fn().mockResolvedValue(sampleTemplate);
vi.mock('./templates/service.js', () => ({
  listTemplates: listTemplatesMock,
  getTemplate: getTemplateMock,
  updateTemplate: updateTemplateMock,
  previewTemplate: previewTemplateMock,
  restoreSeedTemplate: restoreSeedTemplateMock,
}));

const { notificationAdminRoutes } = await import('./routes-admin.js');

describe('admin notification routes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let tenantToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([]) }) }),
        }),
      }),
    };
    app.decorate('db', fakeDb);
    await app.register(notificationAdminRoutes, { prefix: '/api/v1' });
    await app.ready();

    adminToken = app.jwt.sign({
      sub: 'admin-1',
      role: 'super_admin',
      panel: 'admin',
      iat: Math.floor(Date.now() / 1000),
    });
    tenantToken = app.jwt.sign({
      sub: 'tenant-1',
      role: 'tenant_admin',
      panel: 'tenant',
      tenantId: 't1',
      iat: Math.floor(Date.now() / 1000),
    });
  });

  afterAll(async () => { await app.close(); });

  it('rejects unauthenticated', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/admin/notifications/categories' });
    expect(r.statusCode).toBe(401);
  });

  it('rejects tenant-panel tokens', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/notifications/categories',
      headers: { authorization: `Bearer ${tenantToken}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('GET /admin/notifications/categories', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/notifications/categories',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual([sampleCategory]);
  });

  it('PATCH /admin/notifications/categories/:id', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/notifications/categories/security.password_changed',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { defaultSeverity: 'warning' },
    });
    expect(r.statusCode).toBe(200);
    expect(updateCategoryMock).toHaveBeenCalledWith(
      expect.anything(),
      'security.password_changed',
      { defaultSeverity: 'warning' },
      { actorId: 'admin-1' },
    );
  });

  it('PATCH /admin/notifications/categories/:id rejects invalid body', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/notifications/categories/x',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { defaultSeverity: 'WRONG' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('GET /admin/notifications/templates with filters', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/notifications/templates?categoryId=security.password_changed&channel=in_app',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual([sampleTemplate]);
  });

  it('GET /admin/notifications/templates/:id', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/notifications/templates/tpl-1',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
  });

  it('PATCH /admin/notifications/templates/:id', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/notifications/templates/tpl-1',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { bodyTemplate: 'New body' },
    });
    expect(r.statusCode).toBe(200);
  });

  it('POST /admin/notifications/templates/:id/preview', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/notifications/templates/tpl-1/preview',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { variables: { userName: 'Alice' } },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ body: 'b' });
  });

  it('POST /admin/notifications/templates/:id/restore-seed', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/notifications/templates/tpl-1/restore-seed',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(restoreSeedTemplateMock).toHaveBeenCalled();
  });

  it('GET /admin/notifications/deliveries returns paginated list', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/notifications/deliveries?limit=10',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual([]);
    expect(r.json().pagination).toMatchObject({ has_more: false, page_size: 10 });
  });
});
