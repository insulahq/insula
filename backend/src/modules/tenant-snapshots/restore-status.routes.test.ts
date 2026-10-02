/**
 * Authorization for GET /tenants/:tenantId/snapshots/restore-status/:operationId
 * — the tenant-scoped poll both panels' restore progress modals read.
 *
 * Boundaries pinned here, through the REAL auth middleware + JWT:
 *   1. no token                                  → 401
 *   2. tenant A token, tenant B in the path      → 403 CLIENT_ACCESS_DENIED
 *   3. tenant A token, A in the path, B's op id  → 404 (the op is B's)
 *   4. tenant A token, A's own op                → 200, sanitized view
 *   5. operator token                            → 200, full view
 *
 * The DB stub deliberately IGNORES the WHERE clause and hands back whatever
 * row the test planted — so (3) proves the service re-checks ownership on the
 * row itself instead of trusting the query filter alone.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from '../../middleware/error-handler.js';
import { registerAuth } from '../../middleware/auth.js';
import { tenantSnapshotsRoutes } from './routes.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const OP_OF_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const OP_OF_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const t0 = new Date('2026-01-01T00:00:00.000Z');
const opRow = (id: string, tenantId: string) => ({
  id,
  tenantId,
  opType: 'restore',
  state: 'restoring',
  progressPct: 58,
  progressMessage: 'Restoring',
  lastError: null,
  params: { mode: 'snapshot_revert', label: `snap of ${tenantId.slice(0, 4)}`, volumeName: 'pvc-internal' },
  progressSteps: {
    steps: [
      { key: 'quiesce', ok: true, startedAt: t0.toISOString(), finishedAt: t0.toISOString(), detail: null },
      { key: 'attach-maintenance', ok: true, startedAt: t0.toISOString(), finishedAt: t0.toISOString(), detail: 'node=node-a' },
    ],
    inFlight: { key: 'wait-maintenance', startedAt: t0.toISOString() },
  },
  createdAt: t0,
  completedAt: null,
});

// Which op row the stub returns for the next lookup, keyed by op id only —
// tenant filtering is the code under test, not the stub's job.
const OPS: Record<string, ReturnType<typeof opRow>> = {
  [OP_OF_A]: opRow(OP_OF_A, TENANT_A),
  [OP_OF_B]: opRow(OP_OF_B, TENANT_B),
};
let lookupId: string | null = null;

function stubDb(): unknown {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy']) chain[m] = () => chain;
  chain.limit = () => Promise.resolve(lookupId && OPS[lookupId] ? [OPS[lookupId]] : []);
  return chain;
}

describe('restore-status route — tenant scoping', () => {
  let app: FastifyInstance;
  let tokenA: string;
  let adminToken: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', stubDb() as never);
    app.decorate('config', {} as never);
    await app.register(tenantSnapshotsRoutes, { prefix: '/api/v1' });
    await app.ready();
    const iat = Math.floor(Date.now() / 1000);
    tokenA = app.jwt.sign({ sub: 'user-a', role: 'tenant_admin', panel: 'tenant', tenantId: TENANT_A, iat });
    adminToken = app.jwt.sign({ sub: 'admin-1', role: 'super_admin', panel: 'admin', iat });
  });

  afterAll(async () => { await app.close(); });

  const get = (tenantId: string, opId: string, token?: string) => {
    lookupId = opId;
    return app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/snapshots/restore-status/${opId}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  };

  it('requires a token', async () => {
    expect((await get(TENANT_A, OP_OF_A)).statusCode).toBe(401);
  });

  it('★ tenant A cannot address tenant B in the path', async () => {
    const res = await get(TENANT_B, OP_OF_B, tokenA);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error?.code).toBe('CLIENT_ACCESS_DENIED');
  });

  it("★ tenant A cannot read tenant B's restore through its own path", async () => {
    const res = await get(TENANT_A, OP_OF_B, tokenA);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error?.code).toBe('OPERATION_NOT_FOUND');
    expect(res.body).not.toContain(TENANT_B.slice(0, 4));
  });

  it('tenant A reads its own restore — steps, without the operator detail', async () => {
    const res = await get(TENANT_A, OP_OF_A, tokenA);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.operationId).toBe(OP_OF_A);
    expect(data.steps.find((s: { key: string }) => s.key === 'wait-maintenance').state).toBe('running');
    expect(res.body).not.toContain('node-a');
    expect(res.body).not.toContain('pvc-internal');
  });

  it('an operator reads any tenant\'s restore with the step detail', async () => {
    const res = await get(TENANT_B, OP_OF_B, adminToken);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.steps.find((s: { key: string }) => s.key === 'attach-maintenance').detail).toBe('node=node-a');
  });

  it('an operator still cannot read an op under the wrong tenant', async () => {
    expect((await get(TENANT_A, OP_OF_B, adminToken)).statusCode).toBe(404);
  });
});
