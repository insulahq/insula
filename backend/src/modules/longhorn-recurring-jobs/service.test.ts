/**
 * The tick's fail-closed behaviour.
 *
 * `planSnapshotSweep` decides what is safe to delete; this file proves the tick
 * DECLINES when it cannot ask that question honestly — an unreadable CNPG PVC
 * list, a cluster mid-bootstrap with no database PVC yet, an empty RecurringJob
 * list. Each of those, taken as "nothing to protect", would turn the sweep on
 * the platform database's own rollback chain.
 */
import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { reconcileLonghornRecurringJobs, SYSTEM_CRITICAL_GROUP } from './service.js';
import { GROUP_LABEL_PREFIX } from './selection.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface FakeState {
  pvcs?: Array<{ spec?: { volumeName?: string } }> | Error;
  volumes?: Array<{ metadata: { name: string; labels?: Record<string, string> }; status?: { state?: string } }>;
  jobs?: Array<{ metadata: { name: string }; spec: { groups: string[] } }>;
  snapshots?: Array<{ metadata: { name: string }; spec: { volume: string; labels?: Record<string, string> } }>;
}

function fakeK8s(state: FakeState) {
  const patched: Array<{ name: string; body: unknown }> = [];
  const deleted: string[] = [];
  const listCalls: string[] = [];
  const k8s = {
    core: {
      listNamespacedPersistentVolumeClaim: async () => {
        if (state.pvcs instanceof Error) throw state.pvcs;
        return { items: state.pvcs ?? [] };
      },
    },
    custom: {
      listNamespacedCustomObject: async ({ plural }: { plural: string }) => {
        listCalls.push(plural);
        // Volumes default to attached: a fixture that forgot `status.state`
        // would otherwise read as detached and quietly change the verdict.
        if (plural === 'volumes') {
          return { items: (state.volumes ?? []).map((v) => ({ status: { state: 'attached' }, ...v })) };
        }
        if (plural === 'recurringjobs') return { items: state.jobs ?? [] };
        if (plural === 'snapshots') return { items: state.snapshots ?? [] };
        return { items: [] };
      },
      patchNamespacedCustomObject: async ({ name, body }: { name: string; body: unknown }) => {
        patched.push({ name, body });
        // Mirror the write, so a re-read sees what the API server stored.
        const v = (state.volumes ?? []).find((x) => x.metadata.name === name);
        if (v) {
          v.metadata.labels = {
            ...(v.metadata.labels ?? {}),
            ...((body as { metadata?: { labels?: Record<string, string> } }).metadata?.labels ?? {}),
          };
        }
      },
      deleteNamespacedCustomObject: async ({ name }: { name: string }) => { deleted.push(name); },
    },
  } as unknown as K8sClients;
  return { k8s, patched, deleted, listCalls };
}

const hourlySnapJob = { metadata: { name: 'hourly-snap' }, spec: { groups: [SYSTEM_CRITICAL_GROUP] } };
const recurringSnap = (name: string, volume: string) =>
  ({ metadata: { name }, spec: { volume, labels: { RecurringJob: 'hourly-snap' } } });

describe('reconcileLonghornRecurringJobs', () => {
  it('declines the whole tick when the platform database PVCs cannot be read', async () => {
    const { k8s, deleted } = fakeK8s({
      pvcs: new Error('connection refused'),
      volumes: [{ metadata: { name: 'pvc-t1', labels: { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' } } }],
      jobs: [hourlySnapJob],
      snapshots: [recurringSnap('s1', 'pvc-t1')],
    });
    const r = await reconcileLonghornRecurringJobs({ k8s, log });
    expect(r.abortedReason).toContain('connection refused');
    expect(deleted).toEqual([]);
  });

  it('declines when no platform database PVC exists yet (bootstrap / restore)', async () => {
    const { k8s, deleted } = fakeK8s({
      pvcs: [],
      volumes: [{ metadata: { name: 'pvc-t1', labels: { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' } } }],
      jobs: [hourlySnapJob],
      snapshots: [recurringSnap('s1', 'pvc-t1')],
    });
    const r = await reconcileLonghornRecurringJobs({ k8s, log });
    expect(r.abortedReason).toBe('no platform database PVC found');
    expect(deleted).toEqual([]);
  });

  it('declines to sweep when the RecurringJob list comes back empty', async () => {
    // Every snapshot would look like an orphan of a deleted job — 149 of them
    // on the cluster this was written for.
    const { k8s, deleted } = fakeK8s({
      pvcs: [{ spec: { volumeName: 'pvc-db' } }],
      volumes: [
        { metadata: { name: 'pvc-db', labels: { [`${GROUP_LABEL_PREFIX}${SYSTEM_CRITICAL_GROUP}`]: 'enabled' } } },
        { metadata: { name: 'pvc-t1', labels: { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' } } },
      ],
      jobs: [],
      snapshots: [recurringSnap('s1', 'pvc-t1')],
    });
    const r = await reconcileLonghornRecurringJobs({ k8s, log });
    expect(r.abortedReason).toBe('no RecurringJobs found');
    expect(deleted).toEqual([]);
  });

  it('labels the database volume into the group, then sweeps tenant orphans', async () => {
    const { k8s, patched, deleted } = fakeK8s({
      pvcs: [{ spec: { volumeName: 'pvc-db' } }],
      volumes: [
        { metadata: { name: 'pvc-db', labels: { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' } } },
        { metadata: { name: 'pvc-t1', labels: { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' } } },
      ],
      jobs: [hourlySnapJob],
      snapshots: [recurringSnap('db1', 'pvc-db'), recurringSnap('t1', 'pvc-t1'), recurringSnap('t2', 'pvc-t1')],
    });
    const r = await reconcileLonghornRecurringJobs({ k8s, log });

    expect(patched.map((p) => p.name)).toEqual(['pvc-db']);
    expect(patched[0].body).toEqual({
      metadata: { labels: { [`${GROUP_LABEL_PREFIX}${SYSTEM_CRITICAL_GROUP}`]: 'enabled' } },
    });
    // The database's own snapshot survives; the tenant's two do not.
    expect(deleted.sort()).toEqual(['t1', 't2']);
    expect(r.deletedSnapshots).toBe(2);
    expect(r.purgedVolumes).toEqual(['pvc-t1']);
  });

  it('re-reads the volumes after labelling rather than trusting its own patch', async () => {
    // The sweep's verdict hinges on those labels. Reading back what the API
    // server stored is the difference between "we asked" and "it is so".
    const { k8s, listCalls } = fakeK8s({
      pvcs: [{ spec: { volumeName: 'pvc-db' } }],
      volumes: [{ metadata: { name: 'pvc-db', labels: {} } }],
      jobs: [hourlySnapJob],
      snapshots: [],
    });
    await reconcileLonghornRecurringJobs({ k8s, log });
    expect(listCalls.filter((p) => p === 'volumes')).toHaveLength(2);
  });

  it('patches nothing and lists volumes once when already converged', async () => {
    const { k8s, patched, deleted, listCalls } = fakeK8s({
      pvcs: [{ spec: { volumeName: 'pvc-db' } }],
      volumes: [
        { metadata: { name: 'pvc-db', labels: { [`${GROUP_LABEL_PREFIX}${SYSTEM_CRITICAL_GROUP}`]: 'enabled' } } },
      ],
      jobs: [hourlySnapJob],
      snapshots: [recurringSnap('db1', 'pvc-db')],
    });
    const r = await reconcileLonghornRecurringJobs({ k8s, log });
    expect(patched).toEqual([]);
    expect(deleted).toEqual([]);
    expect(listCalls.filter((p) => p === 'volumes')).toHaveLength(1);
    expect(r.deletedSnapshots).toBe(0);
  });

  it('reports a snapshot waiting on a detached volume instead of re-deleting it', async () => {
    // Deleting a snapshot on an attached volume completes in seconds; on a
    // detached one the object stays in Terminating until the volume attaches
    // and Longhorn can purge. Both measured on a live cluster — hence the
    // count, so a tick never reads as converged while objects are outstanding.
    const { k8s, deleted } = fakeK8s({
      pvcs: [{ spec: { volumeName: 'pvc-db' } }],
      volumes: [
        { metadata: { name: 'pvc-db', labels: { [`${GROUP_LABEL_PREFIX}${SYSTEM_CRITICAL_GROUP}`]: 'enabled' } } },
        { metadata: { name: 'pvc-t1', labels: { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' } } },
      ],
      jobs: [hourlySnapJob],
      snapshots: [
        { metadata: { name: 'going', deletionTimestamp: '2026-01-01T00:00:00Z' },
          spec: { volume: 'pvc-t1', labels: { RecurringJob: 'hourly-snap' } } } as never,
        recurringSnap('stays-until-swept', 'pvc-t1'),
      ],
    });
    const r = await reconcileLonghornRecurringJobs({ k8s, log });
    expect(deleted).toEqual(['stays-until-swept']);
    expect(r.pendingPurge).toBe(1);
    // Attached and not the head's parent: mid-purge, blamed on nothing.
    expect(r.pendingDetached).toBe(0);
    expect(r.pendingHeadParent).toBe(0);
  });

  it('reads the volume attach state and the head-adjacency flag off the live objects', async () => {
    // These two fields decide which cause the tick reports; reading them from
    // the wrong place on the CR would be invisible in a plan-level test.
    const { k8s, deleted } = fakeK8s({
      pvcs: [{ spec: { volumeName: 'pvc-db' } }],
      volumes: [
        { metadata: { name: 'pvc-db', labels: { [`${GROUP_LABEL_PREFIX}${SYSTEM_CRITICAL_GROUP}`]: 'enabled' } } },
        { metadata: { name: 'pvc-off', labels: { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' } },
          status: { state: 'detached' } },
        { metadata: { name: 'pvc-on', labels: { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' } },
          status: { state: 'attached' } },
      ],
      jobs: [hourlySnapJob],
      snapshots: [
        { metadata: { name: 'on-detached', deletionTimestamp: '2026-01-01T00:00:00Z' },
          spec: { volume: 'pvc-off', labels: { RecurringJob: 'hourly-snap' } } } as never,
        { metadata: { name: 'head-parent', deletionTimestamp: '2026-01-01T00:00:00Z' },
          spec: { volume: 'pvc-on', labels: { RecurringJob: 'hourly-snap' } },
          status: { children: { 'volume-head': true } } } as never,
      ],
    });
    const r = await reconcileLonghornRecurringJobs({ k8s, log });
    expect(deleted).toEqual([]);
    expect(r.pendingDetached).toBe(1);
    expect(r.pendingHeadParent).toBe(1);
  });
});
