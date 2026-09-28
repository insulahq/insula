import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { planRoutes } from './routes.js';

const mockPlans = [
  { id: 'p1', name: 'Starter', cpu: '0.5', memory: '512Mi', storage: '5Gi', price_monthly: 9.99 },
  { id: 'p2', name: 'Pro', cpu: '2', memory: '4Gi', storage: '50Gi', price_monthly: 29.99 },
];

describe('plan routes', () => {
  let app: FastifyInstance;
  let orderedBy: unknown[] = [];

  beforeAll(async () => {
    app = Fastify();

    // The chain the route actually builds. A `from()` that resolves
    // directly would have kept passing after the route gained an
    // `orderBy` — and an unordered list is the bug, so the fake has to
    // model the call that fixes it.
    const fromFn = () => ({
      orderBy: (...cols: unknown[]) => {
        orderedBy = cols;
        return Promise.resolve(mockPlans);
      },
    });
    const selectFn = () => ({ from: fromFn });

    app.decorate('db', { select: selectFn });
    app.register(planRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/plans should return plan list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/plans',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toEqual(mockPlans);
  });

  /**
   * ★ The list must be ORDERED.
   *
   * A bare SELECT returns rows in physical order, and Postgres rewrites a
   * tuple on UPDATE — so saving a plan moves it. Reproduced on production:
   * touching `premium` without changing a value moved it from the third
   * row to the second. The admin panel's Edit button is per-row, so the
   * operator clicks "the second plan", saves, and next time the second
   * plan is a different one. Nothing in the panel was wrong; the list
   * under it had reordered.
   */
  it('orders the list, so the rows do not move when a plan is saved', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/plans?cachebust=1' });
    expect(orderedBy.length).toBeGreaterThanOrEqual(2);
  });

  it('orders TOTALLY — a price tie must not fall back to physical order', async () => {
    // Two plans at the same price is ordinary (a promo and its successor),
    // and a partial order puts them back at the mercy of the heap. Two
    // DISTINCT sort terms is what makes the order total; compared by
    // identity because a drizzle column is circular and cannot be
    // serialised.
    await app.inject({ method: 'GET', url: '/api/v1/plans?cachebust=2' });
    expect(new Set(orderedBy).size).toBe(orderedBy.length);
  });
});
