import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY } from '@insula/api-contracts';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { buildTestApp, generateToken } from '../../test-helpers/app.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { cronJobs, notificationDeliveries } from '../../db/schema.js';
import { seedCategoriesIfMissing } from '../notifications/categories/service.js';
import { seedTemplatesIfMissing } from '../notifications/templates/seed-loader.js';
import { runAndRecord } from './scheduler.js';
import { resolveFailureEmailRecipients } from './failure-email.js';

/**
 * The opt-in failure email against a real database: the migration's defaults,
 * the atomic bucket claims, and the whole chain from a failed run to a queued
 * delivery row addressed to the opted-in addresses.
 */
const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('cron failure email (integration)', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let tenantId: string;
  let tenantEmail: string;

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
    // After cleanTables, not once in beforeAll: its `TRUNCATE users CASCADE`
    // also empties notification_templates (edited_by_user_id references
    // users), and with no template the email leg is skipped as
    // template_not_found — a test of nothing.
    await seedCategoriesIfMissing(db);
    await seedTemplatesIfMissing(db);
    const region = await seedRegion(db);
    const plan = await seedPlan(db);
    const suffix = crypto.randomUUID().slice(0, 8);
    tenantEmail = `owner-${suffix}@example.test`;
    const tenant = await seedTenant(db, region.id, plan.id, { primaryEmail: tenantEmail });
    tenantId = tenant.id;
  });

  /** A webcron job that always fails: the SSRF guard refuses loopback. */
  async function insertFailingJob(overrides: Partial<typeof cronJobs.$inferInsert> = {}) {
    const db = getTestDb();
    const id = crypto.randomUUID();
    await db.insert(cronJobs).values({
      id,
      tenantId,
      name: 'Nightly import',
      type: 'webcron',
      schedule: '* * * * *',
      url: 'http://127.0.0.1:9/cron.php',
      enabled: 1,
      ...overrides,
    });
    const [row] = await db.select().from(cronJobs).where(eq(cronJobs.id, id));
    return row;
  }

  async function externalEmails() {
    return getTestDb()
      .select({
        recipientAddress: notificationDeliveries.recipientAddress,
        status: notificationDeliveries.status,
        eventVariables: notificationDeliveries.eventVariables,
      })
      .from(notificationDeliveries)
      .where(and(
        eq(notificationDeliveries.categoryId, 'tasks.scheduled_failure'),
        eq(notificationDeliveries.tenantId, tenantId),
        eq(notificationDeliveries.channel, 'email'),
        isNull(notificationDeliveries.userId),
      ));
  }

  it('migration defaults: a job written without the new columns is off, tenant email pre-selected', async () => {
    const job = await insertFailingJob();
    expect(job.notifyOnFailure).toBe(false);
    expect(job.notifyTenantEmail).toBe(true);
    expect(job.notifyEmail).toBeNull();
  });

  it('a job failing on every run queues ONE email per address per day, not one per run', async () => {
    const job = await insertFailingJob({ notifyOnFailure: true, notifyEmail: 'ops@example.test' });

    for (let run = 0; run < 3; run += 1) {
      const updated = await runAndRecord(getTestDb(), job);
      expect(updated?.lastRunStatus).toBe('failed');
    }

    const rows = await externalEmails();
    expect(rows.map((r) => r.recipientAddress).sort()).toEqual([tenantEmail, 'ops@example.test'].sort());
    expect(rows.every((r) => r.status === 'queued')).toBe(true);
    // The template's facts travel with the row the queue worker re-renders.
    const vars = rows[0].eventVariables as Record<string, unknown>;
    expect(vars.taskName).toBe('Nightly import');
    expect(vars.schedule).toMatch(/^\* \* \* \* \* \(.+\)$/);
    expect(String(vars.errorMessage)).toMatch(/request failed/i);
  });

  it('mails nobody beyond the tenant admins while switched off', async () => {
    const job = await insertFailingJob({ notifyOnFailure: false, notifyEmail: 'ops@example.test' });
    await runAndRecord(getTestDb(), job);
    expect(await externalEmails()).toEqual([]);
  });

  it('a manual run never emails', async () => {
    const job = await insertFailingJob({ notifyOnFailure: true });
    await runAndRecord(getTestDb(), job, {}, { notify: false });
    expect(await externalEmails()).toEqual([]);
  });

  it('the per-tenant daily cap holds against the real bucket table', async () => {
    const db = getTestDb();
    const now = new Date();
    let mailed = 0;
    for (let i = 0; i < CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY + 3; i += 1) {
      const r = await resolveFailureEmailRecipients(db, {
        id: crypto.randomUUID(),
        tenantId,
        notifyOnFailure: true,
        notifyTenantEmail: false,
        notifyEmail: 'ops@example.test',
      }, now);
      if (r.recipients.length > 0) mailed += 1;
    }
    expect(mailed).toBe(CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY);
  });

  it('API: stores the opt-in, shows the tenant email, and refuses an edit that leaves nobody', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/tenants/${tenantId}/cron-jobs`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: 'Nightly import', type: 'webcron', schedule: '0 3 * * *', url: 'https://example.test/cron',
        notify_on_failure: true, notify_tenant_email: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const job = created.json().data;
    expect(job).toMatchObject({ notifyOnFailure: true, notifyTenantEmail: true, notifyEmail: null });

    const info = await app.inject({
      method: 'GET',
      url: `/api/v1/tenants/${tenantId}/cron-jobs/failure-email-info`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(info.statusCode).toBe(200);
    expect(info.json().data).toEqual({
      tenantEmail,
      maxEmailsPerTenantPerDay: CRON_FAILURE_EMAILS_PER_TENANT_PER_DAY,
    });

    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${tenantId}/cron-jobs/${job.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notify_tenant_email: false },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.field).toBe('notify_email');

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tenants/${tenantId}/cron-jobs/${job.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { notify_tenant_email: false, notify_email: 'ops@example.test' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ notifyTenantEmail: false, notifyEmail: 'ops@example.test' });
  });
});
