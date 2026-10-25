import { describe, it, expect, vi } from 'vitest';
import {
  executeCronJob,
  runTimeoutMs,
  selectPod,
  selectContainer,
  describeFailure,
  clip,
  outputTail,
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

  // Production, a server being shut down: the platform's exec connection to its
  // own cluster API timed out, and the tenant was emailed that their task "did
  // not run: connect ETIMEDOUT <cluster-ip>:443".
  describe('a run the platform could not start because it could not reach its cluster', () => {
    // The shapes measured from the libraries: the exec WebSocket rejects with a
    // ws ErrorEvent carrying the socket error on .error (the transport wraps it
    // as the cause); a REST call through fetch rejects "fetch failed" with the
    // socket error as its cause.
    const wsUnreachable = (code: string) => new Error(`connect ${code} 10.0.0.1:443`, {
      cause: { message: `connect ${code} 10.0.0.1:443`, error: Object.assign(new Error(`connect ${code} 10.0.0.1:443`), { code, syscall: 'connect' }) },
    });
    const fetchUnreachable = (code: string) => new TypeError('fetch failed', {
      cause: Object.assign(new Error(`connect ${code} 10.0.0.1:443`), { code }),
    });

    it('is marked as the platform\'s fault when the exec connection could not be made', async () => {
      const t = transport({ exec: vi.fn().mockRejectedValue(wsUnreachable('ETIMEDOUT')) });
      const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });

      expect(result.status).toBe('failed');
      expect(result.platformFault).toBe('could not reach the cluster API: connect ETIMEDOUT 10.0.0.1:443');
      expect(result.notStarted).toBe(true);
      // Tenant-visible: what happened, without the platform's internal address.
      expect(result.output).toBe(
        'Not run: the platform could not reach its cluster API (ETIMEDOUT). The command was not started — a platform problem, not a failure of this task.',
      );
    });

    it('is marked as the platform\'s fault when its pods could not be listed', async () => {
      for (const code of ['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT']) {
        const t = transport({ listPods: vi.fn().mockRejectedValue(fetchUnreachable(code)) });
        const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });
        expect(result.platformFault).toMatch(/^could not reach the cluster API: /);
        expect(result.notStarted).toBe(true);
        expect(result.output).toContain(`(${code})`);
        expect(t.exec).not.toHaveBeenCalled();
      }
    });

    it('is the platform\'s fault, but not certainly unstarted, when the connection broke during the handshake', async () => {
      const reset = new Error('read ECONNRESET', {
        cause: { error: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }) },
      });
      const t = transport({ exec: vi.fn().mockRejectedValue(reset) });
      const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });
      expect(result.platformFault).toBe('lost its connection to the cluster API: read ECONNRESET');
      expect(result.notStarted).toBe(false);
      expect(result.output).toMatch(/^Not confirmed: .*whether it started is unknown/);
    });

    it('is not the platform\'s fault when the API answered and refused', async () => {
      // The API server was reached: whatever it said is reported as before.
      const t = transport({ exec: vi.fn().mockRejectedValue(new Error('pod deleted mid-exec', { cause: { message: 'Unexpected server response: 404' } })) });
      const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });
      expect(result.platformFault).toBeUndefined();
      expect(result.output).toContain('pod deleted mid-exec');
    });

    it('is not the platform\'s fault when the command exited non-zero', async () => {
      const t = transport({ exec: vi.fn().mockResolvedValue({ stdout: '', stderr: 'connect ETIMEDOUT db:3306', exitCode: 1 }) });
      const result = await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob(), { transport: t });
      expect(result.platformFault).toBeUndefined();
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

  // Production: a long Moodle run was reported as "exit 1: …(truncated) …Cron
  // run completed correctly / Cron c" — the start of the kept tail, cut off
  // before the lines that said why it failed.
  it('carries the LAST lines of a long output, where a failing command says why', () => {
    const chatter = Array.from({ length: 80 }, (_, i) => `Cron run completed correctly (pass ${i})`).join('\n');
    const output = clip(`${chatter}\n!!! Error: Database connection failed !!!`) as string;
    expect(output.startsWith('…(truncated)\n')).toBe(true);

    const text = describeFailure({ status: 'failed', responseCode: 1, output, durationMs: 1 }, 'deployment');
    expect(text.endsWith('!!! Error: Database connection failed !!!')).toBe(true);
    expect(text).not.toContain('(truncated)');
    // Shortened, said so, and starting on a whole line.
    expect(text).toMatch(/^exit 1: …Cron run completed correctly \(pass \d+\)\n/);
    expect(text.length).toBeLessThan(330);
  });
});

describe('outputTail', () => {
  it('leaves a short output as it is', () => {
    expect(outputTail('HTTP 503: no available server')).toBe('HTTP 503: no available server');
  });

  it('marks an output clip() shortened even when what is left is short', () => {
    expect(outputTail('…(truncated)\nthe last line')).toBe('…the last line');
  });

  it('keeps the end of one long line rather than nothing', () => {
    const tail = outputTail('x'.repeat(500) + 'END');
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.endsWith('END')).toBe(true);
    expect(tail.length).toBe(301);
  });
});

describe('runTimeoutMs', () => {
  // One ceiling cannot fit both types. A webcron ping that needs 30 s is
  // broken; Moodle's admin/cli/cron.php took 182 s on a freshly installed site
  // (measured on DEV), and a course backup or search reindex takes longer —
  // against the old hard-coded 300 s the run was abandoned mid-flight and
  // recorded as a failure while the process carried on inside the pod.
  it('defaults to 30s for a webcron job', () => {
    expect(runTimeoutMs({ type: 'webcron', timeoutSeconds: null })).toBe(30_000);
  });

  it('defaults to 300s for a deployment job', () => {
    expect(runTimeoutMs({ type: 'deployment', timeoutSeconds: null })).toBe(300_000);
  });

  it('uses the job value when set — this is the whole point', () => {
    expect(runTimeoutMs({ type: 'deployment', timeoutSeconds: 900 })).toBe(900_000);
    expect(runTimeoutMs({ type: 'webcron', timeoutSeconds: 120 })).toBe(120_000);
  });

  it('clamps to the contract bounds rather than trusting a stored value', () => {
    // A row written before the bounds existed, or by a future caller, must not
    // be able to pin a worker for a day or spin at 0.
    expect(runTimeoutMs({ type: 'deployment', timeoutSeconds: 99_999 })).toBe(3_600_000);
    expect(runTimeoutMs({ type: 'deployment', timeoutSeconds: 1 })).toBe(5_000);
  });

  it('lets an explicit override win, for tests and callers that know better', () => {
    expect(runTimeoutMs({ type: 'deployment', timeoutSeconds: 900 }, 42)).toBe(42);
  });
});

describe('the configured timeout reaches both execution paths', () => {
  it('is passed to the pod exec for a deployment job', async () => {
    const t = transport();
    await executeCronJob(mockDb([RUNNING_DEPLOYMENT]), makeJob({ timeoutSeconds: 900 }), { transport: t });

    expect(t.exec).toHaveBeenCalledWith(
      expect.any(String), expect.any(String), expect.any(String), expect.any(Array), 900_000,
    );
  });

  it('is passed to the HTTP request for a webcron job', async () => {
    const fetchUrl = vi.fn().mockResolvedValue({ status: 200, body: 'ok' });
    await executeCronJob(
      mockDb([]),
      makeJob({ type: 'webcron', url: 'https://example.test/cron.php', command: null, timeoutSeconds: 120 }),
      { fetchUrl: fetchUrl as never },
    );

    expect(fetchUrl).toHaveBeenCalledWith(
      'https://example.test/cron.php',
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('still applies the per-type default when the job sets none', async () => {
    const fetchUrl = vi.fn().mockResolvedValue({ status: 200, body: 'ok' });
    await executeCronJob(
      mockDb([]),
      makeJob({ type: 'webcron', url: 'https://example.test/cron.php', command: null, timeoutSeconds: null }),
      { fetchUrl: fetchUrl as never },
    );

    expect(fetchUrl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });
});

describe('podDisruptionReason — the platform\'s own marks on a pod it stopped', () => {
  it('the kubelet stopped it for a node shutdown', async () => {
    const { podDisruptionReason } = await import('./executor.js');
    expect(podDisruptionReason({ status: { phase: 'Succeeded', conditions: [{ type: 'DisruptionTarget', status: 'True', reason: 'TerminationByKubelet' }] } }))
      .toBe('the server it ran on was shutting down');
    expect(podDisruptionReason({ status: { phase: 'Failed', reason: 'Terminated' } })).toBe('the server it ran on was shutting down');
  });

  it('another disruption, or a pod being replaced', async () => {
    const { podDisruptionReason } = await import('./executor.js');
    expect(podDisruptionReason({ status: { conditions: [{ type: 'DisruptionTarget', status: 'True', reason: 'EvictionByEvictionAPI' }] } }))
      .toBe('the platform stopped the pod it ran in (EvictionByEvictionAPI)');
    expect(podDisruptionReason({ metadata: { deletionTimestamp: '2026-10-18T10:10:43Z' }, status: { phase: 'Running' } }))
      .toBe('the pod it ran in was being replaced');
  });

  it('a running pod with no mark is not an interruption — the command failed', async () => {
    const { podDisruptionReason } = await import('./executor.js');
    expect(podDisruptionReason({ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } })).toBeNull();
  });

  it('platformInterruption: no transport check → null; a throwing check → null', async () => {
    const { platformInterruption } = await import('./executor.js');
    const ranIn = { namespace: 'tenant-a', pod: 'p', node: 's1' };
    const base = { listPods: async () => [], exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) };
    expect(await platformInterruption(ranIn, { transport: base })).toBeNull();
    expect(await platformInterruption(ranIn, { transport: { ...base, podDisruption: async () => { throw new Error('x'); } } })).toBeNull();
  });
});

