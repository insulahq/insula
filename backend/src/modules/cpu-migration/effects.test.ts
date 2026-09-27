import { describe, it, expect, vi } from 'vitest';
import {
  quantityToMillis, largestDeclaredCpuMillis, largestInScopePodMillis,
  readPodCpuLimits, readWorkloads, widenQuotaHeadroom, removeQuotaLimits,
} from './effects.js';

/**
 * effects.ts had no tests, and the adversarial review named that as the
 * reason its defects were invisible: every apply/revert test injects fakes
 * for these functions, so by construction they cannot catch a bug inside
 * one. These exercise the parsing and the patch BODIES — the parts that
 * decide what the cluster is actually told.
 */

const pod = (o: {
  name: string; prio?: string | null; owned?: boolean; phase?: string;
  containers?: Array<{ req?: string; lim?: string; name?: string }>;
}) => ({
  metadata: { name: o.name, ownerReferences: o.owned === false ? [] : [{ kind: 'ReplicaSet' }] },
  spec: {
    priorityClassName: o.prio === null ? undefined : (o.prio ?? 'tenant-default'),
    containers: (o.containers ?? []).map((c, i) => ({
      name: c.name ?? `c${i}`,
      resources: {
        requests: c.req ? { cpu: c.req } : {},
        limits: c.lim ? { cpu: c.lim } : {},
      },
    })),
  },
  status: { phase: o.phase ?? 'Running' },
});

const k8sWith = (pods: unknown[], extra: Record<string, unknown> = {}) => ({
  core: {
    listNamespacedPod: vi.fn(async () => ({ items: pods })),
    ...extra,
  },
  apps: { listNamespacedDeployment: vi.fn(async () => ({ items: [] })), listNamespacedStatefulSet: vi.fn(async () => ({ items: [] })) },
} as never);

describe('quantityToMillis', () => {
  it('reads both Kubernetes CPU spellings', () => {
    expect(quantityToMillis('2')).toBe(2000);
    expect(quantityToMillis('300m')).toBe(300);
    expect(quantityToMillis('0.5')).toBe(500);
  });

  // A garbage quantity must read as 0 and not NaN — NaN would propagate into
  // a quota body and be rejected, or worse, serialised as "NaNm".
  it('never yields NaN', () => {
    for (const v of ['', 'abc', undefined, null]) {
      expect(quantityToMillis(v as string)).toBe(0);
    }
  });
});

describe('largestDeclaredCpuMillis', () => {
  /**
   * Feeds the LimitRange `max`, which — measured on a cluster — REJECTS a
   * container requesting more than it. Missing the largest declaration would
   * make an existing pod unschedulable.
   */
  it('takes the largest of any request OR limit', async () => {
    const k = k8sWith([
      pod({ name: 'a', containers: [{ req: '100m' }] }),
      pod({ name: 'b', containers: [{ req: '200m', lim: '1500m' }] }),
    ]);
    expect(await largestDeclaredCpuMillis(k, 'ns')).toBe(1500);
  });

  it('ignores finished pods, which constrain nothing', async () => {
    const k = k8sWith([
      pod({ name: 'done', phase: 'Succeeded', containers: [{ req: '8' }] }),
      pod({ name: 'live', containers: [{ req: '100m' }] }),
    ]);
    expect(await largestDeclaredCpuMillis(k, 'ns')).toBe(100);
  });
});

describe('largestInScopePodMillis', () => {
  // Surge room is about pods the quota governs; one it does not govern
  // cannot consume the quota and must not inflate it.
  it('counts only pods at the quota scope, summed per pod', async () => {
    const k = k8sWith([
      pod({ name: 'in', containers: [{ req: '100m' }, { req: '50m' }] }),
      pod({ name: 'out', prio: 'platform-tenant-overhead', containers: [{ req: '900m' }] }),
    ]);
    expect(await largestInScopePodMillis(k, 'ns', 'tenant-default')).toBe(150);
  });
});

describe('readPodCpuLimits', () => {
  it('reports containers with no limit, the scope, and whether anything owns it', async () => {
    const k = k8sWith([
      pod({ name: 'orphan', owned: false, containers: [{ name: 'web', req: '10m' }] }),
      pod({ name: 'fine', containers: [{ name: 'web', req: '10m', lim: '1' }] }),
    ]);
    const out = await readPodCpuLimits(k, 'ns');
    expect(out).toEqual([
      { podName: 'orphan', priorityClassName: 'tenant-default', hasController: false, containersWithoutCpuLimit: ['web'] },
      { podName: 'fine', priorityClassName: 'tenant-default', hasController: true, containersWithoutCpuLimit: [] },
    ]);
  });

  // A finished pod cannot be refused by a quota it no longer needs.
  it('skips terminal pods', async () => {
    const k = k8sWith([pod({ name: 'gone', phase: 'Failed', containers: [{ req: '1' }] })]);
    expect(await readPodCpuLimits(k, 'ns')).toEqual([]);
  });
});

describe('readWorkloads', () => {
  /**
   * StatefulSets must be waited for too. One the gate cannot see is one it
   * never waits on, so the migration would march past a database that never
   * came back.
   */
  it('covers StatefulSets as well as Deployments', async () => {
    const k = {
      core: {},
      apps: {
        listNamespacedDeployment: vi.fn(async () => ({
          items: [{ metadata: { name: 'web' }, spec: { replicas: 2 }, status: { readyReplicas: 2 } }],
        })),
        listNamespacedStatefulSet: vi.fn(async () => ({
          items: [{ metadata: { name: 'db' }, spec: { replicas: 1 }, status: { readyReplicas: 0 } }],
        })),
      },
    } as never;
    const out = await readWorkloads(k, 'ns');
    expect(out.map((w) => w.name).sort()).toEqual(['db', 'web']);
    expect(out.find((w) => w.name === 'db')).toMatchObject({ desiredReplicas: 1, readyReplicas: 0 });
  });

  it('surfaces a ReplicaFailure as the failure message', async () => {
    const k = {
      core: {},
      apps: {
        listNamespacedDeployment: vi.fn(async () => ({
          items: [{
            metadata: { name: 'web' }, spec: { replicas: 1 }, status: {
              readyReplicas: 0,
              conditions: [{ type: 'ReplicaFailure', status: 'True', message: 'exceeded quota' }],
            },
          }],
        })),
        listNamespacedStatefulSet: vi.fn(async () => ({ items: [] })),
      },
    } as never;
    expect((await readWorkloads(k, 'ns'))[0].failureMessage).toBe('exceeded quota');
  });
});

describe('widenQuotaHeadroom', () => {
  const quotaK8s = (hard: string, used: string, pods: unknown[]) => {
    const patch = vi.fn(async () => ({}));
    const k = {
      core: {
        readNamespacedResourceQuota: vi.fn(async () => ({
          spec: { hard: { 'requests.cpu': hard } }, status: { used: { 'requests.cpu': used } },
        })),
        patchNamespacedResourceQuota: patch,
        listNamespacedPod: vi.fn(async () => ({ items: pods })),
      },
      apps: {},
    } as never;
    return { k, patch };
  };

  /**
   * ★ The fix for the CRITICAL. A Terminating pod holds its full reservation
   * for its grace period and the legacy quota has ZERO slack, so without
   * this the first replacement is refused by the tenant's own quota — with
   * the old pod already deleted.
   */
  it('raises requests.cpu to fit a replacement alongside the pod it replaces', async () => {
    const { k, patch } = quotaK8s('500m', '500m', [pod({ name: 'a', containers: [{ req: '300m' }] })]);
    await widenQuotaHeadroom(k, 'ns', 'tenant-default');
    const body = (patch.mock.calls[0] as unknown[])[0] as { body: { spec: { hard: Record<string, string> } } };
    expect(body.body.spec.hard['requests.cpu']).toBe('800m'); // 500 used + 300 largest
    // The ceiling is NOT added here — that is the armed trap for later.
    expect(body.body.spec.hard['limits.cpu']).toBeUndefined();
  });

  it('leaves an already-roomy quota untouched', async () => {
    const { k, patch } = quotaK8s('4', '100m', [pod({ name: 'a', containers: [{ req: '50m' }] })]);
    await widenQuotaHeadroom(k, 'ns', 'tenant-default');
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('removeQuotaLimits', () => {
  /**
   * The mirror of the freeze: a revert RESTORES larger requests, so `used`
   * climbs as it runs. Writing the legacy figure blindly can land below it
   * and leave the tenant unable to create a pod.
   */
  it('never writes requests.cpu below what the namespace holds', async () => {
    const patch = vi.fn(async () => ({}));
    const k = {
      core: {
        readNamespacedResourceQuota: vi.fn(async () => ({ status: { used: { 'requests.cpu': '1500m' } } })),
        patchNamespacedResourceQuota: patch,
      },
      apps: {},
    } as never;
    await removeQuotaLimits(k, 'ns', 1); // legacy says 1 core
    const body = (patch.mock.calls[0] as unknown[])[0] as { body: { spec: { hard: Record<string, string | null> } } };
    expect(body.body.spec.hard['requests.cpu']).toBe('1500m');
    // null DELETES the key under RFC 7396 — this is how the ceiling comes off.
    expect(body.body.spec.hard['limits.cpu']).toBeNull();
  });
});
