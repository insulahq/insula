/**
 * The zrok and ziti "test connection" routes are gone, and must stay gone.
 *
 * They fetched whatever URL the request carried and answered with the
 * response — zrok with its body, ziti with its status and size — so any
 * tenant admin could read or probe internal HTTP services through
 * platform-api. A URL ending in `?` defeated the appended path. No panel
 * called them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

describe('tenant tunnel providers — no "test connection" route', () => {
  let app: FastifyInstance;
  let token = '';
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', {});
    const { zrokProvidersRoutes } = await import('./routes.js');
    const { zitiProvidersRoutes } = await import('../ziti-providers/routes.js');
    await app.register(zrokProvidersRoutes, { prefix: '/api/v1' });
    await app.register(zitiProvidersRoutes, { prefix: '/api/v1' });
    await app.ready();
    token = app.jwt.sign({ sub: 'u1', role: 'tenant_admin', panel: 'tenant', tenantId: 't1', iat: Math.floor(Date.now() / 1000) });
  });
  afterAll(async () => {
    fetchSpy.mockRestore();
    await app.close();
  });

  it.each(['zrok-providers', 'ziti-providers'])('POST /tenants/:t/%s/:pid/test is 404 and fetches nothing', async (kind) => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/t1/${kind}/p1/test`,
      headers: { authorization: `Bearer ${token}` },
      payload: { controllerUrl: 'http://10.43.0.1/internal-secret?' },
    });
    expect(res.statusCode).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
