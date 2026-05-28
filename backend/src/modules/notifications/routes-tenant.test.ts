import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const prefs = { preferences: [] };
const settings = {
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: null,
  digestMode: 'immediate' as const,
  locale: 'en',
};

vi.mock('./preferences/service.js', () => ({
  getUserPreferences: vi.fn().mockResolvedValue(prefs),
  updateUserPreferences: vi.fn().mockResolvedValue(prefs),
  getUserSettings: vi.fn().mockResolvedValue(settings),
  updateUserSettings: vi.fn().mockResolvedValue({ ...settings, locale: 'fr' }),
}));

const { notificationUserRoutes } = await import('./routes-tenant.js');

describe('tenant notification routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    await app.register(notificationUserRoutes, { prefix: '/api/v1' });
    await app.ready();
    token = app.jwt.sign({ sub: 'u1', role: 'tenant_admin', panel: 'tenant', tenantId: 't1', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => { await app.close(); });

  it('rejects without auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/notifications/preferences' });
    expect(r.statusCode).toBe(401);
  });

  it('GET /notifications/preferences', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/preferences',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual(prefs);
  });

  it('PATCH /notifications/preferences', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/notifications/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { updates: [{ categoryId: 'security.password_changed', channel: 'email', enabled: false }] },
    });
    expect(r.statusCode).toBe(200);
  });

  it('PATCH /notifications/preferences rejects invalid body', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/notifications/preferences',
      headers: { authorization: `Bearer ${token}` },
      payload: { updates: [] }, // min(1)
    });
    expect(r.statusCode).toBe(400);
  });

  it('GET /notifications/settings', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(200);
  });

  it('PATCH /notifications/settings', async () => {
    const r = await app.inject({
      method: 'PATCH',
      url: '/api/v1/notifications/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { locale: 'fr' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.locale).toBe('fr');
  });
});
