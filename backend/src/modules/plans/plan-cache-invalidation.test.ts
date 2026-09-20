/**
 * Editing a plan must be visible in the plan list immediately.
 *
 * Reported as "I cannot update hosting plan details — no error shown but the
 * new values don't persist". The edit persisted perfectly. `GET /api/v1/plans`
 * is unauthenticated, so it sits behind a server-side response cache, and no
 * mutation dropped that entry — so for the next FIVE MINUTES the list the
 * panel re-read returned the pre-edit numbers. Reproduced on DEV:
 *
 *     PATCH            -> 200, body says memoryLimit=1.00
 *     database         -> starter | 1.00          (the write landed)
 *     GET /plans       -> x-cache: HIT, memoryLimit=0.25
 *
 * Nothing failed, so nothing was reported, and the screen said the edit had
 * been thrown away.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// The route declares `onRequest: [authenticate, requireRole(...)]`, which 401s
// without a real Bearer token. This test is about the response cache, not the
// gate, so both are stubbed to pass-through.
vi.mock('../../middleware/auth.js', () => ({
  authenticate: async () => {},
  requireRole: () => async () => {},
  requirePanel: () => async () => {},
}));

const { planRoutes } = await import('./routes.js');
import { cacheOnSendHook, getCacheStore, clearCache } from '../../middleware/cache.js';

const PLAN = {
  id: 'p1', code: 'starter', name: 'Starter', description: null,
  cpuLimit: '0.25', memoryLimit: '0.25', storageLimit: '10.00',
  bandwidthGbLimit: 100, monthlyPriceUsd: '5.00', maxSubUsers: 3,
  maxMailboxes: 50, maxMailboxSizeMb: 1024, emailHourlySendLimit: 50,
  emailDailySendLimit: 100, allowCustomContainers: false, status: 'active',
  features: {},
};

function buildApp(): FastifyInstance {
  const app = Fastify();
  const rows = [{ ...PLAN }];
  const db = {
    select: () => ({
      from: () => {
        const p = Promise.resolve(rows) as Promise<unknown> & { where: () => Promise<unknown> };
        p.where = () => Promise.resolve(rows);
        return p;
      },
    }),
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { Object.assign(rows[0], v); } }) }),
    insert: () => ({ values: async () => undefined }),
  };
  app.decorate('db', db as never);
  app.addHook('onSend', cacheOnSendHook);
  app.register(planRoutes, { prefix: '/api/v1' });
  return app;
}

let app: FastifyInstance;
beforeEach(async () => { clearCache(); app = buildApp(); await app.ready(); });
afterEach(async () => { await app.close(); clearCache(); });

describe('plan list cache', () => {
  it('serves the list from cache on a second read', async () => {
    // The cache is real and does what it says — establishing that first, so
    // the next test cannot pass simply because caching is broken.
    await app.inject({ method: 'GET', url: '/api/v1/plans' });
    const second = await app.inject({ method: 'GET', url: '/api/v1/plans' });
    expect(second.headers['x-cache']).toBe('HIT');
  });

  it('drops the cached list when a plan is updated', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/plans' });
    expect(getCacheStore().has('GET:/api/v1/plans')).toBe(true);

    await app.inject({
      method: 'PATCH', url: '/api/v1/admin/plans/p1',
      payload: { memory_limit: '1.00' },
    });

    expect(getCacheStore().has('GET:/api/v1/plans')).toBe(false);
  });

  it('the next read after an update shows the NEW value, not a cache hit', async () => {
    // The assertion the operator actually cares about.
    await app.inject({ method: 'GET', url: '/api/v1/plans' });
    await app.inject({
      method: 'PATCH', url: '/api/v1/admin/plans/p1',
      payload: { memory_limit: '1.00' },
    });
    const after = await app.inject({ method: 'GET', url: '/api/v1/plans' });
    expect(after.headers['x-cache']).not.toBe('HIT');
    expect(JSON.parse(after.body).data[0].memoryLimit).toBe('1.00');
  });

  it('drops the cached list when a plan is deprecated', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/plans' });
    await app.inject({ method: 'DELETE', url: '/api/v1/admin/plans/p1' });
    expect(getCacheStore().has('GET:/api/v1/plans')).toBe(false);
  });
});
