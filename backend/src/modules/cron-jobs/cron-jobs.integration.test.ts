import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { cronJobs } from '../../db/schema.js';
import { claimJob } from './scheduler.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Cron Jobs CRUD (integration)', () => {
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

  it('POST -- creates webcron job with 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Daily ping',
        type: 'webcron',
        schedule: '0 3 * * *',
        url: 'https://example.com/cron',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.name).toBe('Daily ping');
    expect(body.data.type).toBe('webcron');
    expect(body.data.url).toBe('https://example.com/cron');
    expect(body.data.httpMethod).toBe('GET');
    expect(body.data.enabled).toBe(1);
  });

  it('POST -- creates deployment cron job with 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Daily cleanup',
        type: 'deployment',
        schedule: '0 3 * * *',
        command: '/usr/bin/php /var/www/cron.php',
        deployment_id: '550e8400-e29b-41d4-a716-446655440000',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.name).toBe('Daily cleanup');
    expect(body.data.type).toBe('deployment');
    expect(body.data.command).toBe('/usr/bin/php /var/www/cron.php');
    expect(body.data.deploymentId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('GET list -- returns paginated cron jobs', async () => {
    const db = getTestDb();
    await db.insert(cronJobs).values({
      id: crypto.randomUUID(),
      tenantId,
      name: 'Job 1',
      type: 'webcron',
      schedule: '* * * * *',
      url: 'https://example.com/job1',
    });
    await db.insert(cronJobs).values({
      id: crypto.randomUUID(),
      tenantId,
      name: 'Job 2',
      type: 'webcron',
      schedule: '0 * * * *',
      url: 'https://example.com/job2',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBe(2);
  });

  it('PATCH -- updates cron job', async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    await db.insert(cronJobs).values({
      id,
      tenantId,
      name: 'Old name',
      type: 'webcron',
      schedule: '* * * * *',
      url: 'https://example.com/old',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${tenantId}/cron-jobs/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'New name', enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.name).toBe('New name');
    expect(res.json().data.enabled).toBe(0);
  });

  it('PATCH -- updates url and http_method', async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    await db.insert(cronJobs).values({
      id,
      tenantId,
      name: 'Webcron job',
      type: 'webcron',
      schedule: '* * * * *',
      url: 'https://example.com/old',
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${tenantId}/cron-jobs/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { url: 'https://example.com/new', http_method: 'POST' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.url).toBe('https://example.com/new');
    expect(res.json().data.httpMethod).toBe('POST');
  });

  it('DELETE -- removes cron job', async () => {
    const db = getTestDb();
    const id = crypto.randomUUID();
    await db.insert(cronJobs).values({
      id,
      tenantId,
      name: 'To delete',
      type: 'webcron',
      schedule: '* * * * *',
      url: 'https://example.com/del',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tenants/${tenantId}/cron-jobs/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);

    // Verify deleted
    const rows = await db.select().from(cronJobs).where(eq(cronJobs.id, id));
    expect(rows.length).toBe(0);
  });

  it('returns 404 for nonexistent cron job', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/cron-jobs/nonexistent`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CRON_JOB_NOT_FOUND');
  });

  it('rejects invalid cron schedule', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Bad schedule',
        type: 'webcron',
        schedule: 'not-valid',
        url: 'https://example.com/cron',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects webcron without url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'No URL',
        type: 'webcron',
        schedule: '0 * * * *',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects deployment without command and deployment_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'No command',
        type: 'deployment',
        schedule: '0 * * * *',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe.skipIf(!dbAvailable)('Cron job execution (integration)', () => {
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

  async function insertJob(overrides: Record<string, unknown> = {}) {
    const db = getTestDb();
    const id = crypto.randomUUID();
    await db.insert(cronJobs).values({
      id,
      tenantId,
      name: 'Moodle cron',
      type: 'deployment',
      schedule: '* * * * *',
      command: 'php /var/www/html/admin/cli/cron.php',
      deploymentId: crypto.randomUUID(),
      enabled: 1,
      ...overrides,
    });
    return id;
  }

  describe('claimJob', () => {
    // Against real Postgres, because the bug being fixed IS a SQL semantics
    // bug: the old predicate `last_run_status != 'running'` evaluates to NULL —
    // not true — for a job that has never run, so the claim matched no row and
    // a newly created cron job never fired on schedule. No mock reproduces
    // that; only the database does.
    const staleWindow = () => new Date(Date.now() - 30 * 60_000);

    it('claims a job that has never run (last_run_status IS NULL)', async () => {
      const id = await insertJob();
      expect(await claimJob(getTestDb(), id, staleWindow())).toBe(true);

      const [row] = await getTestDb().select().from(cronJobs).where(eq(cronJobs.id, id));
      expect(row.lastRunStatus).toBe('running');
    });

    it('claims a job that finished earlier', async () => {
      const id = await insertJob({ lastRunStatus: 'success' });
      expect(await claimJob(getTestDb(), id, staleWindow())).toBe(true);
    });

    it('refuses a job another tick is already running', async () => {
      const id = await insertJob({ lastRunStatus: 'running' });
      expect(await claimJob(getTestDb(), id, staleWindow())).toBe(false);
    });

    it('reclaims a job whose claim was orphaned by a pod restart', async () => {
      const id = await insertJob({ lastRunStatus: 'running' });
      // Backdate the row past the staleness window — the shape left behind when
      // the API pod dies between claiming and recording.
      await getTestDb()
        .update(cronJobs)
        .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60_000) })
        .where(eq(cronJobs.id, id));

      expect(await claimJob(getTestDb(), id, staleWindow())).toBe(true);
    });
  });

  describe('POST /run', () => {
    it('reports a deployment job that could not run as failed, not success', async () => {
      // The regression: this path used to leave the status at its initial
      // 'success' and write "not yet implemented" into the output, so a tenant
      // saw a green run of a command that was never executed.
      const id = await insertJob();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/cron-jobs/${id}/run`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.lastRunStatus).toBe('failed');
      expect(body.data.lastRunOutput).toMatch(/no longer exists/);
      expect(body.data.lastRunOutput).not.toMatch(/not yet implemented/);
    });

    it('records a webcron failure with its HTTP status', async () => {
      const id = await insertJob({
        type: 'webcron',
        url: 'https://127.0.0.1:1/cron',
        command: null,
        deploymentId: null,
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/tenants/${tenantId}/cron-jobs/${id}/run`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.lastRunStatus).toBe('failed');
    });
  });
});
