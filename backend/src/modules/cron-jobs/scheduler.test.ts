import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runAndRecord, isJobDue, claimStaleBefore, resolveTimeZone, flushPendingFailureChecks } from './scheduler.js';
import { resetPlatformFaultNotices } from './platform-fault.js';
import type { CronJobRow } from './executor.js';
import type { Database } from '../../db/index.js';
import { tenants } from '../../db/schema.js';

// The scheduling maths that used to live here now has its own suite in
// cron-expression.test.ts. The tests that were in this file asserted the old
// behaviour literally — "should default to 1 minute for specific minute
// fields", "should be in the past when job has never run" — which is the bug
// written down as a contract: it made `0 3 * * *` fire every minute and every
// newly created job fire immediately. They were not carried over.

const notifyTenantScheduledTaskFailure = vi.fn().mockResolvedValue(undefined);
const notifyAdminOperationalEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../notifications/events.js', () => ({
  notifyTenantScheduledTaskFailure: (...args: unknown[]) =>
    notifyTenantScheduledTaskFailure(...args),
  notifyAdminOperationalEvent: (...args: unknown[]) => notifyAdminOperationalEvent(...args),
}));

// The opt-in email leg has its own suite (failure-email.test.ts); here only the
// hand-off matters — what runAndRecord asks for, and what it passes on.
const resolveFailureEmailRecipients = vi.fn().mockResolvedValue({ recipients: [], skipped: 'disabled' });
vi.mock('./failure-email.js', () => ({
  resolveFailureEmailRecipients: (...args: unknown[]) => resolveFailureEmailRecipients(...args),
}));

vi.mock('../system-settings/service.js', () => ({
  getSettings: vi.fn().mockResolvedValue({ timezone: 'Europe/Berlin' }),
}));

function makeJob(overrides: Partial<CronJobRow> = {}): CronJobRow {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    name: 'Moodle cron',
    type: 'deployment',
    schedule: '* * * * *',
    command: 'php admin/cli/cron.php',
    url: null,
    httpMethod: 'GET',
    deploymentId: 'dep-1',
    enabled: 1,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunDurationMs: null,
    lastRunResponseCode: null,
    lastRunOutput: null,
    notifyOnFailure: false,
    notifyTenantEmail: true,
    notifyEmail: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CronJobRow;
}

interface DbSpy {
  readonly db: Database;
  readonly updates: Record<string, unknown>[];
}

function mockDb(deploymentRows: unknown[], refreshedRow: unknown): DbSpy {
  const updates: Record<string, unknown>[] = [];

  // resolveDeployment(): select().from().innerJoin().leftJoin().where()
  // runAndRecord():      select().from().where()
  // The operator's notice names the tenant: select({ name }).from(tenants).where()
  const from = vi.fn().mockImplementation((table: unknown) => (table === tenants
    ? { where: vi.fn().mockResolvedValue([{ name: 'Acme' }]) }
    : {
      innerJoin: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(deploymentRows) }),
      }),
      where: vi.fn().mockResolvedValue([refreshedRow]),
    }));

  const db = {
    select: vi.fn().mockReturnValue({ from }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updates.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
  } as unknown as Database;

  return { db, updates };
}

const RUNNING_DEPLOYMENT = {
  name: 'moodle-site',
  status: 'running',
  namespace: 'tenant-acme',
  entryCode: 'apache-php-office',
};

beforeEach(() => {
  notifyTenantScheduledTaskFailure.mockClear();
  notifyAdminOperationalEvent.mockClear();
  resolveFailureEmailRecipients.mockClear();
  resolveFailureEmailRecipients.mockResolvedValue({ recipients: [], skipped: 'disabled' });
});

describe('runAndRecord', () => {
  it('records a successful deployment run with its exit code', async () => {
    const { db, updates } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'success' }));

    await runAndRecord(db, makeJob(), {
      transport: {
        listPods: vi.fn().mockResolvedValue([
          { name: 'moodle-site-x', phase: 'Running', component: 'apache-php-office', containers: ['apache-php-office'] },
        ]),
        exec: vi.fn().mockResolvedValue({ stdout: 'done', stderr: '', exitCode: 0 }),
      },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].lastRunStatus).toBe('success');
    expect(updates[0].lastRunResponseCode).toBe(0);
    expect(updates[0].lastRunOutput).toBe('done');
    expect(updates[0].lastRunAt).toBeInstanceOf(Date);
    expect(updates[0].lastRunDurationMs).toEqual(expect.any(Number));
  });

  it('records a failure and notifies the tenant', async () => {
    const { db, updates } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'failed' }));

    await runAndRecord(db, makeJob(), {
      transport: {
        listPods: vi.fn().mockResolvedValue([
          { name: 'moodle-site-x', phase: 'Running', component: 'apache-php-office', containers: ['apache-php-office'] },
        ]),
        exec: vi.fn().mockResolvedValue({ stdout: '', stderr: 'cron.php not found', exitCode: 127 }),
      },
    });

    expect(updates[0].lastRunStatus).toBe('failed');
    expect(updates[0].lastRunResponseCode).toBe(127);
    expect(notifyTenantScheduledTaskFailure).toHaveBeenCalledTimes(1);

    const [, tenantId, payload, opts] = notifyTenantScheduledTaskFailure.mock.calls[0];
    expect(tenantId).toBe('tenant-1');
    expect(payload).toMatchObject({ taskName: 'Moodle cron' });
    expect((payload as { errorMessage: string }).errorMessage).toContain('exit 127');
    // Per (job, UTC day) — a broken job on a 5-minute schedule would otherwise
    // send 288 notifications before breakfast.
    expect((opts as { dedupeKey: string }).dedupeKey).toMatch(/^scheduled-task-failure:job-1:\d{4}-\d{2}-\d{2}$/);
    // Switched off by default: nobody beyond the tenant's own admins.
    expect((opts as { externalRecipients: readonly string[] }).externalRecipients).toEqual([]);
  });

  // Production: a server was powered off, its kubelet stopped every
  // pod, Moodle's cron exited 1 mid-run — and the client was emailed that their
  // scheduled task had failed.
  describe('a run the platform interrupted', () => {
    const transport = (why: string | null) => ({
      listPods: vi.fn().mockResolvedValue([
        { name: 'moodle-site-x', phase: 'Running', component: 'apache-php-office', containers: ['apache-php-office'], nodeName: 's1' },
      ]),
      exec: vi.fn().mockResolvedValue({ stdout: 'Cron run completed', stderr: '', exitCode: 1 }),
      podDisruption: vi.fn().mockResolvedValue(why),
    });

    it('is not reported to anyone, and its output says what happened', async () => {
      const t = transport('the server it ran on was shutting down');
      const { db, updates } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'failed' }));
      await runAndRecord(db, makeJob(), { transport: t, interruptionCheckDelayMs: 0 });

      expect(t.podDisruption).toHaveBeenCalledWith({ namespace: 'tenant-acme', pod: 'moodle-site-x', node: 's1' });
      expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
      expect(updates[0].lastRunStatus).toBe('failed');
      expect(updates[1].lastRunOutput).toBe(
        'Interrupted by the platform: the server it ran on was shutting down. The command itself did not fail.\nCron run completed',
      );
    });

    it('a check still waiting when the API shuts down is run then, not lost', async () => {
      const t = transport(null);
      const { db } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'failed' }));
      await runAndRecord(db, makeJob(), { transport: t, interruptionCheckDelayMs: 60_000 });
      expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
      await flushPendingFailureChecks();
      expect(t.podDisruption).toHaveBeenCalledTimes(1);
      expect(notifyTenantScheduledTaskFailure).toHaveBeenCalledTimes(1);
      // Flushed once: a second shutdown hook has nothing left to run.
      await flushPendingFailureChecks();
      expect(notifyTenantScheduledTaskFailure).toHaveBeenCalledTimes(1);
    });

    // Lab staging, the same outage: the next run found the deployment marked
    // failed (its server was down) and told the client their task had failed.
    it('a run that could not start because the tenant\'s server is down is not reported either', async () => {
      const t = transport('the server it runs on (s1) is down');
      const { db, updates } = mockDb([{ ...RUNNING_DEPLOYMENT, status: 'failed', tenantNode: 's1' }], makeJob({ lastRunStatus: 'failed' }));
      await runAndRecord(db, makeJob(), { transport: t, interruptionCheckDelayMs: 0 });
      expect(t.exec).not.toHaveBeenCalled();
      expect(t.podDisruption).toHaveBeenCalledWith({ namespace: 'tenant-acme', pod: '', node: 's1' });
      expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
      expect(String(updates[1].lastRunOutput)).toMatch(/^Interrupted by the platform: the server it runs on \(s1\) is down\./);
    });

    it('a failure the platform did not cause is reported as before', async () => {
      const { db } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'failed' }));
      await runAndRecord(db, makeJob(), { transport: transport(null), interruptionCheckDelayMs: 0 });
      expect(notifyTenantScheduledTaskFailure).toHaveBeenCalledTimes(1);
    });
  });

  // Production, a server being shut down: the platform's exec connection to
  // its own cluster API timed out, and the client was emailed that their task
  // "did not run: connect ETIMEDOUT".
  describe('a run the platform could not start because it could not reach its cluster', () => {
    // The shapes the libraries produce: a ws ErrorEvent around Node's socket error.
    const unreachable = () => new Error('connect ETIMEDOUT 10.0.0.1:443', {
      cause: { error: Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:443'), { code: 'ETIMEDOUT', syscall: 'connect' }) },
    });
    const resetMidHandshake = () => new Error('read ECONNRESET', {
      cause: { error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }) },
    });
    const transport = (exec: ReturnType<typeof vi.fn>) => ({
      listPods: vi.fn().mockResolvedValue([
        { name: 'moodle-site-x', phase: 'Running', component: 'apache-php-office', containers: ['apache-php-office'], nodeName: 's1' },
      ]),
      exec,
      podDisruption: vi.fn().mockResolvedValue(null),
    });
    const quick = {
      interruptionCheckDelayMs: 0, platformFaultRetryDelayMs: 0, outageEvidenceDelayMs: 0, explainingOutage: async () => null,
    };
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      resetPlatformFaultNotices();
    });
    afterEach(() => { warn.mockRestore(); });

    it('is tried once more — the command was never sent — and a retry that runs is the run recorded', async () => {
      const t = transport(vi.fn()
        .mockRejectedValueOnce(unreachable())
        .mockResolvedValueOnce({ stdout: 'Cron run completed', stderr: '', exitCode: 0 }));
      const { db, updates } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'success' }));
      await runAndRecord(db, makeJob(), { transport: t, ...quick });

      expect(t.exec).toHaveBeenCalledTimes(2);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ lastRunStatus: 'success', lastRunOutput: 'Cron run completed' });
      expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
      expect(notifyAdminOperationalEvent).not.toHaveBeenCalled();
    });

    it('is not reported to the tenant when the retry cannot reach it either — the operator is told, once a day', async () => {
      const t = transport(vi.fn().mockRejectedValue(unreachable()));
      const { db, updates } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'failed' }));
      await runAndRecord(db, makeJob(), { transport: t, ...quick });

      expect(t.exec).toHaveBeenCalledTimes(2);
      expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
      // The error itself is the evidence; nothing to look up afterwards.
      expect(t.podDisruption).not.toHaveBeenCalled();
      expect(updates).toHaveLength(1);
      expect(updates[0].lastRunStatus).toBe('failed');
      expect(String(updates[0].lastRunOutput)).toMatch(/^Not run: the platform could not reach its cluster API \(ETIMEDOUT\)\./);

      expect(notifyAdminOperationalEvent).toHaveBeenCalledTimes(1);
      const [, subsystem, payload, dedupeKey, resourceType] = notifyAdminOperationalEvent.mock.calls[0];
      expect(subsystem).toBe('platform');
      expect(payload).toMatchObject({ subsystem: 'Scheduled tasks', objectLabel: 'Moodle cron (Acme)', severityLabel: 'not run' });
      // The operator gets the detail the tenant does not see.
      expect(String(payload.detail)).toContain('connect ETIMEDOUT 10.0.0.1:443');
      expect(dedupeKey).toMatch(/^cron-platform-fault:\d{4}-\d{2}-\d{2}$/);
      expect(resourceType).toBe('cron_platform_fault');
    });

    // The command travels in the exec's upgrade request: once the connection
    // was made, the API server may have started it before the reset.
    it('is NOT retried when the connection broke during the handshake — the command may have started', async () => {
      const t = transport(vi.fn().mockRejectedValue(resetMidHandshake()));
      const { db, updates } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'failed' }));
      await runAndRecord(db, makeJob(), { transport: t, ...quick });

      expect(t.exec).toHaveBeenCalledTimes(1);
      expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
      expect(String(updates[0].lastRunOutput)).toMatch(/^Not confirmed: the platform lost its connection to its cluster API \(ECONNRESET\)/);
      expect(notifyAdminOperationalEvent).toHaveBeenCalledTimes(1);
    });

    it('a run whose pods could not even be listed is retried too — nothing was sent', async () => {
      const t = {
        ...transport(vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 })),
        listPods: vi.fn()
          .mockRejectedValueOnce(new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }))
          .mockResolvedValueOnce([{ name: 'moodle-site-x', phase: 'Running', component: 'apache-php-office', containers: ['apache-php-office'] }]),
      };
      const { db, updates } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'success' }));
      await runAndRecord(db, makeJob(), { transport: t, ...quick });
      expect(t.listPods).toHaveBeenCalledTimes(2);
      expect(updates[0]).toMatchObject({ lastRunStatus: 'success' });
    });

    it('decides the operator notice only once a crashed node could be seen down', async () => {
      const explain = vi.fn().mockResolvedValue(null);
      const t = transport(vi.fn().mockRejectedValue(unreachable()));
      const { db } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'failed' }));
      await runAndRecord(db, makeJob(), { transport: t, ...quick, outageEvidenceDelayMs: 60_000, explainingOutage: explain });
      expect(explain).not.toHaveBeenCalled();
      await flushPendingFailureChecks();
      expect(explain).toHaveBeenCalledTimes(1);
      expect(notifyAdminOperationalEvent).toHaveBeenCalledTimes(1);
    });

    it('jobs failing the same way on one day send the operator ONE notice between them', async () => {
      for (const id of ['job-1', 'job-2', 'job-3']) {
        const t = transport(vi.fn().mockRejectedValue(unreachable()));
        const { db } = mockDb([RUNNING_DEPLOYMENT], makeJob({ id, lastRunStatus: 'failed' }));
        await runAndRecord(db, makeJob({ id }), { transport: t, ...quick });
      }
      expect(notifyAdminOperationalEvent).toHaveBeenCalledTimes(1);
    });

    it('tells the operator nothing while a node outage explains it — that outage was announced', async () => {
      const t = transport(vi.fn().mockRejectedValue(unreachable()));
      const { db } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'failed' }));
      await runAndRecord(db, makeJob(), { transport: t, ...quick, explainingOutage: async () => 'node-b is down' });

      expect(notifyAdminOperationalEvent).not.toHaveBeenCalled();
      expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('node-b is down'));
    });

    it('a manual run is not retried and tells no one — the person who pressed it sees the result', async () => {
      const t = transport(vi.fn().mockRejectedValue(unreachable()));
      const { db, updates } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'failed' }));
      await runAndRecord(db, makeJob(), { transport: t, ...quick }, { notify: false, retry: false });

      expect(t.exec).toHaveBeenCalledTimes(1);
      expect(String(updates[0].lastRunOutput)).toMatch(/^Not run: /);
      expect(notifyAdminOperationalEvent).not.toHaveBeenCalled();
      expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
    });
  });

  it('"inform the tenant\'s admins" off is passed on: they get nothing on any channel', async () => {
    const { db } = mockDb([], makeJob({ lastRunStatus: 'failed' }));
    await runAndRecord(db, makeJob({ notifyTenantEmail: false, notifyOnFailure: true, notifyEmail: 'ops@example.test' }), {});
    const [, , , opts] = notifyTenantScheduledTaskFailure.mock.calls[0];
    expect(opts).toMatchObject({ informTenantAdmins: false });

    notifyTenantScheduledTaskFailure.mockClear();
    await runAndRecord(db, makeJob(), {});
    expect(notifyTenantScheduledTaskFailure.mock.calls[0][3]).toMatchObject({ informTenantAdmins: true });
  });

  it('names the schedule and the clock it is read on, so the email says WHEN it runs', async () => {
    const { db } = mockDb([], makeJob({ lastRunStatus: 'failed' }));

    await runAndRecord(db, makeJob({ schedule: '0 3 * * *', timezone: null }), {});
    const [, , payload] = notifyTenantScheduledTaskFailure.mock.calls[0];
    // No zone of its own, so the platform's.
    expect((payload as { schedule: string }).schedule).toBe('0 3 * * * (Europe/Berlin)');

    notifyTenantScheduledTaskFailure.mockClear();
    await runAndRecord(db, makeJob({ schedule: '*/5 * * * *', timezone: 'Asia/Tokyo' }), {});
    const [, , pinned] = notifyTenantScheduledTaskFailure.mock.calls[0];
    expect((pinned as { schedule: string }).schedule).toBe('*/5 * * * * (Asia/Tokyo)');
  });

  it('hands the opted-in addresses to the dispatcher as external recipients', async () => {
    resolveFailureEmailRecipients.mockResolvedValue({ recipients: ['owner@example.test', 'ops@example.test'] });
    const optedIn = makeJob({ notifyOnFailure: true, notifyEmail: 'ops@example.test' });
    const { db } = mockDb([], makeJob({ lastRunStatus: 'failed' }));

    await runAndRecord(db, optedIn, {});

    expect(resolveFailureEmailRecipients).toHaveBeenCalledTimes(1);
    const [, jobArg] = resolveFailureEmailRecipients.mock.calls[0];
    expect(jobArg).toMatchObject({ id: 'job-1', tenantId: 'tenant-1', notifyOnFailure: true, notifyEmail: 'ops@example.test' });
    const [, , , opts] = notifyTenantScheduledTaskFailure.mock.calls[0];
    expect((opts as { externalRecipients: readonly string[] }).externalRecipients)
      .toEqual(['owner@example.test', 'ops@example.test']);
  });

  it('still notifies the tenant admins when today\'s email slot is already spent', async () => {
    resolveFailureEmailRecipients.mockResolvedValue({ recipients: [], skipped: 'already-sent-today' });
    const { db } = mockDb([], makeJob({ lastRunStatus: 'failed' }));

    await runAndRecord(db, makeJob({ notifyOnFailure: true }), {});

    expect(notifyTenantScheduledTaskFailure).toHaveBeenCalledTimes(1);
    const [, , , opts] = notifyTenantScheduledTaskFailure.mock.calls[0];
    expect((opts as { externalRecipients: readonly string[] }).externalRecipients).toEqual([]);
  });

  it('never emails on success', async () => {
    const { db } = mockDb([RUNNING_DEPLOYMENT], makeJob({ lastRunStatus: 'success' }));

    await runAndRecord(db, makeJob({ notifyOnFailure: true }), {
      transport: {
        listPods: vi.fn().mockResolvedValue([
          { name: 'moodle-site-x', phase: 'Running', component: 'apache-php-office', containers: ['apache-php-office'] },
        ]),
        exec: vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 }),
      },
    });

    expect(resolveFailureEmailRecipients).not.toHaveBeenCalled();
    expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
  });

  it('does not notify on a manual run — the operator is looking at the result', async () => {
    const { db } = mockDb([], makeJob({ lastRunStatus: 'failed' }));

    await runAndRecord(db, makeJob({ notifyOnFailure: true }), {}, { notify: false });

    expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
    // Nor does it spend the day's email slot on a test run.
    expect(resolveFailureEmailRecipients).not.toHaveBeenCalled();
  });

  it('records a failure rather than a success when the job could not run at all', async () => {
    // The old manual-run path left status at its initial 'success' for a
    // deployment job it never executed.
    const { db, updates } = mockDb([], makeJob());

    await runAndRecord(db, makeJob(), {}, { notify: false });

    expect(updates[0].lastRunStatus).toBe('failed');
    expect(String(updates[0].lastRunOutput)).toContain('no longer exists');
  });

  it('survives a notification failure instead of losing the run record', async () => {
    notifyTenantScheduledTaskFailure.mockRejectedValueOnce(new Error('smtp down'));
    const { db, updates } = mockDb([], makeJob());

    await expect(runAndRecord(db, makeJob(), {})).resolves.toBeDefined();
    expect(updates[0].lastRunStatus).toBe('failed');
  });
});

describe('isJobDue', () => {
  // This suite exists because of a bug that unit tests could not see and a real
  // cluster found in one minute: a `* * * * *` job created through the panel sat
  // at "Never". The scheduler measured a never-run job from `now`, so "the next
  // match after now" moved forward on every 30-second poll and the job was never
  // due. Every test below that passes `created` is guarding that.
  const created = new Date('2026-09-16T12:00:30Z');
  const never = { schedule: '* * * * *', lastRunAt: null, createdAt: created };

  it('is not due before its first slot', () => {
    expect(isJobDue(never, new Date('2026-09-16T12:00:40Z'))).toBe(false);
  });

  it('becomes due at its first slot', () => {
    expect(isJobDue(never, new Date('2026-09-16T12:01:00Z'))).toBe(true);
  });

  it('is STILL due minutes later — the regression', () => {
    // The broken version answered "not due" here, and at every later poll,
    // forever.
    expect(isJobDue(never, new Date('2026-09-16T12:09:00Z'))).toBe(true);
  });

  it('fires at least once when polled every 30s for ten minutes', () => {
    let due = 0;
    for (let t = 0; t < 20; t++) {
      const now = new Date(created.getTime() + t * 30_000);
      if (isJobDue(never, now)) due++;
    }
    expect(due).toBeGreaterThan(0);
  });

  it('a nightly job created at lunchtime waits for the night', () => {
    const nightly = { schedule: '0 3 * * *', lastRunAt: null, createdAt: new Date('2026-09-16T12:00:00Z') };
    expect(isJobDue(nightly, new Date('2026-09-16T12:30:00Z'))).toBe(false);
    expect(isJobDue(nightly, new Date('2026-09-16T23:59:00Z'))).toBe(false);
    expect(isJobDue(nightly, new Date('2026-09-17T03:00:00Z'))).toBe(true);
  });

  it('after a run, the next slot is measured from that run', () => {
    const ran = {
      schedule: '*/15 * * * *',
      lastRunAt: new Date('2026-09-16T12:15:00Z'),
      createdAt: created,
    };
    expect(isJobDue(ran, new Date('2026-09-16T12:20:00Z'))).toBe(false);
    expect(isJobDue(ran, new Date('2026-09-16T12:30:00Z'))).toBe(true);
  });

  it('an unparseable schedule is never due', () => {
    const bad = { schedule: 'not a cron', lastRunAt: null, createdAt: created };
    expect(isJobDue(bad, new Date('2027-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('claimStaleBefore', () => {
  // A fixed 30-minute window was safe while every run was capped at 5 minutes.
  // With a configurable ceiling of up to an hour it is not: a legitimate
  // 45-minute run would be re-claimed and executed a second time while the
  // first was still going. The window follows the job's own ceiling instead.
  const now = new Date('2026-09-17T12:00:00Z');

  it('waits longer than a long job can legitimately run', () => {
    const job = { type: 'deployment', timeoutSeconds: 2700 }; // 45 minutes
    const cutoff = claimStaleBefore(job, now);
    const ageWhenReclaimed = now.getTime() - cutoff.getTime();
    expect(ageWhenReclaimed).toBeGreaterThan(2700 * 1000);
  });

  it('is tighter for a short job, so an orphan is recovered sooner', () => {
    const quick = claimStaleBefore({ type: 'webcron', timeoutSeconds: null }, now);
    const slow = claimStaleBefore({ type: 'deployment', timeoutSeconds: 3600 }, now);
    expect(quick.getTime()).toBeGreaterThan(slow.getTime());
  });

  it('never returns a cutoff in the future — that would re-claim a live run', () => {
    expect(claimStaleBefore({ type: 'deployment', timeoutSeconds: 5 }, now).getTime())
      .toBeLessThan(now.getTime());
  });
});

describe('resolveTimeZone', () => {
  // Resolved at evaluation time, never stamped on the row: an operator who
  // changes the platform timezone should move every job that was following it,
  // and leave alone the ones somebody pinned deliberately.
  it('prefers the job\'s own zone', () => {
    expect(resolveTimeZone({ timezone: 'Asia/Tokyo' }, 'Europe/Berlin')).toBe('Asia/Tokyo');
  });

  it('falls back to the platform zone', () => {
    expect(resolveTimeZone({ timezone: null }, 'Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('falls back to UTC when the platform has none', () => {
    expect(resolveTimeZone({ timezone: null }, null)).toBe('UTC');
    expect(resolveTimeZone({ timezone: null }, undefined)).toBe('UTC');
  });

  it('treats an empty string as unset rather than as a zone', () => {
    expect(resolveTimeZone({ timezone: '' }, 'Europe/Berlin')).toBe('Europe/Berlin');
  });
});

describe('isJobDue with a timezone', () => {
  // 03:00 Berlin is 01:00 UTC in summer. A nightly job must be due then, and
  // NOT at 03:00 UTC — which is 05:00 for the tenant, the complaint that
  // started this.
  const nightly = {
    schedule: '0 3 * * *',
    lastRunAt: new Date('2026-07-01T01:00:00Z'),
    createdAt: new Date('2026-06-01T00:00:00Z'),
    timezone: 'Europe/Berlin',
  };

  it('is due at the local hour, not the UTC one', () => {
    expect(isJobDue(nightly, new Date('2026-07-02T00:59:00Z'))).toBe(false);
    expect(isJobDue(nightly, new Date('2026-07-02T01:00:00Z'))).toBe(true);
  });

  it('follows the platform zone when the job has none', () => {
    const job = { ...nightly, timezone: null };
    expect(isJobDue(job, new Date('2026-07-02T00:59:00Z'), 'Europe/Berlin')).toBe(false);
    expect(isJobDue(job, new Date('2026-07-02T01:00:00Z'), 'Europe/Berlin')).toBe(true);
  });

  it('keeps UTC behaviour for a job with no zone and no platform zone', () => {
    const job = { ...nightly, timezone: null, lastRunAt: new Date('2026-07-01T03:00:00Z') };
    expect(isJobDue(job, new Date('2026-07-02T02:59:00Z'))).toBe(false);
    expect(isJobDue(job, new Date('2026-07-02T03:00:00Z'))).toBe(true);
  });
});
