/**
 * captureScaleDownDiagnostics — the mail migration's scale-down timeout used
 * to throw a bare "Deployment <name> did not reach 0 ready replica(s) within
 * 60s". That names the deployment and nothing else, so a failure could not be
 * explained afterwards: the pod is gone by the time anyone reads the error.
 *
 * These cases pin the four states that actually cause the timeout, because
 * each implies a DIFFERENT fix:
 *   - terminating but slow      → the grace budget is too tight
 *   - terminating + finalizer   → something is wedging deletion
 *   - NOT terminating           → the force-delete pass skipped it, since that
 *                                 pass is onlyTerminating by default
 *   - recreated on another node → something scaled the deployment back up
 */
import { describe, it, expect, vi } from 'vitest';

const { captureScaleDownDiagnostics } = await import('./migration.js');

type Pod = Record<string, unknown>;

function makeApis(pods: Pod[], deployments: Record<string, { spec?: unknown; status?: unknown }>) {
  const core = {
    listNamespacedPod: vi.fn().mockResolvedValue({ items: pods }),
  } as never;
  const apps = {
    readNamespacedDeployment: vi.fn(async ({ name }: { name: string }) => {
      const d = deployments[name];
      if (!d) throw new Error('not found');
      return d;
    }),
  } as never;
  return { core, apps };
}

const log = { warn: vi.fn() };

function pod(over: Record<string, unknown> = {}): Pod {
  return {
    metadata: { name: 'stalwart-mail-abc', labels: { app: 'stalwart-mail' }, ...(over.metadata as object ?? {}) },
    spec: {
      nodeName: 'node-a',
      volumes: [{ persistentVolumeClaim: { claimName: 'mail-stack-data' } }],
      ...(over.spec as object ?? {}),
    },
    status: { phase: 'Running', ...(over.status as object ?? {}) },
  };
}

const DEPLOYS = {
  'stalwart-mail': { spec: { replicas: 0 }, status: { replicas: 1, readyReplicas: 0, unavailableReplicas: 1 } },
  bulwark: { spec: { replicas: 0 }, status: {} },
};

describe('captureScaleDownDiagnostics', () => {
  it('reports the replica counters the wait actually gates on', async () => {
    const { core, apps } = makeApis([], DEPLOYS);
    const out = await captureScaleDownDiagnostics(core, apps, log);
    expect(out).toContain('stalwart-mail: spec=0 status=1/ready=0/unavail=1');
    // Absent status fields must read as 0, matching waitForStalwartReplicaCount's `?? 0`.
    expect(out).toContain('bulwark: spec=0 status=0/ready=0/unavail=0');
  });

  it('distinguishes a pod that is terminating (and for how long) from one that is not', async () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    const { core, apps } = makeApis(
      [pod({ metadata: { name: 'sw-1', labels: { app: 'stalwart-mail' }, deletionTimestamp: tenSecondsAgo, deletionGracePeriodSeconds: 300 } })],
      DEPLOYS,
    );
    const out = await captureScaleDownDiagnostics(core, apps, log);
    expect(out).toMatch(/pod=sw-1 .*terminating=yes\(\d+s\)/);
    expect(out).toContain('grace=300');
  });

  it('flags a pod that was never asked to terminate — the force-delete pass skips those', async () => {
    const { core, apps } = makeApis([pod({ metadata: { name: 'sw-2', labels: { app: 'stalwart-mail' } } })], DEPLOYS);
    const out = await captureScaleDownDiagnostics(core, apps, log);
    expect(out).toContain('terminating=NO');
  });

  it('surfaces finalizers that wedge deletion', async () => {
    const { core, apps } = makeApis(
      [pod({ metadata: { name: 'sw-3', labels: { app: 'stalwart-mail' }, deletionTimestamp: new Date().toISOString(), finalizers: ['kubernetes.io/pvc-protection'] } })],
      DEPLOYS,
    );
    const out = await captureScaleDownDiagnostics(core, apps, log);
    expect(out).toContain('finalizers=kubernetes.io/pvc-protection');
  });

  it('covers BOTH mail-stack deployments and records the node + PVC mount', async () => {
    const { core, apps } = makeApis(
      [
        pod({ metadata: { name: 'sw-4', labels: { app: 'stalwart-mail' } }, spec: { nodeName: 'node-b', volumes: [{ persistentVolumeClaim: { claimName: 'mail-stack-data' } }] } }),
        pod({ metadata: { name: 'bw-1', labels: { app: 'bulwark' } }, spec: { nodeName: 'node-b', volumes: [] } }),
      ],
      DEPLOYS,
    );
    const out = await captureScaleDownDiagnostics(core, apps, log);
    expect(out).toContain('pod=sw-4');
    expect(out).toContain('pod=bw-1');
    expect(out).toContain('node=node-b');
    expect(out).toContain('mountsMailPvc=yes');
    expect(out).toContain('mountsMailPvc=no');
  });

  it('ignores unrelated pods in the mail namespace', async () => {
    const { core, apps } = makeApis(
      [pod({ metadata: { name: 'roundcube-x', labels: { app: 'roundcube' } } })],
      DEPLOYS,
    );
    const out = await captureScaleDownDiagnostics(core, apps, log);
    expect(out).toContain('pods=<none>');
    expect(out).not.toContain('roundcube-x');
  });

  it('degrades to a usable string when the API reads fail', async () => {
    const core = { listNamespacedPod: vi.fn().mockRejectedValue(new Error('boom')) } as never;
    const apps = { readNamespacedDeployment: vi.fn().mockRejectedValue(new Error('boom')) } as never;
    const out = await captureScaleDownDiagnostics(core, apps, log);
    expect(out).toContain('<deployment unreadable>');
    expect(out).toContain('pods=<unreadable>');
  });
});
