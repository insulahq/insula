/**
 * A node reboot leaves dead pod OBJECTS behind, and nothing in Kubernetes
 * removes them promptly. These tests pin the production incident of
 * 2026-09-11 down: three tenants' deployments were `1/1` READY and serving,
 * each namespace held exactly one reboot corpse, and the admin/tenant panels
 * showed all three as FAILED — "Workload ran out of memory" — because the
 * status scan read the corpse's exit-137 container status.
 *
 * The payloads below are the real ones, copied from the live cluster:
 *   status.phase   = "Failed"
 *   status.reason  = "Terminated"
 *   status.message = "Pod was terminated in response to imminent node shutdown."
 *   containerStatuses[0].state.terminated = { exitCode: 137, reason: "Error" }
 * Note the ABSENT deletionTimestamp — a node shutdown never deletes the pod.
 */

import { describe, it, expect, vi } from 'vitest';
import { getDeploymentStatus } from './k8s-deployer.js';
import type { DeployComponentInput } from './k8s-deployer.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const COMPONENTS: DeployComponentInput[] = [
  { name: 'apache-php', type: 'deployment', image: 'apache-php:1', ports: [], optional: false },
];

function livePod(nodeName = 'node-live') {
  return {
    metadata: { name: 'my-apache-php-6f474fdf79-gpzj4' },
    spec: { nodeName },
    status: { phase: 'Running', containerStatuses: [{ name: 'apache-php', ready: true, state: { running: {} } }] },
  };
}

/** The reboot corpse, exactly as the kubelet leaves it. */
function shutdownCorpse(nodeName = 'node-dead') {
  return {
    metadata: { name: 'my-apache-php-6f474fdf79-nlztt' },
    spec: { nodeName },
    status: {
      phase: 'Failed',
      reason: 'Terminated',
      message: 'Pod was terminated in response to imminent node shutdown.',
      containerStatuses: [{
        name: 'apache-php',
        ready: false,
        state: { terminated: { exitCode: 137, reason: 'Error' } },
      }],
    },
  };
}

function makeK8s(pods: unknown[], readyReplicas = 1, replicas = 1): K8sClients {
  return {
    apps: {
      readNamespacedDeployment: vi.fn().mockResolvedValue({ spec: { replicas }, status: { replicas, readyReplicas } }),
    },
    core: {
      listNamespacedPod: vi.fn().mockResolvedValue({ items: pods }),
      listNamespacedEvent: vi.fn().mockResolvedValue({ items: [] }),
    },
  } as unknown as K8sClients;
}

describe('deployment status vs node-reboot debris', () => {
  it('reports a 1/1 deployment as running even with a shutdown corpse beside it', async () => {
    const k8s = makeK8s([livePod(), shutdownCorpse()]);
    const status = await getDeploymentStatus(k8s, 'tenant-x', 'my-apache-php', COMPONENTS);
    expect(status.phase).toBe('running');
    expect(status.components[0].ready).toBe(true);
    // and no OOM story anywhere in the message
    expect(JSON.stringify(status)).not.toContain('OOMKilled');
  });

  it('takes the host node from the live pod, not the dead one', async () => {
    const k8s = makeK8s([shutdownCorpse('node-dead'), livePod('node-live')]);
    const status = await getDeploymentStatus(k8s, 'tenant-x', 'my-apache-php', COMPONENTS);
    expect(status.components[0].nodeName).toBe('node-live');
  });

  it('ignores a rollout casualty (deletionTimestamp, no shutdown reason)', async () => {
    const drained = {
      metadata: { name: 'old-rs-pod', deletionTimestamp: '2026-09-11T12:30:00Z' },
      spec: { nodeName: 'node-live' },
      status: {
        phase: 'Running',
        containerStatuses: [{ name: 'apache-php', ready: false, state: { terminated: { exitCode: 137, reason: 'Error' } } }],
      },
    };
    const k8s = makeK8s([drained, livePod()]);
    const status = await getDeploymentStatus(k8s, 'tenant-x', 'my-apache-php', COMPONENTS);
    expect(status.phase).toBe('running');
  });

  it('ignores a Succeeded corpse (graceful shutdown, exit 0)', async () => {
    const completed = {
      metadata: { name: 'my-nginx-8486576fc7-27d57' },
      spec: { nodeName: 'node-dead' },
      status: {
        phase: 'Succeeded',
        containerStatuses: [{ name: 'apache-php', ready: false, state: { terminated: { exitCode: 0, reason: 'Completed' } } }],
      },
    };
    const k8s = makeK8s([completed, livePod()]);
    const status = await getDeploymentStatus(k8s, 'tenant-x', 'my-apache-php', COMPONENTS);
    expect(status.phase).toBe('running');
  });

  // ── Negative controls: the filter must not swallow real failures ─────────

  it('still reports a LIVE pod killed at its memory limit as failed', async () => {
    const dying = {
      metadata: { name: 'my-apache-php-live' },
      spec: { nodeName: 'node-live' },
      status: {
        phase: 'Running',
        containerStatuses: [{
          name: 'apache-php',
          ready: false,
          state: { terminated: { exitCode: 137, reason: 'OOMKilled' } },
        }],
      },
    };
    const k8s = makeK8s([dying], 0);
    const status = await getDeploymentStatus(k8s, 'tenant-x', 'my-apache-php', COMPONENTS);
    expect(status.phase).toBe('failed');
    expect(status.components[0].message).toContain('OOMKilled');
  });

  it('still reports a live CrashLoopBackOff as failed', async () => {
    const looping = {
      metadata: { name: 'my-apache-php-live' },
      spec: { nodeName: 'node-live' },
      status: {
        phase: 'Running',
        containerStatuses: [{
          name: 'apache-php',
          ready: false,
          state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } },
        }],
      },
    };
    const k8s = makeK8s([looping], 0);
    const status = await getDeploymentStatus(k8s, 'tenant-x', 'my-apache-php', COMPONENTS);
    expect(status.phase).toBe('failed');
    expect(status.components[0].message).toContain('CrashLoopBackOff');
  });
});
