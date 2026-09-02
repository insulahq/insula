import { describe, it, expect } from 'vitest';
import { readFirstPodObservation, readReplicaCreateFailure } from './reconcile.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * Regression tests for the crash-loop detection that used to leave a failing
 * container stuck showing "Starting…" forever: the reconcile takes ONE snapshot
 * and a crash-looping container alternates between `terminated` (just exited)
 * and `waiting=CrashLoopBackOff`. Relying on the instantaneous reason missed the
 * crash whenever it sampled the `terminated` half. Detection is now driven by
 * restartCount so it no longer depends on timing. Reproduced live on DEV
 * 2026-08-23 (a container exiting 1 sat at status 'pending' across reconciles).
 */

function k8sWithPods(pods: unknown[]): K8sClients {
  return {
    core: {
      listNamespacedPod: async () => ({ items: pods }),
    },
  } as unknown as K8sClients;
}

const container = (over: Record<string, unknown> = {}) => ({
  name: 'app',
  ready: false,
  restartCount: 0,
  state: {},
  ...over,
});

const pod = (cs: Record<string, unknown>, nodeName = 'node-a') => ({
  spec: { nodeName },
  status: { containerStatuses: [cs] },
});

describe('readFirstPodObservation crash-loop detection', () => {
  it('flags a crash-loop sampled in the TERMINATED state (the bug)', async () => {
    // Exactly the case the old code missed: caught mid-crash, not in backoff.
    const k8s = k8sWithPods([pod(container({
      ready: false,
      restartCount: 5,
      state: { terminated: { reason: 'Error', exitCode: 1 } },
    }))]);
    const obs = await readFirstPodObservation(k8s, 'ns', 'app');
    expect(obs.failureReason).toBeTruthy();
    expect(obs.failureReason).toContain('CrashLoopBackOff');
    expect(obs.failureReason).toContain('exit 1');
    expect(obs.failureReason).toContain('5 restarts');
    expect(obs.pendingReason).toBeNull();
  });

  it('flags a crash-loop sampled in the WAITING=CrashLoopBackOff state', async () => {
    const k8s = k8sWithPods([pod(container({
      ready: false,
      restartCount: 3,
      state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 40s' } },
    }))]);
    const obs = await readFirstPodObservation(k8s, 'ns', 'app');
    expect(obs.failureReason).toContain('CrashLoopBackOff');
  });

  it('flags ImagePullBackOff / ErrImagePull as failure', async () => {
    for (const reason of ['ImagePullBackOff', 'ErrImagePull']) {
      const k8s = k8sWithPods([pod(container({ state: { waiting: { reason } } }))]);
      const obs = await readFirstPodObservation(k8s, 'ns', 'app');
      expect(obs.failureReason).toContain(reason);
    }
  });

  it('flags OOMKilled from lastState even when currently waiting', async () => {
    const k8s = k8sWithPods([pod(container({
      restartCount: 2,
      state: { waiting: { reason: 'CrashLoopBackOff' } },
      lastState: { terminated: { reason: 'OOMKilled', exitCode: 137 } },
    }))]);
    const obs = await readFirstPodObservation(k8s, 'ns', 'app');
    // OOM takes precedence over the generic backoff message.
    expect(obs.failureReason).toContain('OOMKilled');
  });

  it('does NOT flag a container still legitimately starting (ContainerCreating, 0 restarts)', async () => {
    const k8s = k8sWithPods([pod(container({
      ready: false,
      restartCount: 0,
      state: { waiting: { reason: 'ContainerCreating' } },
    }))]);
    const obs = await readFirstPodObservation(k8s, 'ns', 'app');
    expect(obs.failureReason).toBeNull();
    expect(obs.pendingReason).toContain('ContainerCreating');
  });

  it('does NOT flag a container that restarted once during startup (below threshold)', async () => {
    const k8s = k8sWithPods([pod(container({
      ready: false,
      restartCount: 1,
      state: { terminated: { reason: 'Error', exitCode: 1 } },
    }))]);
    const obs = await readFirstPodObservation(k8s, 'ns', 'app');
    expect(obs.failureReason).toBeNull();
  });

  it('captures the scheduled node', async () => {
    const k8s = k8sWithPods([pod(container({ ready: true }), 'worker-2')]);
    const obs = await readFirstPodObservation(k8s, 'ns', 'app');
    expect(obs.node).toBe('worker-2');
  });
});

/**
 * Admission refusals are invisible to every pod-derived diagnostic, because no
 * Pod is ever created. Kubernetes records the reason on the ReplicaSet.
 *
 * Production, 2026-09-02: a custom container was started whose spec asked for
 * the tenant's whole CPU allowance while a sibling deployment held part of it.
 * The ReplicaSet emitted FailedCreate every few seconds; the panel showed
 * status `pending` with an empty status_message and an empty last_error — no
 * error, no timeout, no feedback of any kind, for as long as the operator
 * cared to wait (the only escalation was a 60-minute "no progress" timeout).
 */
function k8sWithReplicaSets(items: unknown[], events: unknown[] = []): K8sClients {
  return {
    apps: { listNamespacedReplicaSet: async () => ({ items }) },
    core: { listNamespacedEvent: async () => ({ items: events }) },
  } as unknown as K8sClients;
}

const QUOTA_MSG =
  'pods "sitewright-7f75ffbd58-4dfd4" is forbidden: exceeded quota: tenant-x-quota, '
  + 'requested: requests.cpu=4, used: requests.cpu=250m, limited: requests.cpu=4';

describe('readReplicaCreateFailure — admission refusals with no Pod to inspect', () => {
  it('surfaces a quota refusal from the ReplicaFailure condition', async () => {
    const k8s = k8sWithReplicaSets([{
      metadata: { name: 'sitewright-7f75ffbd58' },
      spec: { replicas: 1 },
      status: { conditions: [{ type: 'ReplicaFailure', status: 'True', message: QUOTA_MSG }] },
    }]);
    const msg = await readReplicaCreateFailure(k8s, 'ns', 'sitewright');
    expect(msg).toBeTruthy();
    // Reformatted for operators, not the raw kubelet string.
    expect(msg).not.toBe(QUOTA_MSG);
    expect(msg).toMatch(/CPU request/i);
  });

  it('ignores scaled-down historical ReplicaSets, which keep stale conditions forever', async () => {
    const k8s = k8sWithReplicaSets([{
      metadata: { name: 'sitewright-oldrs' },
      spec: { replicas: 0 },
      status: { conditions: [{ type: 'ReplicaFailure', status: 'True', message: QUOTA_MSG }] },
    }]);
    expect(await readReplicaCreateFailure(k8s, 'ns', 'sitewright')).toBeNull();
  });

  it('ignores a ReplicaFailure that is no longer True', async () => {
    const k8s = k8sWithReplicaSets([{
      metadata: { name: 'sitewright-abc' },
      spec: { replicas: 1 },
      status: { conditions: [{ type: 'ReplicaFailure', status: 'False', message: QUOTA_MSG }] },
    }]);
    expect(await readReplicaCreateFailure(k8s, 'ns', 'sitewright')).toBeNull();
  });

  it('does not match a different deployment sharing a name prefix', async () => {
    // `sitewright-staging-<hash>` must not be read as `sitewright`'s ReplicaSet.
    const k8s = k8sWithReplicaSets([{
      metadata: { name: 'sitewright-staging-7f75ffbd58' },
      spec: { replicas: 1 },
      status: { conditions: [{ type: 'ReplicaFailure', status: 'True', message: QUOTA_MSG }] },
    }]);
    const msg = await readReplicaCreateFailure(k8s, 'ns', 'sitewright-staging');
    expect(msg).toBeTruthy();
    expect(await readReplicaCreateFailure(k8s, 'ns', 'other')).toBeNull();
  });

  it('falls back to the FailedCreate event when no condition is present', async () => {
    const k8s = k8sWithReplicaSets(
      [{ metadata: { name: 'sitewright-abc' }, spec: { replicas: 1 }, status: {} }],
      [{ reason: 'FailedCreate', involvedObject: { kind: 'ReplicaSet', name: 'sitewright-abc' }, message: QUOTA_MSG }],
    );
    expect(await readReplicaCreateFailure(k8s, 'ns', 'sitewright')).toMatch(/CPU request/i);
  });

  it('passes a non-quota refusal through verbatim', async () => {
    const psa = 'pods "x-1" is forbidden: violates PodSecurity "restricted:latest"';
    const k8s = k8sWithReplicaSets([{
      metadata: { name: 'x-1' }, spec: { replicas: 1 },
      status: { conditions: [{ type: 'ReplicaFailure', status: 'True', message: psa }] },
    }]);
    expect(await readReplicaCreateFailure(k8s, 'ns', 'x')).toBe(psa);
  });

  it('returns null rather than throwing when the cluster reads fail', async () => {
    const k8s = {
      apps: { listNamespacedReplicaSet: async () => { throw new Error('boom'); } },
      core: { listNamespacedEvent: async () => { throw new Error('boom'); } },
    } as unknown as K8sClients;
    expect(await readReplicaCreateFailure(k8s, 'ns', 'x')).toBeNull();
  });
});
