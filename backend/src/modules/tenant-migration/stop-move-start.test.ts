import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { QuiesceSnapshot } from '../storage-lifecycle/quiesce.js';
import {
  planTenantMove,
  readMoveFacts,
  runTenantMove,
  type MoveOutcome,
  type MoveSteps,
  type VolumeConsumer,
} from './stop-move-start.js';

const NS = 'tenant-acme-1234';
const pod = (name: string, node: string | null, over: Partial<VolumeConsumer> = {}): VolumeConsumer => ({
  name, node, ownerKind: 'ReplicaSet', managed: false, ...over,
});

describe('planTenantMove', () => {
  it('restarts in place when nothing mounts the volume (a stopped tenant)', () => {
    expect(planTenantMove([], 'node-a', false)).toEqual({ kind: 'restart' });
  });

  it('restarts in place when every pod already runs on the target ("make primary")', () => {
    expect(planTenantMove([pod('web-1', 'node-a'), pod('db-1', 'node-a')], 'node-a', false)).toEqual({ kind: 'restart' });
  });

  it('ignores a pod that is not scheduled yet', () => {
    expect(planTenantMove([pod('web-1', null)], 'node-a', false)).toEqual({ kind: 'restart' });
  });

  it('stops, moves and starts a tenant running on another node', () => {
    expect(planTenantMove([pod('web-1', 'node-b'), pod('db-1', 'node-b'), pod('moodle-1', 'node-b')], 'node-a', false))
      .toEqual({ kind: 'stop-move-start', sourceNodes: ['node-b'] });
  });

  it('names every node the tenant leaves, once each, sorted', () => {
    expect(planTenantMove([pod('a', 'node-c'), pod('b', 'node-b'), pod('c', 'node-c'), pod('d', 'node-a')], 'node-a', false))
      .toEqual({ kind: 'stop-move-start', sourceNodes: ['node-b', 'node-c'] });
  });

  it('waits for a backup Job that holds the volume — the stop would cut it off', () => {
    expect(planTenantMove([pod('web-1', 'node-b'), pod('bk-files-abc', 'node-b', { ownerKind: 'Job' })], 'node-a', false))
      .toEqual({ kind: 'busy', holders: ['bk-files-abc'] });
  });

  it('does not wait for a tenant CronJob run — quiesce deletes those itself', () => {
    expect(planTenantMove([pod('web-1', 'node-b'), pod('wp-cron-1', 'node-b', { ownerKind: 'Job', managed: true })], 'node-a', false))
      .toEqual({ kind: 'stop-move-start', sourceNodes: ['node-b'] });
  });

  it('waits for a bare pod that mounts the volume', () => {
    expect(planTenantMove([pod('web-1', 'node-b'), pod('debug', 'node-b', { ownerKind: null })], 'node-a', false))
      .toEqual({ kind: 'busy', holders: ['debug'] });
  });

  it('waits while a platform task holds the file manager', () => {
    expect(planTenantMove([pod('web-1', 'node-b')], 'node-a', true))
      .toEqual({ kind: 'busy', holders: ['file-manager (held by a platform task)'] });
  });

  it('a held file manager does not block an in-place restart', () => {
    expect(planTenantMove([pod('web-1', 'node-a')], 'node-a', true)).toEqual({ kind: 'restart' });
  });
});

const SNAP: QuiesceSnapshot = { deployments: [{ name: 'web', replicas: 1 }], cronJobs: [] };
const COPY = { started: ['pvc-1'], skipped: [], error: null };

/** Fake steps recording every call in order; `fail` makes the named step throw. */
function fakeSteps(opts: { fail?: string; failPinBack?: boolean; restored?: boolean } = {}) {
  const calls: string[] = [];
  const outcomes: MoveOutcome[] = [];
  const step = <T>(name: string, value: T) => async (): Promise<T> => {
    calls.push(name);
    if (opts.fail === name) throw new Error(`${name} broke`);
    return value;
  };
  const steps: MoveSteps = {
    progress: async (state, pct) => { calls.push(`progress:${state}:${pct}`); },
    quiesce: step('quiesce', SNAP),
    waitForPodsGone: step('waitForPodsGone', 0),
    waitForDetached: step('waitForDetached', undefined),
    repin: async (node) => {
      calls.push(`repin:${node}`);
      if (opts.fail === 'repin' && node === 'node-a') throw new Error('repin broke');
      if (opts.failPinBack && node === 'node-b') throw new Error('pin back broke');
    },
    recordPrimary: step('recordPrimary', undefined),
    startCopy: step('startCopy', COPY),
    unquiesce: async (snap) => { calls.push(`unquiesce:${snap.deployments.length}`); if (opts.fail === 'unquiesce') throw new Error('unquiesce broke'); },
    restore: async (snap) => { calls.push(`restore:${snap ? 'snap' : 'none'}`); return opts.restored ?? true; },
    finish: async (o) => { calls.push(`finish:${o.ok ? 'ok' : 'failed'}`); outcomes.push(o); },
  };
  return { steps, calls, outcomes };
}

const NODES = { sourceNodes: ['node-b'], target: 'node-a' };
const withoutProgress = (calls: string[]) => calls.filter((c) => !c.startsWith('progress:'));

describe('runTenantMove', () => {
  it('stops, waits for the detach, re-pins, starts the copy, then starts the tenant — in that order', async () => {
    const { steps, calls, outcomes } = fakeSteps();
    await runTenantMove(steps, NODES);
    expect(withoutProgress(calls)).toEqual([
      'quiesce', 'waitForPodsGone', 'waitForDetached', 'repin:node-a', 'recordPrimary', 'startCopy', 'unquiesce:1', 'finish:ok',
    ]);
    expect(outcomes[0]).toMatchObject({ ok: true, dataRelocation: COPY });
    expect((outcomes[0] as { message: string }).message).toContain('copying the data');
  });

  it('reports progress as quiescing until the start, then unquiescing', async () => {
    const { steps, calls } = fakeSteps();
    await runTenantMove(steps, NODES);
    const progress = calls.filter((c) => c.startsWith('progress:'));
    expect(progress.at(-1)).toBe('progress:unquiescing:70');
    expect(progress.slice(0, -1).every((c) => c.startsWith('progress:quiescing:'))).toBe(true);
  });

  it('never re-pins before the volume has detached: a detach timeout starts the tenant again on the source', async () => {
    const { steps, calls, outcomes } = fakeSteps({ fail: 'waitForDetached' });
    await runTenantMove(steps, NODES);
    expect(calls.some((c) => c.startsWith('repin:'))).toBe(false);
    expect(withoutProgress(calls).slice(-2)).toEqual(['restore:snap', 'finish:failed']);
    expect(outcomes[0]).toMatchObject({ ok: false, restored: true });
    const error = (outcomes[0] as { error: string }).error;
    expect(error).toContain('waiting for its volume to detach');
    expect(error).toContain('waitForDetached broke');
    expect(error).toContain('started again on node-b');
  });

  it('a quiesce that throws still restores, from the persisted snapshot', async () => {
    const { steps, calls } = fakeSteps({ fail: 'quiesce' });
    await runTenantMove(steps, NODES);
    expect(withoutProgress(calls)).toEqual(['quiesce', 'restore:none', 'finish:failed']);
  });

  it('a re-pin that fails part way pins everything back to the source before starting it', async () => {
    const { steps, calls, outcomes } = fakeSteps({ fail: 'repin' });
    await runTenantMove(steps, NODES);
    expect(withoutProgress(calls).slice(-4)).toEqual(['repin:node-a', 'repin:node-b', 'restore:snap', 'finish:failed']);
    expect((outcomes[0] as { error: string }).error).toContain('started again on node-b');
  });

  it('pins a tenant split across nodes back onto one of them', async () => {
    const { steps, calls, outcomes } = fakeSteps({ fail: 'repin' });
    await runTenantMove(steps, { sourceNodes: ['node-b', 'node-c'], target: 'node-a' });
    expect(calls.filter((c) => c.startsWith('repin:'))).toEqual(['repin:node-a', 'repin:node-b']);
    expect((outcomes[0] as { error: string }).error).toContain('started again on node-b.');
  });

  it('says the pins are mixed when pinning back fails too', async () => {
    const { steps, outcomes } = fakeSteps({ fail: 'repin', failPinBack: true });
    await runTenantMove(steps, NODES);
    expect((outcomes[0] as { error: string }).error).toContain('started again on node-b and node-a');
  });

  it('a start that fails after the re-pin starts the tenant on the target', async () => {
    const { steps, calls, outcomes } = fakeSteps({ fail: 'unquiesce' });
    await runTenantMove(steps, NODES);
    expect(withoutProgress(calls).slice(-2)).toEqual(['restore:snap', 'finish:failed']);
    expect(calls.filter((c) => c.startsWith('repin:'))).toEqual(['repin:node-a']);
    expect((outcomes[0] as { error: string }).error).toContain('started again on node-a');
  });

  it('says so when the workloads could not be started again', async () => {
    const { steps, outcomes } = fakeSteps({ fail: 'waitForPodsGone', restored: false });
    await runTenantMove(steps, NODES);
    expect(outcomes[0]).toMatchObject({ ok: false, restored: false });
    expect((outcomes[0] as { error: string }).error).toContain('could not be started again on node-b');
  });

  it('a recordPrimary failure after the re-pin restores on the target', async () => {
    const { steps, calls, outcomes } = fakeSteps({ fail: 'recordPrimary' });
    await runTenantMove(steps, NODES);
    expect(calls.filter((c) => c.startsWith('repin:'))).toEqual(['repin:node-a']);
    expect((outcomes[0] as { error: string }).error).toContain('started again on node-a');
  });
});

describe('readMoveFacts', () => {
  const PVC = `${NS}-storage`;
  const mounts = (claimName: string) => ({ volumes: [{ name: 'data', persistentVolumeClaim: { claimName } }] });
  const k8s = {
    core: {
      listNamespacedPod: async () => ({
        items: [
          { metadata: { name: 'web-1', ownerReferences: [{ kind: 'ReplicaSet', controller: true }] }, spec: { nodeName: 'node-b', ...mounts(PVC) }, status: { phase: 'Running' } },
          { metadata: { name: 'bk-files-1', ownerReferences: [{ kind: 'Job', controller: true }] }, spec: { nodeName: 'node-b', ...mounts(PVC) }, status: { phase: 'Pending' } },
          { metadata: { name: 'cron-1', labels: { 'platform.io/managed': 'true' }, ownerReferences: [{ kind: 'Job' }] }, spec: { nodeName: 'node-b', ...mounts(PVC) }, status: { phase: 'Running' } },
          { metadata: { name: 'done-1', ownerReferences: [{ kind: 'Job' }] }, spec: { nodeName: 'node-b', ...mounts(PVC) }, status: { phase: 'Succeeded' } },
          { metadata: { name: 'solver' }, spec: { nodeName: 'node-b', volumes: [] }, status: { phase: 'Running' } },
          { metadata: { name: 'other-pvc' }, spec: { nodeName: 'node-b', ...mounts('something-else') }, status: { phase: 'Running' } },
        ],
      }),
    },
    apps: {
      listNamespacedDeployment: async () => ({
        items: [
          { metadata: { name: 'web' }, spec: { replicas: 1 } },
          { metadata: { name: 'file-manager', annotations: { 'fm-lease.insula.host/bundle-abcd1234': String(2_000) } }, spec: { replicas: 0 } },
        ],
      }),
    },
  } as unknown as K8sClients;

  it('lists only unfinished pods that mount the tenant volume, with owner and managed flag', async () => {
    const facts = await readMoveFacts(k8s, NS, 1_000);
    expect(facts.consumers).toEqual([
      { name: 'web-1', node: 'node-b', ownerKind: 'ReplicaSet', managed: false },
      { name: 'bk-files-1', node: 'node-b', ownerKind: 'Job', managed: false },
      { name: 'cron-1', node: 'node-b', ownerKind: 'Job', managed: true },
    ]);
    expect(facts.runningDeployments).toBe(1);
  });

  it('sees a live file-manager lease, and not an expired one', async () => {
    expect((await readMoveFacts(k8s, NS, 1_000)).fileManagerLeased).toBe(true);
    expect((await readMoveFacts(k8s, NS, 3_000)).fileManagerLeased).toBe(false);
  });
});
