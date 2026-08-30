/**
 * DELETE /api/v1/tenants/:tenantId/restore-carts/:id
 *
 * The tenant panel can now discard a restore cart. Carts already expire after
 * DRAFT_CART_RETENTION_DAYS, but only DRAFTS do, and waiting a week to clear a
 * mistake is not a UX — so this is the explicit gesture.
 *
 * The admin side had this route; the tenant side did not. These cases pin the
 * boundaries that matter: another tenant's cart, and a restore that is
 * mid-flight.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';

const { tenantRestoreRoutes } = await import('./tenant-routes.js');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const CART_ID = '33333333-3333-4333-8333-333333333333';

/** Row the SELECT chain resolves to, swapped per test. */
let cartRow: Record<string, unknown> | null = null;
/** Cart ids passed to db.delete(...).where(...). */
let deleted: string[] = [];

function makeDb(): unknown {
  const chain = (rows: () => unknown[]): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'innerJoin', 'where', 'limit', 'orderBy', 'set', 'returning']) {
      c[m] = () => chain(rows);
    }
    c.then = (resolve: (v: unknown) => void) => resolve(rows());
    return c;
  };
  return {
    select: () => chain(() => (cartRow ? [cartRow] : [])),
    delete: () => ({
      where: () => {
        deleted.push(CART_ID);
        return { then: (resolve: (v: unknown) => void) => resolve([]) };
      },
    }),
  };
}

describe('DELETE tenant restore cart', () => {
  let app: FastifyInstance;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', makeDb() as never);
    await app.register(tenantRestoreRoutes, { prefix: '/api/v1' });
    await app.ready();

    const claims = (tenantId: string, sub: string) => ({
      sub, role: 'tenant_admin', panel: 'tenant', tenantId, iat: Math.floor(Date.now() / 1000),
    });
    tokenA = app.jwt.sign(claims(TENANT_A, 'user-a'));
    tokenB = app.jwt.sign(claims(TENANT_B, 'user-b'));
  });

  afterAll(async () => { await app.close(); });

  const del = (tenantId: string, token: string) => app.inject({
    method: 'DELETE',
    url: `/api/v1/tenants/${tenantId}/restore-carts/${CART_ID}`,
    headers: { authorization: `Bearer ${token}` },
  });

  it('deletes a draft cart and returns 204', async () => {
    cartRow = { id: CART_ID, tenantId: TENANT_A, status: 'draft' };
    deleted = [];
    const res = await del(TENANT_A, tokenA);
    expect(res.statusCode).toBe(204);
    expect(deleted).toEqual([CART_ID]);
  });

  it('deletes a failed cart — a dead cart is exactly what a tenant wants gone', async () => {
    cartRow = { id: CART_ID, tenantId: TENANT_A, status: 'failed' };
    deleted = [];
    expect((await del(TENANT_A, tokenA)).statusCode).toBe(204);
    expect(deleted).toEqual([CART_ID]);
  });

  it('refuses to delete an EXECUTING cart (409) and does not touch the row', async () => {
    // The restore is mid-flight writing into the tenant's live namespace;
    // deleting the record orphans it with nothing to report against.
    cartRow = { id: CART_ID, tenantId: TENANT_A, status: 'executing' };
    deleted = [];
    const res = await del(TENANT_A, tokenA);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('RESTORE_CART_EXECUTING');
    expect(deleted).toEqual([]);
  });

  it('404s for a cart that does not exist', async () => {
    cartRow = null;
    deleted = [];
    expect((await del(TENANT_A, tokenA)).statusCode).toBe(404);
    expect(deleted).toEqual([]);
  });

  it('refuses another tenant’s cart and does not delete it', async () => {
    // Cart belongs to A; B asks for it under B's own path.
    cartRow = { id: CART_ID, tenantId: TENANT_A, status: 'draft' };
    deleted = [];
    const res = await del(TENANT_B, tokenB);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(deleted).toEqual([]);
  });

  it('requires authentication', async () => {
    cartRow = { id: CART_ID, tenantId: TENANT_A, status: 'draft' };
    deleted = [];
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${TENANT_A}/restore-carts/${CART_ID}`,
    });
    expect(res.statusCode).toBe(401);
    expect(deleted).toEqual([]);
  });
});
