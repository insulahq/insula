import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { regionRoutes } from './routes.js';

const mockRegions = [
  { id: 'r1', code: 'eu-central', name: 'EU Central', provider: 'hetzner', status: 'active', createdAt: new Date('2026-01-01') },
  { id: 'r2', code: 'eu-west', name: 'EU West', provider: 'hetzner', status: 'active', createdAt: new Date('2026-01-01') },
];

describe('region routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret' });

    // Capture the columns requested so we can assert the internal
    // kubernetes_api_endpoint is never selected (M5).
    let selectedCols: Record<string, unknown> | undefined;
    const fromFn = () => Promise.resolve(mockRegions);
    const selectFn = (cols?: Record<string, unknown>) => {
      selectedCols = cols;
      return { from: fromFn };
    };
    app.decorate('db', { select: selectFn });
    app.decorate('_selectedCols', () => selectedCols);

    app.register(regionRoutes, { prefix: '/api/v1' });
    await app.ready();
    token = app.jwt.sign({ sub: 'u1', role: 'admin', panel: 'admin' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('M5: rejects an unauthenticated request', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/regions' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the region list for an authenticated caller', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/regions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(2);
  });

  it('M5: never selects the internal kubernetes_api_endpoint column', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/v1/regions',
      headers: { authorization: `Bearer ${token}` },
    });
    const cols = (app as unknown as { _selectedCols: () => Record<string, unknown> })._selectedCols();
    expect(cols).toBeDefined();
    expect(Object.keys(cols)).not.toContain('kubernetesApiEndpoint');
    expect(Object.keys(cols).sort()).toEqual(['code', 'createdAt', 'id', 'name', 'provider', 'status']);
  });
});
