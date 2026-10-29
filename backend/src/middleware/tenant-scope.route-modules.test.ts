/**
 * A tenant token reaches its own tenant only — on every route of the modules
 * that once named the tenant path parameter `:cid`.
 *
 * requireTenantAccess() reads `:tenantId` / `:id` and nothing else, so those
 * modules (route OIDC, OIDC providers, route mTLS, deployment network access,
 * Ziti and zrok providers) checked the caller's role but never its tenant: a
 * tenant_admin could read, change or delete another tenant's settings by
 * putting that tenant's id in the URL. ci-tenant-scope-check.sh now fails on
 * the parameter name; this drives the real plugins through the real hooks.
 *
 * The route list is read from each module's source, so a route added later is
 * covered without editing this file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { errorHandler } from './error-handler.js';
import { registerAuth } from './auth.js';
import { ingressAuthRoutes } from '../modules/ingress-auth/routes.js';
import { oidcProvidersRoutes } from '../modules/ingress-auth/providers-routes.js';
import { ingressMtlsRoutes } from '../modules/ingress-mtls/routes.js';
import { deploymentNetworkAccessRoutes } from '../modules/deployment-network-access/routes.js';
import { zrokProvidersRoutes } from '../modules/zrok-providers/routes.js';
import { zitiProvidersRoutes } from '../modules/ziti-providers/routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES: ReadonlyArray<{ file: string; plugin: FastifyPluginAsync }> = [
  { file: 'ingress-auth/routes.ts', plugin: ingressAuthRoutes },
  { file: 'ingress-auth/providers-routes.ts', plugin: oidcProvidersRoutes },
  { file: 'ingress-mtls/routes.ts', plugin: ingressMtlsRoutes },
  { file: 'deployment-network-access/routes.ts', plugin: deploymentNetworkAccessRoutes },
  { file: 'zrok-providers/routes.ts', plugin: zrokProvidersRoutes },
  { file: 'ziti-providers/routes.ts', plugin: zitiProvidersRoutes },
];

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
interface Route { readonly method: Method; readonly path: string }

function routesOf(file: string): Route[] {
  const src = readFileSync(join(HERE, '../modules', file), 'utf8');
  return [...src.matchAll(/app\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)].map((m) => ({
    method: m[1]!.toUpperCase() as Method,
    path: m[2]!,
  }));
}

function urlFor(path: string, tenantId: string): string {
  return `/api/v1${path.replace(':tenantId', tenantId).replace(/:[A-Za-z]+/g, 'x')}`;
}

/** Any database use means a handler ran. */
const handlerRan = (): never => { throw new Error('handler reached the database'); };
const tripwireDb = Object.fromEntries(
  ['select', 'selectDistinct', 'insert', 'update', 'delete', 'execute', 'transaction', 'query'].map((k) => [k, handlerRan]),
);

describe('tenant-scoped route modules refuse another tenant', () => {
  let app: FastifyInstance;
  let ownTenant: string;
  let otherTenant: string;
  let staff: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    registerAuth(app);
    app.setErrorHandler(errorHandler);
    app.decorate('db', tripwireDb);
    for (const m of MODULES) await app.register(m.plugin, { prefix: '/api/v1' });
    await app.ready();
    const iat = Math.floor(Date.now() / 1000);
    ownTenant = app.jwt.sign({ sub: 'ta-a', role: 'tenant_admin', panel: 'tenant', tenantId: 'tenant-a', iat });
    otherTenant = 'tenant-b';
    staff = app.jwt.sign({ sub: 'adm', role: 'admin', panel: 'admin', iat });
  });

  afterAll(async () => { await app.close(); });

  it('finds every module\'s routes, all with a :tenantId parameter', () => {
    for (const m of MODULES) {
      const routes = routesOf(m.file);
      expect(routes.length, m.file).toBeGreaterThan(0);
      // Every registration this file makes is one the parser above read: a
      // route written any other way (double quotes, a const path, app.route)
      // would otherwise escape this test silently.
      const src = readFileSync(join(HERE, '../modules', m.file), 'utf8');
      const registrations = (src.match(/app\.(get|post|patch|put|delete|route)\(/g) ?? []).length;
      expect(routes.length, `${m.file}: routes read vs registrations`).toBe(registrations);
      for (const r of routes) expect(r.path, `${m.file} ${r.path}`).toMatch(/^\/tenants\/:tenantId\//);
    }
  });

  for (const m of MODULES) {
    for (const r of routesOf(m.file)) {
      it(`★ ${r.method} ${r.path}: 403 for a tenant token naming another tenant, before any handler`, async () => {
        const res = await app.inject({
          method: r.method,
          url: urlFor(r.path, otherTenant),
          headers: { authorization: `Bearer ${ownTenant}` },
          payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe('CLIENT_ACCESS_DENIED');
      });

      it(`${r.method} ${r.path}: the caller's own tenant and platform staff get past the guard`, async () => {
        for (const [token, tenant] of [[ownTenant, 'tenant-a'], [staff, otherTenant]] as const) {
          const res = await app.inject({
            method: r.method,
            url: urlFor(r.path, tenant),
            headers: { authorization: `Bearer ${token}` },
            payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {},
          });
          // Past the guard the handler runs (and here trips the stub DB, or
          // refuses the empty body): anything but the tenant refusal.
          expect(res.statusCode, res.body).not.toBe(401);
          expect(res.json()?.error?.code ?? null).not.toBe('CLIENT_ACCESS_DENIED');
        }
      });
    }
  }
});
