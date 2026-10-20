import { describe, it, expect, vi } from 'vitest';
import {
  rollPodsStillCapped,
  quantityToMillis, largestInScopePodMillis,
  readPodCpuLimits, readWorkloads, widenQuotaHeadroom, removeQuotaLimits,
  ensureTieredQuotaRoom,
} from './effects.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/**
 * effects.ts had no tests, and the adversarial review named that as the
 * reason its defects were invisible: every apply/revert test injects fakes
 * for these functions, so by construction they cannot catch a bug inside
 * one. These exercise the parsing and the patch BODIES — the parts that
 * decide what the cluster is actually told.
 */

const pod = (o: {
  name: string; prio?: string | null; owned?: boolean; phase?: string; terminating?: boolean;
  containers?: Array<{ req?: string; lim?: string; name?: string }>;
}) => ({
  metadata: {
    name: o.name,
    ownerReferences: o.owned === false ? [] : [{ kind: 'ReplicaSet' }],
    ...(o.terminating ? { deletionTimestamp: '2020-01-01T00:00:00Z' } : {}),
  },
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
      { podName: 'orphan', priorityClassName: 'tenant-default', hasController: false, containersWithoutCpuLimit: ['web'], containerCpuLimitsMillis: [] },
      // The limit it DOES carry, in millicores — what a re-apply compares
      // against to find pods still admitted under the previous ceiling.
      { podName: 'fine', priorityClassName: 'tenant-default', hasController: true, containersWithoutCpuLimit: [], containerCpuLimitsMillis: [1000] },
    ]);
  });

  /**
   * ★ A TERMINATING pod reports phase "Running". The end-to-end run caught
   * this: the sweep replaced a limitless pod, the replacement came up with
   * its ceiling, and the check still refused — counting the pod being
   * replaced, mid-termination. It blocked on the corpse of the problem it
   * had just fixed.
   */
  it('ignores a pod that is on its way out', async () => {
    const k = k8sWith([
      pod({ name: 'dying', terminating: true, containers: [{ name: 'web', req: '200m' }] }),
      pod({ name: 'fresh', containers: [{ name: 'web', req: '5m', lim: '4' }] }),
    ]);
    const out = await readPodCpuLimits(k, 'ns');
    expect(out.map((p) => p.podName)).toEqual(['fresh']);
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

describe('ensureTieredQuotaRoom', () => {
  /**
   * ★ The gap that made the tier model a one-way street.
   *
   * `applyQuotaLimits` sizes requests.cpu from what the namespace held at
   * migration plus one pod's surge — a snapshot nothing revisited. Every
   * migrated tenant was left with about 100m of room: three more small
   * applications, then "exceeded quota" on the fourth, weeks after the
   * migration nobody would connect it to.
   */
  /**
   * `tiered` is now decided by the LimitRange, not by a `limits.cpu` on the
   * quota — that key is gone. A fixture without the LimitRange reader is a
   * legacy namespace.
   */
  const quota = (hard: Record<string, string>, used: Record<string, string>, tiered = true) => ({
    core: {
      readNamespacedResourceQuota: vi.fn(async () => ({ spec: { hard }, status: { used } })),
      patchNamespacedResourceQuota: vi.fn(async () => ({})),
      readNamespacedLimitRange: vi.fn(async () => {
        if (tiered) return { spec: { limits: [{ type: 'Container', default: { cpu: '1' } }] } };
        throw Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 });
      }),
    },
  } as unknown as K8sClients & { core: { patchNamespacedResourceQuota: ReturnType<typeof vi.fn> } });

  it('raises requests.cpu to fit the workload plus surge', async () => {
    const k = quota({ 'requests.cpu': '110m' }, { 'requests.cpu': '10m' });
    await ensureTieredQuotaRoom(k, 'ns', 100);
    const body = k.core.patchNamespacedResourceQuota.mock.calls[0][0].body;
    // held 10 + the new 100 + 100 surge
    expect(body.spec.hard['requests.cpu']).toBe('210m');
  });

  it('never lowers a quota that is already roomy', async () => {
    const k = quota({ 'requests.cpu': '4' }, { 'requests.cpu': '10m' });
    await ensureTieredQuotaRoom(k, 'ns', 30);
    expect(k.core.patchNamespacedResourceQuota).not.toHaveBeenCalled();
  });

  it('leaves a LEGACY namespace alone', async () => {
    // Its requests.cpu IS the plan allowance; widening it would quietly
    // sell CPU nobody bought.
    const k = quota({ 'requests.cpu': '250m' }, { 'requests.cpu': '250m' }, false);
    await ensureTieredQuotaRoom(k, 'ns', 100);
    expect(k.core.patchNamespacedResourceQuota).not.toHaveBeenCalled();
  });

  /**
   * ★ The gate used to be "does the quota carry limits.cpu". Once that key
   * was removed everywhere, that test answered false for every tenant and
   * this function became a no-op — the requests budget would have stopped
   * growing as applications were added, which is the same wall one axis
   * over and the reason this test exists.
   */
  it('widens a tiered namespace that has no limits.cpu at all', async () => {
    const k = quota({ 'requests.cpu': '110m' }, { 'requests.cpu': '10m' });
    await ensureTieredQuotaRoom(k, 'ns', 100);
    expect(k.core.patchNamespacedResourceQuota).toHaveBeenCalled();
    const body = k.core.patchNamespacedResourceQuota.mock.calls[0][0].body;
    expect(body.spec.hard['limits.cpu']).toBeUndefined();
  });

  it('does nothing when there is no quota at all', async () => {
    const k = {
      core: {
        readNamespacedResourceQuota: vi.fn(async () => { throw Object.assign(new Error('HTTP-Code: 404'), { statusCode: 404 }); }),
        patchNamespacedResourceQuota: vi.fn(async () => ({})),
      },
    } as unknown as K8sClients & { core: { patchNamespacedResourceQuota: ReturnType<typeof vi.fn> } };
    await expect(ensureTieredQuotaRoom(k, 'ns', 100)).resolves.toBeUndefined();
    expect(k.core.patchNamespacedResourceQuota).not.toHaveBeenCalled();
  });

  it('rethrows a read failure that is not a 404', async () => {
    // An unreadable API is not an absent quota.
    const k = {
      core: {
        readNamespacedResourceQuota: vi.fn(async () => { throw Object.assign(new Error('HTTP-Code: 500'), { statusCode: 500 }); }),
      },
    } as unknown as K8sClients;
    await expect(ensureTieredQuotaRoom(k, 'ns', 100)).rejects.toThrow(/500/);
  });
});
