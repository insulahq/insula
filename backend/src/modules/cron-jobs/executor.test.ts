import { describe, it, expect, vi } from 'vitest';
import {
  executeCronJob,
  selectPod,
  selectContainer,
  describeFailure,
  type ClusterTransport,
  type CronJobRow,
  type PodSummary,
} from './executor.js';
import type { Database } from '../../db/index.js';

function makeJob(overrides: Partial<CronJobRow> = {}): CronJobRow {
  return {
    id: 'job-1',
    tenantId: 'tenant-1',
    name: 'Moodle cron',
    type: 'deployment',
    schedule: '* * * * *',
    command: 'php /var/www/html/admin/cli/cron.php',
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

/** Mocks the join chain in resolveDeployment(). */
function mockDb(rows: unknown[]): Database {
  const where = vi.fn().mockResolvedValue(rows);
  const leftJoin = vi.fn().mockReturnValue({ where });
  const innerJoin = vi.fn().mockReturnValue({ leftJoin });
  const from = vi.fn().mockReturnValue({ innerJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { select } as unknown as Database;
}

const RUNNING_DEPLOYMENT = {
  name: 'moodle-site',
  status: 'running',
  namespace: 'tenant-acme',
  entryCode: 'apache-php-office',
};

function pod(overrides: Partial<PodSummary> = {}): PodSummary {
  return {
    name: 'moodle-site-7c9d-abcde',
    phase: 'Running',
    component: 'apache-php-office',
    containers: ['apache-php-office'],
    ...overrides,
  };
}

function transport(overrides: Partial<ClusterTransport> = {}): ClusterTransport {
  return {
    listPods: vi.fn().mockResolvedValue([pod()]),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    ...overrides,
  };
}

describe('executeCronJob — deployment jobs', () => {
  it('runs the command in the resolved pod and reports success', async () => {
    const t = transport({
      exec: vi.fn().mockResolvedValue({ stdout: 'Cron completed\n', stderr: '', exitCode: 0 }),
    });

    const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });

    expect(result.status).toBe('success');
    expect(result.responseCode).toBe(0);
    expect(result.output).toBe('Cron completed');
    expect(t.exec).toHaveBeenCalledWith(
      'tenant-acme',
      'moodle-site-7c9d-abcde',
      'apache-php-office',
      ['/bin/sh', '-c', 'php /var/www/html/admin/cli/cron.php'],
      expect.any(Number),
    );
  });

  it('reports a non-zero exit as failed, with the exit code', async () => {
    const t = transport({
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: 'PHP Fatal error', exitCode: 255 }),
    });

    const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });

    expect(result.status).toBe('failed');
    expect(result.responseCode).toBe(255);
    expect(result.output).toContain('PHP Fatal error');
  });

  describe('a run that did not happen is never reported as success', () => {
    // The regression this whole module exists for: the old implementation left
    // status at its initial 'success' and wrote "not yet implemented" into the
    // output, so the panel showed a green run of a command nobody had executed.
    it('when the deployment row is gone', async () => {
      const t = transport();
      const result = await executeCronJob(mockDb([]), makeJob(), { transport: t });

      expect(result.status).toBe('failed');
      expect(result.output).toContain('no longer exists');
      expect(t.exec).not.toHaveBeenCalled();
    });

    it('when the deployment belongs to another tenant (the join returns nothing)', async () => {
      const result = await executeCronJob(mockDb([]), makeJob({ tenantId: 'someone-else' }), {
        transport: transport(),
      });
      expect(result.status).toBe('failed');
    });

    it('when the deployment is not running', async () => {
      const t = transport();
      const result = await executeCronJob(
        mockDb([{ ...RUNNING_DEPLOYMENT, status: 'stopped' }]),
        makeJob(),
        { transport: t },
      );

      expect(result.status).toBe('failed');
      expect(result.output).toContain('stopped');
      expect(t.exec).not.toHaveBeenCalled();
    });

    it('when no pod is running', async () => {
      const t = transport({ listPods: vi.fn().mockResolvedValue([pod({ phase: 'Pending' })]) });
      const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });

      expect(result.status).toBe('failed');
      expect(result.output).toContain('no running pod');
      expect(t.exec).not.toHaveBeenCalled();
    });

    it('when the command is empty', async () => {
      const t = transport();
      const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob({ command: '   ' }), {
        transport: t,
      });

      expect(result.status).toBe('failed');
      expect(result.output).toContain('no command');
      expect(t.exec).not.toHaveBeenCalled();
    });

    it('when no deployment is attached at all', async () => {
      const result = await executeCronJob(mockDb([]), makeJob({ deploymentId: null }), {
        transport: transport(),
      });
      expect(result.status).toBe('failed');
      expect(result.output).toContain('no deployment');
    });

    it('when the exec channel itself fails', async () => {
      const t = transport({ exec: vi.fn().mockRejectedValue(new Error('pod deleted mid-exec')) });
      const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });

      expect(result.status).toBe('failed');
      expect(result.output).toContain('pod deleted mid-exec');
    });

    it('when listing pods fails', async () => {
      const t = transport({ listPods: vi.fn().mockRejectedValue(new Error('api server unreachable')) });
      const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });

      expect(result.status).toBe('failed');
      expect(result.output).toContain('api server unreachable');
    });
  });

  it('keeps the tail of a long output, where the error is', async () => {
    const noise = 'x'.repeat(3000);
    const t = transport({
      exec: vi.fn().mockResolvedValue({ stdout: `${noise}THE ACTUAL ERROR`, stderr: '', exitCode: 1 }),
    });

    const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });

    expect(result.output).toContain('THE ACTUAL ERROR');
    expect(result.output).toContain('truncated');
    expect((result.output ?? '').length).toBeLessThan(2100);
  });

  it('reports a successful command with no output rather than an empty cell', async () => {
    const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), {
      transport: transport(),
    });
    expect(result.status).toBe('success');
    expect(result.output).toBe('command completed with no output');
  });
});

describe('selectPod', () => {
  it('takes the only running pod', () => {
    const result = selectPod([pod(), pod({ name: 'old', phase: 'Succeeded' })], null);
    expect('pod' in result && result.pod.name).toBe('moodle-site-7c9d-abcde');
  });

  it('disambiguates a multi-component deployment by the catalog entry code', () => {
    const app = pod({ name: 'wp-abc', component: 'wordpress' });
    const db = pod({ name: 'wp-mariadb-abc', component: 'mariadb' });
    const result = selectPod([db, app], 'wordpress');
    expect('pod' in result && result.pod.name).toBe('wp-abc');
  });

  it('refuses to guess when several pods run and none is identifiable', () => {
    // Running a tenant's command in whichever pod the API listed first is how
    // "Moodle cron" ends up executing inside MariaDB.
    const result = selectPod(
      [pod({ name: 'a', component: 'one' }), pod({ name: 'b', component: 'two' })],
      'three',
    );
    expect('error' in result).toBe(true);
    expect('error' in result && result.error).toContain('a, b');
  });

  it('reports no running pod', () => {
    const result = selectPod([pod({ phase: 'CrashLoopBackOff' })], null);
    expect('error' in result && result.error).toContain('no running pod');
  });
});

describe('selectContainer', () => {
  it('returns the only container', () => {
    expect(selectContainer(pod({ containers: ['app'] }), null)).toBe('app');
  });

  it('prefers the workload container over a sidecar', () => {
    const p = pod({ containers: ['file-manager', 'apache-php-office'] });
    expect(selectContainer(p, 'apache-php-office')).toBe('apache-php-office');
  });

  it('falls back to the first container when nothing matches', () => {
    const p = pod({ containers: ['one', 'two'] });
    expect(selectContainer(p, 'nope')).toBe('one');
  });
});

describe('executeCronJob — webcron jobs', () => {
  const webJob = makeJob({ type: 'webcron', url: 'https://example.test/cron.php', command: null });

  it('reports a 2xx as success', async () => {
    const fetchUrl = vi.fn().mockResolvedValue({ status: 200, body: 'ok' });
    const result = await executeCronJob(mockDb([]), webJob, {
      fetchUrl: fetchUrl as never,
    });

    expect(result.status).toBe('success');
    expect(result.responseCode).toBe(200);
    expect(result.output).toBe('ok');
  });

  it('reports a 500 as failed', async () => {
    const fetchUrl = vi.fn().mockResolvedValue({ status: 500, body: 'boom' });
    const result = await executeCronJob(mockDb([]), webJob, { fetchUrl: fetchUrl as never });

    expect(result.status).toBe('failed');
    expect(result.responseCode).toBe(500);
  });

  it('reports a refused request as failed', async () => {
    const fetchUrl = vi.fn().mockRejectedValue(new Error('blocked: link-local address'));
    const result = await executeCronJob(mockDb([]), webJob, { fetchUrl: fetchUrl as never });

    expect(result.status).toBe('failed');
    expect(result.responseCode).toBeNull();
    expect(result.output).toContain('link-local');
  });

  it('fails a webcron with no URL instead of claiming success', async () => {
    const result = await executeCronJob(mockDb([]), makeJob({ type: 'webcron', url: null }));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('no URL');
  });
});

describe('describeFailure', () => {
  it('names the exit code for a deployment job', () => {
    expect(describeFailure({ status: 'failed', responseCode: 2, output: 'boom', durationMs: 1 }, 'deployment'))
      .toBe('exit 2: boom');
  });

  it('says the command did not run when there is no exit code', () => {
    expect(describeFailure({ status: 'failed', responseCode: null, output: 'no running pod', durationMs: 1 }, 'deployment'))
      .toBe('did not run: no running pod');
  });

  it('names the HTTP status for a webcron job', () => {
    expect(describeFailure({ status: 'failed', responseCode: 503, output: null, durationMs: 1 }, 'webcron'))
      .toBe('HTTP 503');
  });
});
