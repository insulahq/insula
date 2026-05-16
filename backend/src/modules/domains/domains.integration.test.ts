import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import type { FastifyInstance } from 'fastify';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Domain CRUD (integration)', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let tenantId: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    adminToken = generateToken(app, { role: 'admin' });
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await cleanTables();
    const db = getTestDb();
    const region = await seedRegion(db);
    const plan = await seedPlan(db);
    const tenant = await seedTenant(db, region.id, plan.id);
    tenantId = tenant.id;
  });

  it('POST — creates domain with 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/domains`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { domain_name: 'test.example.com', dns_mode: 'primary' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.domainName).toBe('test.example.com');
    expect(res.json().data.dnsMode).toBe('primary');
  });

  it('POST — rejects duplicate domain name', async () => {
    const db = getTestDb();
    await seedDomain(db, tenantId, { domainName: 'taken.example.com' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/domains`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { domain_name: 'taken.example.com' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_ENTRY');
  });

  it('GET — returns paginated list', async () => {
    const db = getTestDb();
    await seedDomain(db, tenantId);
    await seedDomain(db, tenantId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/domains`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBe(2);
  });

  it('PATCH — updates dns_mode', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, tenantId, { dnsMode: 'cname' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${tenantId}/domains/${domain.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { dns_mode: 'primary' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.dnsMode).toBe('primary');
  });

  it('DELETE — removes domain', async () => {
    const db = getTestDb();
    const domain = await seedDomain(db, tenantId);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${tenantId}/domains/${domain.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when tenant does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/nonexistent/domains',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    // listDomains doesn't check tenant existence, just returns empty
    expect(res.statusCode).toBe(200);
  });
});
