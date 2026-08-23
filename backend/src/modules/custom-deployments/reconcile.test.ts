import { describe, it, expect } from 'vitest';
import { readFirstPodObservation } from './reconcile.js';
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
