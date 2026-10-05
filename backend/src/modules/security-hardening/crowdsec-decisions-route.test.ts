/**
 * GET /admin/security/crowdsec/decisions — the operator's name reaches the
 * panel, and a failed name lookup never empties the list of what is blocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import type { CrowdsecDecision } from '@insula/api-contracts';
import { errorHandler } from '../../middleware/error-handler.js';
import * as crowdsec from './crowdsec.js';
import { buildSecurityHardeningRoutes } from './routes.js';

const ALICE = '11111111-2222-4333-8444-555555555555';

const operatorBan: CrowdsecDecision = {
  id: 11,
  origin: 'cscli',
  type: 'ban',
  scope: 'Ip',
  value: '203.0.113.60',
  scenario: `admin-panel:${ALICE}:probing /.env`,
  duration: '3h59m',
  expiresAt: null,
  manualByOperator: true,
  staticByOperator: false,
  autoBanned: false,
  simulated: false,
  addedBy: 'operator',
  operatorReason: 'probing /.env',
  addedByName: null,
};

const usersWhere = vi.fn();
const fakeDb = {
  select: () => ({ from: () => ({ where: usersWhere }) }),
};

describe('GET /admin/security/crowdsec/decisions', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    app.decorate('config', { KUBECONFIG_PATH: undefined });
    app.setErrorHandler(errorHandler);
    await app.register(buildSecurityHardeningRoutes({ db: fakeDb as never }), { prefix: '/api/v1' });
    await app.ready();
    token = app.jwt.sign({ sub: ALICE, role: 'super_admin', panel: 'admin', iat: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => { await app.close(); });
  afterEach(() => { vi.restoreAllMocks(); usersWhere.mockReset(); });

  const get = () => app.inject({
    method: 'GET',
    url: '/api/v1/admin/security/crowdsec/decisions',
    headers: { authorization: `Bearer ${token}` },
  });

  const stubList = () => vi.spyOn(crowdsec, 'listDecisions').mockResolvedValue({
    decisions: [operatorBan], totalActive: 1, totalMatching: 1, limit: 1, offset: 0,
  });

  it('names the operator on each manual ban', async () => {
    stubList();
    usersWhere.mockResolvedValue([{ id: ALICE, fullName: 'Alice Admin', email: 'alice@example.test' }]);
    const res = await get();
    expect(res.statusCode).toBe(200);
    const [d] = res.json().data.decisions;
    expect(d.addedByName).toBe('Alice Admin (alice@example.test)');
    expect(d.operatorReason).toBe('probing /.env');
  });

  it('still lists every ban when the name lookup fails', async () => {
    stubList();
    usersWhere.mockRejectedValue(new Error('connection terminated'));
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.decisions).toHaveLength(1);
    expect(body.decisions[0].addedByName).toBeNull();
    expect(body.totalMatching).toBe(1);
  });
});
