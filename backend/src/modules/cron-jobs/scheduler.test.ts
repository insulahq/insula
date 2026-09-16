import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAndRecord } from './scheduler.js';
import type { CronJobRow } from './executor.js';
import type { Database } from '../../db/index.js';

// The scheduling maths that used to live here now has its own suite in
// cron-expression.test.ts. The tests that were in this file asserted the old
// behaviour literally — "should default to 1 minute for specific minute
// fields", "should be in the past when job has never run" — which is the bug
// written down as a contract: it made `0 3 * * *` fire every minute and every
// newly created job fire immediately. They were not carried over.

const notifyTenantScheduledTaskFailure = vi.fn().mockResolvedValue(undefined);
vi.mock('../notifications/events.js', () => ({
  notifyTenantScheduledTaskFailure: (...args: unknown[]) =>
    notifyTenantScheduledTaskFailure(...args),
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
  const from = vi.fn().mockReturnValue({
    innerJoin: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(deploymentRows) }),
    }),
    where: vi.fn().mockResolvedValue([refreshedRow]),
  });

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

    const [, tenantId, payload, dedupeKey] = notifyTenantScheduledTaskFailure.mock.calls[0];
    expect(tenantId).toBe('tenant-1');
    expect(payload).toMatchObject({ taskName: 'Moodle cron' });
    expect((payload as { errorMessage: string }).errorMessage).toContain('exit 127');
    // Per (job, UTC day) — a broken job on a 5-minute schedule would otherwise
    // send 288 notifications before breakfast.
    expect(dedupeKey).toMatch(/^scheduled-task-failure:job-1:\d{4}-\d{2}-\d{2}$/);
  });

  it('does not notify on a manual run — the operator is looking at the result', async () => {
    const { db } = mockDb([], makeJob({ lastRunStatus: 'failed' }));

    await runAndRecord(db, makeJob(), {}, { notify: false });

    expect(notifyTenantScheduledTaskFailure).not.toHaveBeenCalled();
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
