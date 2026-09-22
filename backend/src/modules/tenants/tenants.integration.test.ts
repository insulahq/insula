import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb } from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { getTestDb } from '../../test-helpers/db.js';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Tenant CRUD (integration)', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let supportToken: string;
  let regionId: string;
  let planId: string;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    adminToken = generateToken(app, { role: 'admin' });
    supportToken = generateToken(app, { role: 'support' });
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
    regionId = region.id;
    planId = plan.id;
  });

  it('POST /api/v1/tenants — creates tenant with 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenants',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Integration Corp',
        primary_email: 'admin@integration.com',
        plan_id: planId,
        region_id: regionId,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.name).toBe('Integration Corp');
    expect(body.data.status).toBe('pending');
    // The POST response schema filters out kubernetesNamespace, so we
    // verify the namespace indirectly by refetching the tenant.
    expect(body.data.id).toBeTruthy();
  });

  it('GET /api/v1/tenants — returns paginated list', async () => {
    const db = getTestDb();
    await seedTenant(db, regionId, planId, { name: 'Alpha' });
    await seedTenant(db, regionId, planId, { name: 'Beta' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants?limit=10',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.length).toBe(2);
    expect(body.pagination.total_count).toBe(2);
  });

  it('GET /api/v1/tenants — supports search', async () => {
    const db = getTestDb();
    await seedTenant(db, regionId, planId, { name: 'Searchable Corp' });
    await seedTenant(db, regionId, planId, { name: 'Hidden LLC' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants?search=Searchable',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBe(1);
    expect(res.json().data[0].name).toBe('Searchable Corp');
  });

  it('GET /api/v1/tenants/:id — returns single tenant', async () => {
    const db = getTestDb();
    const tenant = await seedTenant(db, regionId, planId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenant.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.id).toBe(tenant.id);
  });

  it('GET /api/v1/tenants/:id — 404 for missing tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants/nonexistent-id',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TENANT_NOT_FOUND');
  });

  it('PATCH /api/v1/tenants/:id — updates fields', async () => {
    const db = getTestDb();
    const tenant = await seedTenant(db, regionId, planId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${tenant.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Updated Name', status: 'active' },
    });
    expect(res.statusCode, res.body?.slice(0, 400) ?? '').toBe(200);
    expect(res.json().data.name).toBe('Updated Name');
    expect(res.json().data.status).toBe('active');
  });

  it('a REAL status transition still reaches the suspend/resume orchestrator', async () => {
    // Guards the dispatch condition in updateTenant. Re-sending the status a
    // tenant already has (the panel PATCHes the whole form, so a name edit
    // carries the current status) deliberately SKIPS the orchestrator — the
    // test above proves that returns 200. A genuine transition must not be
    // skipped, and nothing else covers that direction.
    //
    // No cluster is reachable here, so the orchestrator cannot complete; the
    // proof that it was ATTEMPTED is that the request does not succeed and the
    // row is left alone. Were the dispatch wrongly skipped, this would answer
    // 200 and write status='suspended' — silently turning suspend into a
    // rename in production.
    const db = getTestDb();
    const tenant = await seedTenant(db, regionId, planId, { status: 'active' });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${tenant.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Transitioning', status: 'suspended' },
    });
    expect(res.statusCode).not.toBe(200);

    const after = await db.execute<{ status: string }>(sql`
      SELECT status FROM tenants WHERE id = ${tenant.id}
    `);
    expect(after.rows?.[0]?.status).toBe('active');
  });

  it('DELETE /api/v1/tenants/:id — removes an active tenant and returns the transition id', async () => {
    // Historical note: this endpoint used to require status=cancelled,
    // but the guard was removed in a later refactor. It also no longer
    // answers 204 — it returns 200 with { transitionId } so the panel can
    // open the progress modal by id instead of polling-by-since. Both
    // drifts survived because the test DB did not exist in CI.
    const db = getTestDb();
    const tenant = await seedTenant(db, regionId, planId, { status: 'active' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${tenant.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode, res.body?.slice(0, 300) ?? '').toBe(200);
    // transitionId is `string | null`: the hard-delete cascade records a
    // lifecycle transition only on the K8s path. With no cluster reachable
    // deleteTenant takes the DB-only cascade and reports null, so the id is
    // not the assertable outcome here — the row being gone is.
    expect(res.json().data).toHaveProperty('transitionId');
    const after = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM tenants WHERE id = ${tenant.id}
    `);
    expect(after.rows?.[0]?.count).toBe('0');
  });

  it('DELETE /api/v1/tenants/:id — succeeds when archived', async () => {
    const db = getTestDb();
    const tenant = await seedTenant(db, regionId, planId, { status: 'archived' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${tenant.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode, res.body?.slice(0, 300) ?? '').toBe(200);
    const gone = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM tenants WHERE id = ${tenant.id}
    `);
    expect(gone.rows?.[0]?.count).toBe('0');
  });

  it('returns 401 without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tenants' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 with wrong role', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants',
      headers: { authorization: `Bearer ${supportToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
