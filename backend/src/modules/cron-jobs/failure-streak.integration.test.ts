/**
 * The failure streak against real Postgres: the counting is SQL in the run's
 * own UPDATE (… + 1, kept, GREATEST(… - 1, 0)), so only a real database says
 * it does what the unit tests assume — and that a frequent job's first
 * failure queues no notice while its second does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { cronJobs, deployments, notificationDeliveries } from '../../db/schema.js';
import { seedCategoriesIfMissing } from '../notifications/categories/service.js';
import { seedTemplatesIfMissing } from '../notifications/templates/seed-loader.js';
import { runAndRecord, flushPendingFailureChecks } from './scheduler.js';
import type { ClusterTransport } from './executor.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('cron failure streak (integration)', () => {
  let tenantId: string;
  let deploymentId: string;
  const db = () => getTestDb();

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });

  beforeEach(async () => {
    await cleanTables();
    // After cleanTables: it empties notification_templates (failure-email.integration.test.ts).
    await seedCategoriesIfMissing(db());
    await seedTemplatesIfMissing(db());
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    tenantId = (await seedTenant(db(), region.id, plan.id)).id;
    deploymentId = crypto.randomUUID();
    await db().insert(deployments).values({
      id: deploymentId, tenantId, name: 'moodle', status: 'running',
    } as typeof deployments.$inferInsert);
  });

  /** A cluster whose one pod answers each exec with the next exit code; null = unreachable. */
  function cluster(exitCodes: Array<number | null>, disrupted: string | null = null): ClusterTransport {
    const codes = [...exitCodes];
    const unreachable = Object.assign(new Error('connect ETIMEDOUT 10.43.0.1:443'), { code: 'ETIMEDOUT', syscall: 'connect' });
    return {
      listPods: vi.fn().mockImplementation(async () => {
        if (codes[0] === null) { codes.shift(); throw unreachable; }
        return [{ name: 'moodle-x', phase: 'Running', component: null, containers: ['app'], nodeName: 'node-a' }];
      }),
      exec: vi.fn().mockImplementation(async () => {
        const exitCode = codes.shift() ?? 0;
        return { stdout: '', stderr: exitCode === 0 ? '' : 'Database connection failed', exitCode };
      }),
      podDisruption: vi.fn().mockResolvedValue(disrupted),
    };
  }

  async function insertJob(schedule = '* * * * *') {
    const id = crypto.randomUUID();
    await db().insert(cronJobs).values({
      id, tenantId, name: 'Moodle cron', type: 'deployment', schedule,
      command: 'php admin/cli/cron.php', deploymentId, enabled: 1,
      // A recipient that needs no user account: the opted-in address.
      notifyOnFailure: true, notifyTenantEmail: false, notifyEmail: 'ops@example.test',
    });
    return id;
  }

  async function run(jobId: string, transport: ClusterTransport) {
    const [job] = await db().select().from(cronJobs).where(eq(cronJobs.id, jobId));
    const after = await runAndRecord(db(), job, {
      transport, interruptionCheckDelayMs: 0, platformFaultRetryDelayMs: 0, outageEvidenceDelayMs: 0,
      explainingOutage: async () => null,
    }, { retry: false });
    return after?.consecutiveFailures;
  }

  const notices = () => db().select().from(notificationDeliveries)
    .where(and(
      eq(notificationDeliveries.categoryId, 'tasks.scheduled_failure'),
      eq(notificationDeliveries.recipientAddress, 'ops@example.test'),
    ));

  it('starts at 0 for a job written without it (the migration default)', async () => {
    const [job] = await db().select().from(cronJobs).where(eq(cronJobs.id, await insertJob()));
    expect(job.consecutiveFailures).toBe(0);
  });

  it('a minutely job: the first failure queues nothing, the second does and says so, a success clears it', async () => {
    const jobId = await insertJob();
    const t = cluster([1, 1, 0, 1]);

    expect(await run(jobId, t)).toBe(1);
    expect(await notices()).toHaveLength(0);

    expect(await run(jobId, t)).toBe(2);
    const queued = await notices();
    expect(queued).toHaveLength(1);
    expect((queued[0].eventVariables as Record<string, unknown>).failedRuns).toBe('2');

    expect(await run(jobId, t)).toBe(0);
    // Failing again after a success starts over: one failure, still the one notice.
    expect(await run(jobId, t)).toBe(1);
    expect(await notices()).toHaveLength(1);
  });

  it('a failed Run now counts: the scheduled failure after it is the second in a row', async () => {
    const jobId = await insertJob();
    const [job] = await db().select().from(cronJobs).where(eq(cronJobs.id, jobId));
    const manual = await runAndRecord(db(), job, { transport: cluster([1]) }, { notify: false, retry: false });
    expect(manual?.consecutiveFailures).toBe(1);
    expect(await notices()).toHaveLength(0);
    expect(await run(jobId, cluster([1]))).toBe(2);
    expect(await notices()).toHaveLength(1);
  });

  it('a nightly job is reported on its first failure', async () => {
    const jobId = await insertJob('0 3 * * *');
    expect(await run(jobId, cluster([1]))).toBe(1);
    const queued = await notices();
    expect(queued).toHaveLength(1);
    expect((queued[0].eventVariables as Record<string, unknown>).failedRuns).toBeNull();
  });

  it('a run the platform interrupted is taken back off', async () => {
    const jobId = await insertJob();
    expect(await run(jobId, cluster([1], 'the pod it ran in was being replaced'))).toBe(0);
    expect(await run(jobId, cluster([1], 'the pod it ran in was being replaced'))).toBe(0);
    expect(await notices()).toHaveLength(0);
    // The next genuine failure is the first of a streak, not the third.
    expect(await run(jobId, cluster([1]))).toBe(1);
    expect(await notices()).toHaveLength(0);
  });

  it('taking it back never goes below 0, whatever cleared it in the meantime', async () => {
    const jobId = await insertJob();
    const [job] = await db().select().from(cronJobs).where(eq(cronJobs.id, jobId));
    // The interruption check waits (45 s in production); clear the count under it.
    await runAndRecord(db(), job, { transport: cluster([1], 'the pod it ran in was being replaced'), interruptionCheckDelayMs: 60_000 });
    await db().update(cronJobs).set({ consecutiveFailures: 0 }).where(eq(cronJobs.id, jobId));
    await flushPendingFailureChecks();
    const [after] = await db().select().from(cronJobs).where(eq(cronJobs.id, jobId));
    expect(after.lastRunOutput).toMatch(/^Interrupted by the platform/);
    expect(after.consecutiveFailures).toBe(0);
  });

  it('a run the platform could not start neither adds to it nor clears it', async () => {
    const jobId = await insertJob();
    expect(await run(jobId, cluster([1]))).toBe(1);
    expect(await run(jobId, cluster([null]))).toBe(1);
    expect(await notices()).toHaveLength(0);
    expect(await run(jobId, cluster([1]))).toBe(2);
    expect(await notices()).toHaveLength(1);
  });
});
