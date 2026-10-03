import { describe, expect, it, vi } from 'vitest';
import {
  describeJobFailure,
  describeStuckPod,
  formatJobFailure,
  jobFailureReason,
  podNamesFromJobEvents,
  summariseWarningEvents,
} from './k8s-job-failure.js';

import { tenantVisibleText } from './operator-only-text.js';

const JOB = 'bk-files-bkp-1';
const POD = 'bk-files-bkp-1-abcde';

describe('jobFailureReason', () => {
  it('reads the Failed condition', () => {
    expect(jobFailureReason([
      { type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' },
    ])).toBe('BackoffLimitExceeded: Job has reached the specified backoff limit');
  });

  it('reads FailureTarget, which is set first while the controller deletes the pods', () => {
    // The production failure surfaced as a bare "Job failed": the watcher saw
    // status.failed > 0 before the Failed condition existed.
    expect(jobFailureReason([
      { type: 'FailureTarget', status: 'True', reason: 'DeadlineExceeded', message: 'Job was active longer than specified deadline' },
    ])).toBe('DeadlineExceeded: Job was active longer than specified deadline');
  });

  it('ignores conditions that are not True, and returns null when nothing says why', () => {
    expect(jobFailureReason([{ type: 'Failed', status: 'False', reason: 'X' }])).toBeNull();
    expect(jobFailureReason(undefined)).toBeNull();
  });
});

describe('describeStuckPod', () => {
  it('names the node and the waiting reason of a pod whose container never started', () => {
    expect(describeStuckPod({
      metadata: { name: POD },
      spec: { nodeName: 'node-a' },
      status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] },
    })).toBe(`pod ${POD} on node node-a never started (ContainerCreating)`);
  });

  it('reports a pod that was never scheduled, with the scheduler message', () => {
    expect(describeStuckPod({
      metadata: { name: POD },
      spec: {},
      status: {
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/2 nodes are available' }],
      },
    })).toBe(`pod ${POD} was never scheduled (Unschedulable: 0/2 nodes are available)`);
  });

  it('reports a container that was killed, e.g. by the OOM killer', () => {
    expect(describeStuckPod({
      metadata: { name: POD },
      spec: { nodeName: 'node-a' },
      status: { phase: 'Failed', containerStatuses: [{ state: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }] },
    })).toBe(`pod ${POD} on node node-a: container exited 137 (OOMKilled)`);
  });

  it('says nothing about a pod that ran and exited cleanly', () => {
    expect(describeStuckPod({
      metadata: { name: POD },
      spec: { nodeName: 'node-a' },
      status: { phase: 'Succeeded', containerStatuses: [{ state: { terminated: { exitCode: 0, reason: 'Completed' } } }] },
    })).toBeNull();
  });
});

describe('podNamesFromJobEvents', () => {
  it('reads the pods the Job controller created, which outlive the pods themselves', () => {
    expect(podNamesFromJobEvents([
      { reason: 'SuccessfulCreate', message: `Created pod: ${POD}`, involvedObject: { kind: 'Job', name: JOB } },
      { reason: 'SuccessfulCreate', message: 'Created pod: other-x', involvedObject: { kind: 'Job', name: 'other' } },
      { reason: 'DeadlineExceeded', message: 'Job was active longer than specified deadline', involvedObject: { kind: 'Job', name: JOB } },
    ], JOB)).toEqual([POD]);
  });
});

describe('summariseWarningEvents', () => {
  const multiAttach = 'Multi-Attach error for volume "pvc-1" Volume is already used by pod(s) app-1';
  it('keeps one line per distinct event about the Job and its pods, oldest cause first', () => {
    expect(summariseWarningEvents([
      { type: 'Warning', reason: 'FailedMount', message: 'Unable to attach or mount volumes: timed out', involvedObject: { kind: 'Pod', name: POD }, lastTimestamp: '2026-01-01T00:10:00Z' },
      { type: 'Warning', reason: 'FailedAttachVolume', message: multiAttach, involvedObject: { kind: 'Pod', name: POD }, lastTimestamp: '2026-01-01T00:01:00Z' },
      { type: 'Warning', reason: 'FailedMount', message: 'Unable to attach or mount volumes: timed out', involvedObject: { kind: 'Pod', name: POD }, lastTimestamp: '2026-01-01T00:12:00Z' },
      { type: 'Warning', reason: 'BackOff', message: 'someone else', involvedObject: { kind: 'Pod', name: 'app-1' } },
      { type: 'Normal', reason: 'Scheduled', message: 'Successfully assigned', involvedObject: { kind: 'Pod', name: POD } },
      // The deadline itself is already in the condition — repeating it is noise.
      { type: 'Warning', reason: 'DeadlineExceeded', message: 'Job was active longer than specified deadline', involvedObject: { kind: 'Job', name: JOB } },
    ], JOB, new Set([POD]))).toEqual([
      `FailedAttachVolume: ${multiAttach}`,
      'FailedMount: Unable to attach or mount volumes: timed out',
    ]);
  });

  it('keeps every distinct message of a reason — the informative one is not always the latest', () => {
    // The events a DEV probe Job produced for an unpullable image: three
    // `Failed` warnings with tied timestamps. Keeping one per reason kept
    // "Error: ErrImagePull" and dropped the line that names the image.
    const pulled = 'Failed to pull image "registry.example.test/x:nope": not found';
    const ev = (message: string, first: string, last: string) => ({
      type: 'Warning', reason: 'Failed', message, involvedObject: { kind: 'Pod', name: POD },
      firstTimestamp: first, lastTimestamp: last,
    });
    expect(summariseWarningEvents([
      ev('Error: ImagePullBackOff', '2026-01-01T00:00:30Z', '2026-01-01T00:00:59Z'),
      ev(pulled, '2026-01-01T00:00:29Z', '2026-01-01T00:01:12Z'),
      ev('Error: ErrImagePull', '2026-01-01T00:00:29Z', '2026-01-01T00:01:12Z'),
    ], JOB, new Set([POD]))).toEqual([
      `Failed: ${pulled}`,
      'Failed: Error: ErrImagePull',
      'Failed: Error: ImagePullBackOff',
    ]);
  });

  it('treats retries that differ only in the generated pod name as one event', () => {
    // The Job controller retries a refused pod create under a new random name
    // each time; without normalising, one quota block fills every line.
    const refused = (suffix: string) => ({
      type: 'Warning', reason: 'FailedCreate', involvedObject: { kind: 'Job', name: JOB },
      message: `Error creating: pods "${JOB}-${suffix}" is forbidden: exceeded quota: q, requested: pods=1`,
    });
    expect(summariseWarningEvents([refused('aaaaa'), refused('bbbbb'), refused('ccccc')], JOB, new Set()))
      .toEqual([`FailedCreate: Error creating: pods "${JOB}-…" is forbidden: exceeded quota: q, requested: pods=1`]);
  });

  it('folds the event aggregator prefix, which a DEV quota block produced as a second copy', () => {
    const combined = {
      type: 'Warning', reason: 'FailedCreate', involvedObject: { kind: 'Job', name: JOB },
      message: `(combined from similar events): Error creating: pods "${JOB}-ddddd" is forbidden: exceeded quota: q`,
    };
    const plain = { ...combined, message: `Error creating: pods "${JOB}-eeeee" is forbidden: exceeded quota: q` };
    expect(summariseWarningEvents([plain, combined], JOB, new Set()))
      .toEqual([`FailedCreate: Error creating: pods "${JOB}-…" is forbidden: exceeded quota: q`]);
  });

  it('caps a long message', () => {
    const [line] = summariseWarningEvents([
      { type: 'Warning', reason: 'FailedMount', message: 'x'.repeat(1000), involvedObject: { kind: 'Pod', name: POD } },
    ], JOB, new Set([POD]));
    expect(line!.length).toBeLessThan(320);
  });
});

function fakeCore(opts: { pods?: unknown[]; jobEvents?: unknown[]; warnings?: unknown[]; fail?: boolean }) {
  return {
    listNamespacedPod: vi.fn(async (req: { labelSelector?: string }) => {
      if (opts.fail) throw new Error('apiserver down');
      expect(req.labelSelector).toBe(`job-name=${JOB}`);
      return { items: opts.pods ?? [] };
    }),
    listNamespacedEvent: vi.fn(async (req: { fieldSelector?: string }) => {
      if (opts.fail) throw new Error('apiserver down');
      if (req.fieldSelector === 'type=Warning') return { items: opts.warnings ?? [] };
      expect(req.fieldSelector).toBe(`involvedObject.kind=Job,involvedObject.name=${JOB}`);
      return { items: opts.jobEvents ?? [] };
    }),
  };
}

describe('describeJobFailure', () => {
  it('explains a deadline on a pod that could never mount its volume — after the pod is gone', async () => {
    const core = fakeCore({
      pods: [],
      jobEvents: [{ reason: 'SuccessfulCreate', message: `Created pod: ${POD}`, involvedObject: { kind: 'Job', name: JOB } }],
      warnings: [{
        type: 'Warning',
        reason: 'FailedAttachVolume',
        message: 'Multi-Attach error for volume "pvc-1" Volume is already used by pod(s) app-1',
        involvedObject: { kind: 'Pod', name: POD },
      }],
    });
    const d = await describeJobFailure(core, 'tenant-a', JOB, [
      { type: 'FailureTarget', status: 'True', reason: 'DeadlineExceeded', message: 'Job was active longer than specified deadline' },
    ]);
    expect(d).toEqual({
      reason: 'DeadlineExceeded: Job was active longer than specified deadline',
      details: ['FailedAttachVolume: Multi-Attach error for volume "pvc-1" Volume is already used by pod(s) app-1'],
    });
  });

  it('includes the live pod state when the pod still exists', async () => {
    const core = fakeCore({
      pods: [{
        metadata: { name: POD },
        spec: { nodeName: 'node-a' },
        status: { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] },
      }],
    });
    expect(await describeJobFailure(core, 'tenant-a', JOB, undefined))
      .toEqual({ reason: 'Job failed', details: [`pod ${POD} on node node-a never started (ContainerCreating)`] });
  });

  it('never throws — an unreadable cluster still yields the condition', async () => {
    const core = fakeCore({ fail: true });
    expect(await describeJobFailure(core, 'tenant-a', JOB, [
      { type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' },
    ])).toEqual({ reason: 'BackoffLimitExceeded: Job has reached the specified backoff limit', details: [] });
  });
});

describe('formatJobFailure', () => {
  it('puts every detail behind the operator-only marker, so a tenant surface can cut it', () => {
    const text = formatJobFailure(
      { reason: 'DeadlineExceeded: x', details: [`pod ${POD} on node node-a never started`] },
      ['pinned to node node-a (mounted)'],
    );
    expect(text).toBe(`DeadlineExceeded: x; diagnosis: pod ${POD} on node node-a never started; pinned to node node-a (mounted)`);
    expect(tenantVisibleText(text)).toBe('DeadlineExceeded: x');
  });

  it('is just the reason when there is nothing to add', () => {
    expect(formatJobFailure({ reason: 'Job failed', details: [] }, [])).toBe('Job failed');
  });
});
