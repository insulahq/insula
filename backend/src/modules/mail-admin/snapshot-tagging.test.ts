/**
 * Tests for snapshot tagging + the new wait-for-Job poll.
 *
 * Two production bugs being fixed:
 *
 * 1. (Q3) Migration-spawned snapshots used the same tags as routine
 *    CronJob runs (`stalwart-snapshot`, `auto`). Operators couldn't tell
 *    which snapshot was the "pre-migration safety net" in the list at
 *    /backups/mail?tab=backups. Fix: extra tags + env passthrough so
 *    snapshot-upload.sh adds them at restic-backup time.
 *
 * 2. (Q2) `waitForFreshSnapshot` polled `CronJob.status.lastSuccessfulTime`
 *    which is ONLY updated by Jobs the CronJob controller spawned via
 *    its own scheduling — manually-created Jobs do not update it.
 *    Result: the migration's "snapshotting" step blocked until the next
 *    `* /2` (every-two-min) CronJob fire updated lastSuccessfulTime,
 *    even though the manual Job had already completed in 4-10 s. Fix:
 *    new `waitForSnapshotJob(jobName)` polls
 *    `Job.status.succeeded == 1` against the specific Job we just spawned.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  renderManualSnapshotJobForTest,
  waitForSnapshotJob,
} from './snapshot.js';

describe('renderManualSnapshotJob: pre-migration tagging', () => {
  const baseCronJob = {
    spec: {
      jobTemplate: {
        spec: {
          template: {
            metadata: {},
            spec: {
              containers: [{
                name: 'snapshot',
                env: [{ name: 'EXISTING_ENV', value: 'keep' }],
              }],
            },
          },
        },
      },
    },
  };

  it('with no extraTags, renders a Job whose container env is unchanged', () => {
    const job = renderManualSnapshotJobForTest('stalwart-snapshot-manual-abc', baseCronJob) as Record<string, unknown>;
    const containers = ((job.spec as Record<string, unknown>).template as Record<string, unknown>).spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> };
    const env = containers.containers[0]!.env;
    expect(env.find((e) => e.name === 'EXTRA_RESTIC_TAGS')).toBeUndefined();
    expect(env.find((e) => e.name === 'EXISTING_ENV')?.value).toBe('keep');
  });

  it('with purpose=pre-migration + runId, injects EXTRA_RESTIC_TAGS env var', () => {
    const job = renderManualSnapshotJobForTest(
      'stalwart-snapshot-manual-xyz',
      baseCronJob,
      { purpose: 'pre-migration', runId: '97b9dd6c' },
    ) as Record<string, unknown>;
    const containers = ((job.spec as Record<string, unknown>).template as Record<string, unknown>).spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> };
    const env = containers.containers[0]!.env;
    const extra = env.find((e) => e.name === 'EXTRA_RESTIC_TAGS');
    expect(extra).toBeDefined();
    // snapshot-upload.sh splits on space and passes each token to --tag.
    expect(extra!.value).toBe('pre-migration run=97b9dd6c');
    // Existing env preserved (no clobber).
    expect(env.find((e) => e.name === 'EXISTING_ENV')?.value).toBe('keep');
  });

  it('also labels the Job manifest so the UI can filter by purpose without parsing tags', () => {
    const job = renderManualSnapshotJobForTest(
      'stalwart-snapshot-manual-zzz',
      baseCronJob,
      { purpose: 'pre-migration', runId: 'abc-123' },
    ) as Record<string, unknown>;
    const labels = ((job.metadata as Record<string, unknown>).labels) as Record<string, string>;
    expect(labels['mail.platform/snapshot-purpose']).toBe('pre-migration');
    expect(labels['mail.platform/migration-run-id']).toBe('abc-123');
  });

  it('skips runId in EXTRA_RESTIC_TAGS when runId is undefined (manual operator-triggered snapshot)', () => {
    const job = renderManualSnapshotJobForTest(
      'stalwart-snapshot-manual-q',
      baseCronJob,
      { purpose: 'pre-migration' },
    ) as Record<string, unknown>;
    const containers = ((job.spec as Record<string, unknown>).template as Record<string, unknown>).spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> };
    const env = containers.containers[0]!.env;
    expect(env.find((e) => e.name === 'EXTRA_RESTIC_TAGS')?.value).toBe('pre-migration');
  });

  it('falls back gracefully when the CronJob jobTemplate has no env array on the container', () => {
    const noEnvCronJob = {
      spec: {
        jobTemplate: {
          spec: {
            template: {
              metadata: {},
              spec: {
                containers: [{ name: 'snapshot' }],
              },
            },
          },
        },
      },
    };
    const job = renderManualSnapshotJobForTest(
      'stalwart-snapshot-manual-w',
      noEnvCronJob,
      { purpose: 'pre-migration', runId: 'r1' },
    ) as Record<string, unknown>;
    const containers = ((job.spec as Record<string, unknown>).template as Record<string, unknown>).spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> };
    const env = containers.containers[0]!.env;
    expect(env).toBeDefined();
    expect(env.find((e) => e.name === 'EXTRA_RESTIC_TAGS')?.value).toBe('pre-migration run=r1');
  });
});

describe('renderManualSnapshotJob: edge cases (review follow-up 2026-05-29)', () => {
  const baseCronJob = {
    spec: {
      jobTemplate: {
        spec: {
          template: {
            metadata: {},
            spec: { containers: [{ name: 'snapshot', env: [] }] },
          },
        },
      },
    },
  };

  it('purpose undefined + runId set: EXTRA_RESTIC_TAGS contains only run=<id>', () => {
    const job = renderManualSnapshotJobForTest(
      'stalwart-snapshot-manual-r',
      baseCronJob,
      { runId: 'orphan-run-id' },
    ) as Record<string, unknown>;
    const containers = ((job.spec as Record<string, unknown>).template as Record<string, unknown>).spec as { containers: Array<{ env: Array<{ name: string; value: string }> }> };
    const env = containers.containers[0]!.env;
    expect(env.find((e) => e.name === 'EXTRA_RESTIC_TAGS')?.value).toBe('run=orphan-run-id');
    // No purpose label when purpose absent.
    const labels = ((job.metadata as Record<string, unknown>).labels) as Record<string, string>;
    expect(labels['mail.platform/snapshot-purpose']).toBeUndefined();
    expect(labels['mail.platform/migration-run-id']).toBe('orphan-run-id');
  });

  it('purpose/runId propagate to BOTH Job metadata.labels AND spec.template.metadata.labels (pod labels)', () => {
    const job = renderManualSnapshotJobForTest(
      'stalwart-snapshot-manual-x',
      baseCronJob,
      { purpose: 'pre-migration', runId: 'run-99' },
    ) as Record<string, unknown>;
    const jobLabels = ((job.metadata as Record<string, unknown>).labels) as Record<string, string>;
    const templateLabels = (((job.spec as Record<string, unknown>).template as Record<string, unknown>).metadata as Record<string, unknown>).labels as Record<string, string>;
    expect(jobLabels['mail.platform/snapshot-purpose']).toBe('pre-migration');
    expect(jobLabels['mail.platform/migration-run-id']).toBe('run-99');
    expect(templateLabels['mail.platform/snapshot-purpose']).toBe('pre-migration');
    expect(templateLabels['mail.platform/migration-run-id']).toBe('run-99');
  });
});

describe('triggerMailSnapshot: input validation (security hardening)', () => {
  // assertLabelSafe is module-private; the public surface is the
  // ApiError thrown out of triggerMailSnapshot. Test the regex directly
  // via the same code path the production caller uses.
  it('rejects purpose containing shell-special characters', async () => {
    const { triggerMailSnapshot } = await import('./snapshot.js');
    await expect(
      triggerMailSnapshot({
        kubeconfigPath: undefined,
        purpose: 'pre-migration; rm -rf /',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_LABEL' });
  });

  it('rejects runId longer than 63 chars (K8s label-value max)', async () => {
    const { triggerMailSnapshot } = await import('./snapshot.js');
    const longRunId = 'a'.repeat(64);
    await expect(
      triggerMailSnapshot({
        kubeconfigPath: undefined,
        runId: longRunId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_LABEL' });
  });

  it('rejects empty-string purpose (leading-char rule)', async () => {
    const { triggerMailSnapshot } = await import('./snapshot.js');
    await expect(
      triggerMailSnapshot({
        kubeconfigPath: undefined,
        purpose: '',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_LABEL' });
  });

  it('rejects purpose starting with a hyphen or dot (DNS-1123 leading-char rule)', async () => {
    const { triggerMailSnapshot } = await import('./snapshot.js');
    await expect(
      triggerMailSnapshot({
        kubeconfigPath: undefined,
        purpose: '-bad',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SNAPSHOT_LABEL' });
  });
});

describe('waitForSnapshotJob: polls the Job, not the CronJob', () => {
  it('returns as soon as Job.status.succeeded is 1', async () => {
    let calls = 0;
    const readJob = vi.fn(async () => {
      calls += 1;
      // First call: still running; second call: succeeded.
      if (calls === 1) return { status: { active: 1, succeeded: 0 } };
      return { status: { active: 0, succeeded: 1 } };
    });
    const start = Date.now();
    await waitForSnapshotJob({
      jobName: 'stalwart-snapshot-manual-abc',
      timeoutMs: 30_000,
      pollIntervalMs: 50,
      readJob,
    });
    expect(readJob).toHaveBeenCalledTimes(2);
    // Sanity: returned in under a second.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('throws when Job.status.failed is non-zero (operator gets a real error not a 5-min timeout)', async () => {
    const readJob = vi.fn(async () => ({ status: { active: 0, succeeded: 0, failed: 1 } }));
    await expect(
      waitForSnapshotJob({
        jobName: 'stalwart-snapshot-manual-fail',
        timeoutMs: 5_000,
        pollIntervalMs: 50,
        readJob,
      }),
    ).rejects.toThrow(/snapshot Job .* failed/i);
  });

  it('throws when timeoutMs elapses without success or failure (e.g. Job stuck Pending)', async () => {
    const readJob = vi.fn(async () => ({ status: { active: 1, succeeded: 0 } }));
    await expect(
      waitForSnapshotJob({
        jobName: 'stalwart-snapshot-manual-stuck',
        timeoutMs: 200,
        pollIntervalMs: 50,
        readJob,
      }),
    ).rejects.toThrow(/timed out|deadline/i);
  });

  it('keeps polling when readJob throws transiently — never let an ENOENT race kill the wait', async () => {
    let calls = 0;
    const readJob = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('ENOENT');
      return { status: { active: 0, succeeded: 1 } };
    });
    await waitForSnapshotJob({
      jobName: 'stalwart-snapshot-manual-flake',
      timeoutMs: 5_000,
      pollIntervalMs: 30,
      readJob,
    });
    expect(readJob).toHaveBeenCalledTimes(3);
  });

  it('isCancelRequested throwing is treated as not-cancelled (DB blip must not kill wait)', async () => {
    // Pre-fix this would propagate the DB error, which the outer
    // migration would log as "snapshot failed" + proceed past the
    // cancel — losing the cancel signal entirely.
    let calls = 0;
    const isCancelRequested = vi.fn(async () => { throw new Error('DB blip'); });
    const readJob = vi.fn(async () => {
      calls += 1;
      return calls < 2 ? { status: { active: 1, succeeded: 0 } } : { status: { active: 0, succeeded: 1 } };
    });
    await waitForSnapshotJob({
      jobName: 'stalwart-snapshot-manual-dbblip',
      timeoutMs: 5_000,
      pollIntervalMs: 30,
      readJob,
      isCancelRequested,
    });
    // Cancel hook was called but threw; wait still completed normally.
    expect(isCancelRequested.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('honors cancel signal — throws SnapshotCancelledError sentinel (typed, not regex-string)', async () => {
    const { SnapshotCancelledError } = await import('./snapshot.js');
    const readJob = vi.fn(async () => ({ status: { active: 1, succeeded: 0 } }));
    let cancelled = false;
    const waiter = waitForSnapshotJob({
      jobName: 'stalwart-snapshot-manual-cancel',
      timeoutMs: 30_000,
      pollIntervalMs: 50,
      readJob,
      isCancelRequested: () => Promise.resolve(cancelled),
    });
    setTimeout(() => { cancelled = true; }, 100);
    await expect(waiter).rejects.toBeInstanceOf(SnapshotCancelledError);
  });
});
