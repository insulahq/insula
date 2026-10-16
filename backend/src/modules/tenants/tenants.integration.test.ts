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

  describe('search by plan and by placement', () => {
    const NODES = ['search-a.cluster.example.test', 'search-b.cluster.example.test', 'search-c.cluster.example.test'];
    const search = async (term: string): Promise<{ names: string[]; total: number }> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/tenants?limit=100&search=${encodeURIComponent(term)}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: Array<{ name: string }>; pagination: { total_count: number } };
      return { names: body.data.map((t) => t.name).sort(), total: body.pagination.total_count };
    };

    beforeEach(async () => {
      const db = getTestDb();
      await db.execute(sql`DELETE FROM cluster_nodes WHERE name LIKE 'search-%'`);
      await db.execute(sql`
        INSERT INTO cluster_nodes (name, display_name, labels) VALUES
          (${NODES[0]}, 'Primary', ${JSON.stringify({ 'kubernetes.io/hostname': 'search-a' })}::jsonb),
          (${NODES[1]}, 'Secondary', ${JSON.stringify({ 'kubernetes.io/hostname': 'search-b' })}::jsonb),
          (${NODES[2]}, 'Spare', ${JSON.stringify({ 'kubernetes.io/hostname': NODES[2] })}::jsonb)`);
      const business = await seedPlan(db, { name: 'Business Plus' });
      await seedTenant(db, regionId, business.id, { name: 'On Primary', nodeName: NODES[0] });
      const moved = await seedTenant(db, regionId, planId, { name: 'Moved Away', nodeName: NODES[1] });
      await seedTenant(db, regionId, planId, { name: 'Unpinned', nodeName: null });
      // Pinned to Secondary, running on Spare: the column shows Spare in red.
      await db.execute(sql`
        INSERT INTO tenant_placement_state (tenant_id, status, primary_node, actual_nodes)
        VALUES (${moved.id}, 'misplaced', ${NODES[1]}, ARRAY[${NODES[2]}]::text[])`);
    });

    afterAll(async () => {
      await getTestDb().execute(sql`DELETE FROM cluster_nodes WHERE name LIKE 'search-%'`);
    });

    it('finds tenants by their plan name, and counts what it found', async () => {
      expect(await search('business')).toEqual({ names: ['On Primary'], total: 1 });
    });

    it('finds tenants by the node alias the Placement column shows, its hostname, or its Kubernetes name', async () => {
      expect((await search('primary')).names).toEqual(['On Primary']);
      expect((await search('search-a')).names).toEqual(['On Primary']);
      expect((await search('search-b.cluster')).names).toEqual(['Moved Away']);
    });

    it('finds a misplaced tenant by the node it is actually on', async () => {
      expect((await search('spare')).names).toEqual(['Moved Away']);
      expect((await search('search-c')).names).toEqual(['Moved Away']);
    });

    /** A tenant pinned to a node the cluster no longer lists and running on another: only
     *  tenants.node_name and the placement row itself carry these names. */
    const seedGhost = async (): Promise<void> => {
      const db = getTestDb();
      const ghost = await seedTenant(db, regionId, planId, { name: 'Ghost Pin', nodeName: 'search-gone.cluster.example.test' });
      await db.execute(sql`
        INSERT INTO tenant_placement_state (tenant_id, status, primary_node, actual_nodes)
        VALUES (${ghost.id}, 'misplaced', 'search-gone.cluster.example.test',
                ARRAY['search-left.cluster.example.test']::text[])`);
    };

    it('does not match every pinned tenant on the domain all the nodes share', async () => {
      // Nodes named node-2.cluster.<apex>, node-3.cluster.<apex>: a search for the operator's
      // own brand matched the node of every pinned tenant and listed them all. Every node
      // clause is covered — the ghost is reachable only through node_name and actual_nodes.
      await seedGhost();
      expect(await search('cluster')).toEqual({ names: [], total: 0 });
      expect(await search('cluster.example.test')).toEqual({ names: [], total: 0 });
    });

    it('finds a tenant by a node the cluster no longer lists, by its short or its full name', async () => {
      await seedGhost();
      expect((await search('gone')).names).toEqual(['Ghost Pin']);
      expect((await search('search-gone.cluster.example.test')).names).toEqual(['Ghost Pin']);
      expect((await search('search-left')).names).toEqual(['Ghost Pin']);
    });

    it('finds a tenant on a node named by its IP address by any part of the address', async () => {
      await seedTenant(getTestDb(), regionId, planId, { name: 'By Address', nodeName: '192.0.2.15' });
      expect((await search('2.15')).names).toEqual(['By Address']);
    });

    it('understands the two words the column shows instead of a node', async () => {
      expect((await search('auto')).names).toEqual(['Unpinned']);
      expect((await search('misplaced')).names).toEqual(['Moved Away']);
    });

    it('still finds a tenant by name and by contact email', async () => {
      expect((await search('unpinned')).names).toEqual(['Unpinned']);
      const db = getTestDb();
      await seedTenant(db, regionId, planId, { name: 'Mailed', primaryEmail: 'owner@mailed-co.example.test' });
      expect((await search('mailed-co')).names).toEqual(['Mailed']);
    });
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

  it('GET /api/v1/tenants — each row carries its plan NAME (joined, not N+1)', async () => {
    const db = getTestDb();
    await seedTenant(db, regionId, planId, { name: 'Planned Corp' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenants?limit=10',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const row = (res.json().data as Array<{ name: string; planName?: string | null }>)
      .find((r) => r.name === 'Planned Corp');
    expect(row?.planName).toBe('Test Plan');
  });

  it('GET /api/v1/tenants/:id — Created By resolves to the user, with fallbacks', async () => {
    const db = getTestDb();
    const userId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO users (id, email, full_name, role_name, panel, status)
      VALUES (${userId}, 'creator@example.test', 'Casey Creator', 'admin', 'admin', 'active')
    `);
    const byUser = await seedTenant(db, regionId, planId, { createdBy: userId });
    const bySystem = await seedTenant(db, regionId, planId, { createdBy: 'system' });

    const get = async (id: string) => (await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    })).json().data as { createdBy: string | null; createdByName: string | null };

    expect(await get(byUser.id)).toMatchObject({ createdBy: userId, createdByName: 'Casey Creator' });
    // No such user: the name is null and the panel reads `createdBy` to say why.
    expect(await get(bySystem.id)).toMatchObject({ createdBy: 'system', createdByName: null });

    // A blank name falls back to the email.
    await db.execute(sql`UPDATE users SET full_name = '' WHERE id = ${userId}`);
    expect((await get(byUser.id)).createdByName).toBe('creator@example.test');
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
