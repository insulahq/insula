import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { regionRoutes } from './routes.js';

const mockRegions = [
  { id: 'r1', code: 'eu-central', name: 'EU Central', provider: 'hetzner', status: 'active', createdAt: new Date('2026-01-01') },
  { id: 'r2', code: 'eu-west', name: 'EU West', provider: 'hetzner', status: 'active', createdAt: new Date('2026-01-01') },
];

describe('region routes', () => {
  let app: FastifyInstance;
  let selectedCols: Record<string, unknown> | undefined;

  beforeAll(async () => {
    app = Fastify();
    const fromFn = () => Promise.resolve(mockRegions);
    const selectFn = (cols?: Record<string, unknown>) => {
      selectedCols = cols;
      return { from: fromFn };
    };
    app.decorate('db', { select: selectFn });
    app.register(regionRoutes, { prefix: '/api/v1' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is a public endpoint (no auth) returning the region list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/regions' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(2);
  });

  it('M5: never selects the internal kubernetes_api_endpoint column', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/regions' });
    expect(selectedCols).toBeDefined();
    expect(Object.keys(selectedCols!)).not.toContain('kubernetesApiEndpoint');
    expect(Object.keys(selectedCols!).sort()).toEqual(['code', 'createdAt', 'id', 'name', 'provider', 'status']);
  });
});
