import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  compareSubscriptionToCluster,
  readClusterState,
  type ClusterState,
  type SubscriptionLimits,
} from './service.js';

/** The production case: 512 MiB plan, 2 GiB PVC that was never shrunk. */
const PLAN_512MI: SubscriptionLimits = { storageGi: 0.5, cpuCores: 0.1, memoryGi: 0.1 };

function cluster(over: Partial<ClusterState> = {}): ClusterState {
  return { hard: {}, used: {}, pvcRequest: null, readable: true, ...over };
}

describe('compareSubscriptionToCluster', () => {
  it('flags a PVC larger than the subscription — the case every screen hid', () => {
    const rows = compareSubscriptionToCluster(PLAN_512MI, cluster({
      hard: { 'requests.storage': '512Mi' },
      used: { 'requests.storage': '2Gi' },
      pvcRequest: '2Gi',
    }));
    const storage = rows.find((r) => r.resource === 'storage')!;

    // 0.5 GiB is rendered canonically, so it reads correctly beside "2Gi"
    // rather than as the easily-misread "0.5Gi".
    expect(storage.subscription).toBe('512Mi');
    expect(storage.provisioned).toBe('2Gi');
    expect(storage.exceedsSubscription).toBe(true);
  });

  it('flags it even when the quota was NEVER updated to the new plan', () => {
    // Plan lowered to 512Mi, but neither the quota nor the PVC was touched, so
    // used == hard and the live quota is NOT exceeded. Comparing only the quota
    // would call this healthy; comparing against the subscription catches it.
    const rows = compareSubscriptionToCluster(PLAN_512MI, cluster({
      hard: { 'requests.storage': '2Gi' },
      used: { 'requests.storage': '2Gi' },
      pvcRequest: '2Gi',
    }));
    const storage = rows.find((r) => r.resource === 'storage')!;

    expect(storage.blocked).toBe(false);            // apiserver is not rejecting
    expect(storage.exceedsSubscription).toBe(true); // ...but the tenant is over plan
    expect(storage.enforcedDiffers).toBe(true);     // ...and the quota never caught up
  });

  it('reports a PVC that matches the plan as clean', () => {
    const rows = compareSubscriptionToCluster(
      { storageGi: 1, cpuCores: 0.1, memoryGi: 0.1 },
      cluster({ hard: { 'requests.storage': '1Gi' }, used: { 'requests.storage': '1Gi' }, pvcRequest: '1Gi' }),
    );
    const storage = rows.find((r) => r.resource === 'storage')!;
    expect(storage.exceedsSubscription).toBe(false);
    expect(storage.enforcedDiffers).toBe(false);
    expect(storage.blocked).toBe(false);
  });

  it('a PVC SMALLER than the plan is not a mismatch', () => {
    const rows = compareSubscriptionToCluster(
      { storageGi: 5, cpuCores: 1, memoryGi: 1 },
      cluster({ hard: { 'requests.storage': '5Gi' }, pvcRequest: '1Gi' }),
    );
    expect(rows.find((r) => r.resource === 'storage')!.exceedsSubscription).toBe(false);
  });

  it('flags live blocking separately from being over plan', () => {
    const rows = compareSubscriptionToCluster(PLAN_512MI, cluster({
      hard: { 'requests.storage': '512Mi' },
      used: { 'requests.storage': '2Gi' },
      pvcRequest: '2Gi',
    }));
    expect(rows.find((r) => r.resource === 'storage')!.blocked).toBe(true);
  });

  it('compares CPU and memory against the quota without inventing a provisioned figure', () => {
    const rows = compareSubscriptionToCluster(
      { storageGi: 1, cpuCores: 0.1, memoryGi: 0.1 },
      cluster({ hard: { 'requests.cpu': '100m', 'limits.memory': '107374182400m' } }),
    );
    const cpu = rows.find((r) => r.resource === 'cpu')!;
    const mem = rows.find((r) => r.resource === 'memory')!;

    expect(cpu.provisioned).toBeNull();
    expect(cpu.enforced).toBe('100m');
    expect(cpu.enforcedDiffers).toBe(false);   // 100m === 0.1 cores
    // Memory hard is expressed in MILLI-bytes on real clusters (~102Mi vs a
    // 0.1Gi plan). Reading that as 107374182400 Gi would be a false alarm.
    expect(mem.enforcedDiffers).toBe(false);
  });


  // REGRESSION: the comparison used to run through the DISPLAY string, which
  // formatGiBQuantity rounds to one decimal. That mis-judged 170 of the 200
  // two-decimal GiB values a numeric(10,2) plan column can hold — roughly half
  // of them as FALSE POSITIVES, flagging a volume that exactly matches its
  // plan as over it. Every storage plan in production (0.5/1/2/5/100 GiB)
  // lands on a clean binary boundary, so live data could never have caught it.
  it('never flags a volume that exactly matches its plan, at ANY 2-dp plan size', () => {
    const offenders: string[] = [];
    for (let hundredths = 1; hundredths <= 200; hundredths++) {
      const gi = hundredths / 100;
      const rows = compareSubscriptionToCluster(
        { storageGi: gi, cpuCores: 1, memoryGi: 1 },
        // applyPVC / applyResourceQuota write the RAW value, not the display one.
        cluster({ hard: { 'requests.storage': `${gi}Gi` }, pvcRequest: `${gi}Gi` }),
      );
      const storage = rows.find((r) => r.resource === 'storage')!;
      if (storage.exceedsSubscription) offenders.push(`${gi}Gi flagged over plan`);
      if (storage.enforcedDiffers) offenders.push(`${gi}Gi flagged as quota drift`);
    }
    expect(offenders).toEqual([]);
  });

  it('still catches a genuinely oversized volume at an awkward plan size', () => {
    const rows = compareSubscriptionToCluster(
      { storageGi: 0.03, cpuCores: 1, memoryGi: 1 },
      cluster({ hard: { 'requests.storage': '0.03Gi' }, pvcRequest: '2Gi' }),
    );
    expect(rows.find((r) => r.resource === 'storage')!.exceedsSubscription).toBe(true);
  });

  it('returns nothing when the cluster could not be read — never a false all-clear', () => {
    expect(compareSubscriptionToCluster(PLAN_512MI, cluster({ readable: false }))).toEqual([]);
  });

  it('does not claim a mismatch when the PVC size is unreadable', () => {
    const rows = compareSubscriptionToCluster(PLAN_512MI, cluster({
      hard: { 'requests.storage': '512Mi' },
      pvcRequest: null,
    }));
    expect(rows.find((r) => r.resource === 'storage')!.exceedsSubscription).toBe(false);
  });
});

describe('readClusterState', () => {
  function mockK8s(quotas: unknown[], pvc?: unknown) {
    return {
      core: {
        listNamespacedResourceQuota: vi.fn(async () => ({ items: quotas })),
        readNamespacedPersistentVolumeClaim: vi.fn(async () => {
          if (pvc === undefined) throw Object.assign(new Error('nf'), { statusCode: 404 });
          return pvc;
        }),
      },
    } as unknown as K8sClients;
  }

  // Regression: an earlier revision read only `<ns>-quota` by name. Storage
  // lives in a SECOND object (`<ns>-storage-quota`) because k8s rejects
  // requests.storage inside a scoped quota — so the one case this feature
  // exists for was invisible.
  it('merges BOTH quota objects — storage lives in the second one', async () => {
    const k8s = mockK8s([
      { status: { hard: { 'requests.cpu': '100m', 'limits.memory': '1Gi' }, used: { 'requests.cpu': '50m' } } },
      { status: { hard: { 'requests.storage': '512Mi' }, used: { 'requests.storage': '2Gi' } } },
    ], { spec: { resources: { requests: { storage: '2Gi' } } } });

    const state = await readClusterState(k8s, 'tenant-x');

    expect(state.hard['requests.storage']).toBe('512Mi');
    expect(state.hard['requests.cpu']).toBe('100m');
    expect(state.used['requests.storage']).toBe('2Gi');
    expect(state.pvcRequest).toBe('2Gi');
    expect(state.readable).toBe(true);
  });

  it('marks itself unreadable when the quota list fails', async () => {
    const k8s = {
      core: {
        listNamespacedResourceQuota: vi.fn(async () => { throw new Error('API down'); }),
        readNamespacedPersistentVolumeClaim: vi.fn(async () => ({})),
      },
    } as unknown as K8sClients;

    expect((await readClusterState(k8s, 'tenant-x')).readable).toBe(false);
  });

  it('survives a missing PVC (pvc_missing covers that separately)', async () => {
    const state = await readClusterState(mockK8s([{ status: { hard: { 'requests.storage': '1Gi' } } }]), 'tenant-x');
    expect(state.pvcRequest).toBeNull();
    expect(state.readable).toBe(true);
  });
});
