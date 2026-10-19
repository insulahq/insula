import { describe, it, expect, vi } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  clusterWhole, cnpgTimestamp, movePostgresInstancesOff, switchoverPatch, type CoverNow, type InstanceRef,
} from './postgres-move.js';
import type { PostgresInstance } from './postgres-cover.js';

const HEALTHY = 'Cluster in healthy state';
const replica = (instance: string, coveredBy: string[] = ['system-db-1']): PostgresInstance =>
  ({ kind: 'postgres', cluster: 'system-db', instance, primary: false, coveredBy });
const primary = (instance: string, coveredBy: string[]): PostgresInstance =>
  ({ kind: 'postgres', cluster: 'system-db', instance, primary: true, coveredBy });
const ref = (instance: string): InstanceRef => ({ namespace: 'platform', cluster: 'system-db', instance });
/** Covered, with its data and WAL volumes' only copy on the node. */
const here = (instance: PostgresInstance): CoverNow =>
  ({ instance, volumesHere: [`vol-${instance.instance}`, `vol-${instance.instance}-wal`] });

/**
 * A CNPG cluster. Its status is computed from the live pods (CNPG's view):
 * healthy when every instance is Ready. Deleting an instance's pod re-creates
 * it on `rebuiltOn` after `rebuildPolls` pod listings — Ready unless
 * `neverReady` — with fresh claims on new volumes.
 */
function makeCluster(opts: {
  currentPrimary?: string;
  targetPrimary?: string;
  pods?: Record<string, { node: string; ready?: boolean; readyAfterPolls?: number }>;
  rebuiltOn?: string;
  rebuildPolls?: number;
  neverReady?: boolean;
  /** A deleted claim stays (Terminating) forever. */
  claimsLinger?: boolean;
  /** On this cluster read (1-based), a failover toward system-db-2 begins. */
  failoverOnRead?: number;
  switchoverFails?: number;
}) {
  const status = {
    currentPrimary: opts.currentPrimary ?? 'system-db-1',
    targetPrimary: opts.targetPrimary ?? opts.currentPrimary ?? 'system-db-1',
  };
  const pods: Record<string, { node: string; ready: boolean; readyAfterPolls: number }> = Object.fromEntries(
    Object.entries(opts.pods ?? { 'system-db-1': { node: 's1' }, 'system-db-2': { node: 's2' }, 'system-db-3': { node: 's3' } })
      .map(([n, p]) => [n, { node: p.node, ready: p.ready ?? true, readyAfterPolls: p.readyAfterPolls ?? 0 }]),
  );
  const instances = Object.keys(pods).length;
  const pvcs: Array<{ name: string; uid: string; volume: string; instance: string }> = Object.keys(pods).flatMap((n) => [
    { name: n, uid: `${n}-data-old`, volume: `vol-${n}`, instance: n },
    { name: `${n}-wal`, uid: `${n}-wal-old`, volume: `vol-${n}-wal`, instance: n },
  ]);
  const events: string[] = [];
  let clusterReads = 0;
  const readyCount = () => Object.values(pods).filter((p) => p.ready).length;
  const core = {
    listNamespacedPod: vi.fn(async () => {
      for (const [n, p] of Object.entries(pods)) {
        if (!p.ready && p.readyAfterPolls > 0 && --p.readyAfterPolls === 0) {
          p.ready = true;
          events.push(`${n} ready on ${p.node}`);
        }
      }
      return {
        items: Object.entries(pods).map(([name, p]) => ({
          metadata: { name, labels: { 'cnpg.io/cluster': 'system-db' } },
          spec: { nodeName: p.node },
          status: { conditions: [{ type: 'Ready', status: p.ready ? 'True' : 'False' }] },
        })),
      };
    }),
    listNamespacedPersistentVolumeClaim: vi.fn(async () => ({
      items: pvcs.map((p) => ({
        metadata: { name: p.name, uid: p.uid, labels: { 'cnpg.io/cluster': 'system-db', 'cnpg.io/instanceName': p.instance } },
        spec: { volumeName: p.volume },
      })),
    })),
    deleteNamespacedPersistentVolumeClaim: vi.fn(async ({ name }: { name: string }) => {
      events.push(`delete pvc ${name}`);
      const i = pvcs.findIndex((p) => p.name === name);
      if (i >= 0 && !opts.claimsLinger) pvcs.splice(i, 1);
    }),
    deleteNamespacedPod: vi.fn(async ({ name }: { name: string }) => {
      events.push(`delete pod ${name}`);
      // CNPG re-creates it from the primary, with fresh claims on new volumes.
      pods[name] = {
        node: opts.rebuiltOn ?? 's3',
        ready: false,
        readyAfterPolls: opts.neverReady ? -1 : (opts.rebuildPolls ?? 1),
      };
      pvcs.push(
        { name, uid: `${name}-data-new`, volume: `vol-${name}-new`, instance: name },
        { name: `${name}-wal`, uid: `${name}-wal-new`, volume: `vol-${name}-wal-new`, instance: name },
      );
    }),
  };
  let switchoverFails = opts.switchoverFails;
  const custom = {
    getNamespacedCustomObject: vi.fn(async () => {
      clusterReads += 1;
      if (clusterReads === opts.failoverOnRead) status.targetPrimary = 'system-db-2';
      const ready = readyCount();
      return {
        metadata: { resourceVersion: '42' },
        spec: { instances },
        status: {
          ...status,
          readyInstances: ready,
          phase: status.targetPrimary !== status.currentPrimary ? 'Switchover in progress'
            : ready === instances ? HEALTHY : 'Creating a new replica',
        },
      };
    }),
    patchNamespacedCustomObjectStatus: vi.fn(async (req: { body: { status: { targetPrimary: string } } }) => {
      if (switchoverFails) throw Object.assign(new Error('clusters.postgresql.cnpg.io "system-db" is forbidden'), { code: switchoverFails });
      events.push(`switchover to ${req.body.status.targetPrimary}`);
      status.targetPrimary = req.body.status.targetPrimary;
    }),
  };
  const k8s = { core, custom } as unknown as K8sClients;
  return { k8s, core, custom, events, status, pods };
}

/** A clock that only moves when the code sleeps. */
function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms; }) };
}

describe('cnpgTimestamp / switchoverPatch / clusterWhole', () => {
  it('writes the RFC 3339 microsecond form CNPG uses', () => {
    expect(cnpgTimestamp(Date.UTC(2026, 9, 18, 22, 0, 0, 123))).toBe('2026-10-18T22:00:00.123000Z');
  });

  it('asks for a switchover only of the current primary, and never over one already under way', () => {
    const steady = { metadata: { resourceVersion: '7' }, status: { currentPrimary: 'system-db-2', targetPrimary: 'system-db-2' } };
    expect(switchoverPatch(steady, 'system-db-2', 'system-db-1', 0)).toEqual({
      metadata: { resourceVersion: '7' },
      status: {
        targetPrimary: 'system-db-1',
        targetPrimaryTimestamp: '1970-01-01T00:00:00.000000Z',
        phase: 'Switchover in progress',
        phaseReason: 'Switching over to system-db-1',
      },
    });
    expect(switchoverPatch(steady, 'system-db-3', 'system-db-1', 0)).toBeNull();
    const underWay = { status: { currentPrimary: 'system-db-2', targetPrimary: 'system-db-3' } };
    expect(switchoverPatch(underWay, 'system-db-2', 'system-db-1', 0)).toBeNull();
  });

  it('whole = healthy, no switchover under way, every instance Ready — by CNPG and by the live pods', () => {
    const c = (phase: string, ready: number, target = 'a') =>
      ({ spec: { instances: 3 }, status: { phase, currentPrimary: 'a', targetPrimary: target, readyInstances: ready } });
    expect(clusterWhole(c(HEALTHY, 3), 3)).toBe(true);
    expect(clusterWhole(c(HEALTHY, 3), 2)).toBe(false); // a pod just went; CNPG's status has not caught up
    expect(clusterWhole(c(HEALTHY, 2), 3)).toBe(false);
    expect(clusterWhole(c('Creating a new replica', 3), 3)).toBe(false);
    expect(clusterWhole(c(HEALTHY, 3, 'b'), 3)).toBe(false);
  });
});

describe('movePostgresInstancesOff', () => {
  it('a covered replica: its claims whose copy is here and its pod are deleted, then the cluster is waited for until whole', async () => {
    const { k8s, custom, events } = makeCluster({ rebuildPolls: 3 });
    const time = fakeTime();
    const moved = await movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(replica('system-db-2')), ...time,
    });
    expect(moved).toEqual(['platform/system-db-2']);
    expect(events).toEqual(['delete pvc system-db-2', 'delete pvc system-db-2-wal', 'delete pod system-db-2', 'system-db-2 ready on s3']);
    expect(custom.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
    expect(time.sleep).toHaveBeenCalled(); // it waited for the re-creation
  });

  it('never deletes a claim whose copy is not on the node — e.g. one CNPG already re-created elsewhere', async () => {
    const { k8s, core } = makeCluster({});
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => ({ instance: replica('system-db-2'), volumesHere: ['vol-something-else'] }), ...time,
    })).rejects.toMatchObject({ code: 'NODE_DELETE_DATABASE_MOVE_STALLED', message: expect.stringContaining('No claim of database instance') });
    expect(core.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('a covered primary is switched over to a streaming standby first — its data is deleted only once it is a replica', async () => {
    const { k8s, events, status } = makeCluster({ currentPrimary: 'system-db-2' });
    const time = fakeTime();
    // CNPG completes the switchover after the request; the instance then reads as a replica.
    const coverOf = vi.fn(async (): Promise<CoverNow> => {
      if (status.targetPrimary !== status.currentPrimary) status.currentPrimary = status.targetPrimary;
      return here(status.currentPrimary === 'system-db-2' ? primary('system-db-2', ['system-db-3']) : replica('system-db-2', ['system-db-3']));
    });
    await movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], { coverOf, ...time });
    expect(events.slice(0, 4)).toEqual(['switchover to system-db-3', 'delete pvc system-db-2', 'delete pvc system-db-2-wal', 'delete pod system-db-2']);
  });

  it('a switchover CNPG already started is waited for, not asked again', async () => {
    const { k8s, custom, core, status } = makeCluster({ currentPrimary: 'system-db-2', targetPrimary: 'system-db-1' });
    const time = fakeTime();
    let passes = 0;
    const coverOf = async (): Promise<CoverNow> => {
      passes += 1;
      if (passes === 3) status.currentPrimary = 'system-db-1';
      return here(passes < 3 ? primary('system-db-2', ['system-db-1']) : replica('system-db-2'));
    };
    await movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], { coverOf, ...time });
    expect(custom.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
    expect(core.deleteNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it('a replica that reads as covered is still not touched while CNPG names it the primary', async () => {
    const { k8s, core } = makeCluster({ currentPrimary: 'system-db-2' });
    const time = fakeTime();
    // Pod labels lag the cluster status: the cover check calls it a replica.
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(replica('system-db-2')), switchoverWaitMs: 20_000, ...time,
    })).rejects.toMatchObject({ code: 'NODE_DELETE_DATABASE_MOVE_STALLED' });
    expect(core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('never deletes while nothing else holds the data — it stops when the wait runs out, the copy untouched', async () => {
    const { k8s, core } = makeCluster({});
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(replica('system-db-2', [])), switchoverWaitMs: 30_000, ...time,
    })).rejects.toMatchObject({
      code: 'NODE_DELETE_DATABASE_MOVE_STALLED', status: 409,
      details: { node_name: 's2', instance: 'platform/system-db-2' },
      message: expect.stringContaining('no primary on another server holds its data right now'),
    });
    expect(core.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('never deletes while the cluster is not whole — another instance down would leave the primary alone with the data', async () => {
    const { k8s, core } = makeCluster({
      pods: { 'system-db-1': { node: 's1' }, 'system-db-2': { node: 's2' }, 'system-db-3': { node: 's3', ready: false } },
    });
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(replica('system-db-2')), switchoverWaitMs: 30_000, ...time,
    })).rejects.toMatchObject({
      message: expect.stringContaining('2/3 instances Ready — an instance is down or still being re-created'),
    });
    expect(core.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('nor switches a primary over while the cluster is not whole', async () => {
    const { k8s, custom } = makeCluster({
      currentPrimary: 'system-db-2',
      pods: { 'system-db-1': { node: 's1', ready: false }, 'system-db-2': { node: 's2' }, 'system-db-3': { node: 's3' } },
    });
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(primary('system-db-2', ['system-db-3'])), switchoverWaitMs: 30_000, ...time,
    })).rejects.toMatchObject({ code: 'NODE_DELETE_DATABASE_MOVE_STALLED' });
    expect(custom.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled();
  });

  // Delete pressed again after a stall during a re-creation: the first
  // instance reads as moved (its copy here is gone), the second must wait
  // until the first is Ready again — never two re-created at once.
  it('resumed with a re-creation still running: the next instance waits until the cluster is whole', async () => {
    const { k8s, events } = makeCluster({
      pods: {
        'system-db-1': { node: 's1' },
        'system-db-2': { node: 's3', ready: false, readyAfterPolls: 4 }, // being re-created
        'system-db-3': { node: 's2' },
      },
    });
    const time = fakeTime();
    const coverOf = async (r: InstanceRef): Promise<CoverNow> => (r.instance === 'system-db-2' ? 'moved' : here(replica('system-db-3')));
    const moved = await movePostgresInstancesOff(k8s, 's2', [ref('system-db-2'), ref('system-db-3')], { coverOf, ...time });
    expect(moved).toEqual(['platform/system-db-3']);
    expect(events.indexOf('system-db-2 ready on s3')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('system-db-2 ready on s3')).toBeLessThan(events.indexOf('delete pvc system-db-3'));
  });

  it('an unreadable state is waited out the same way — never read as "covered"', async () => {
    const { k8s, core } = makeCluster({});
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => { throw new Error('Longhorn list timed out'); }, switchoverWaitMs: 10_000, ...time,
    })).rejects.toMatchObject({ code: 'NODE_DELETE_DATABASE_MOVE_STALLED' });
    expect(core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('a primary that did not become a replica in time stops the delete, its copy untouched', async () => {
    const { k8s, core } = makeCluster({ currentPrimary: 'system-db-2' });
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(primary('system-db-2', ['system-db-3'])), switchoverWaitMs: 20_000, ...time,
    })).rejects.toMatchObject({ message: expect.stringContaining('it is still the primary (a switchover to system-db-3 is under way)') });
    expect(core.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('a refused switchover request is said as such — with the node cordoned and nothing touched', async () => {
    const { k8s, core } = makeCluster({ currentPrimary: 'system-db-2', switchoverFails: 403 });
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(primary('system-db-2', ['system-db-3'])), ...time,
    })).rejects.toMatchObject({
      code: 'NODE_DELETE_DATABASE_MOVE_STALLED',
      message: expect.stringContaining('Asking PostgreSQL to switch platform/system-db-2 over to system-db-3 failed (clusters.postgresql.cnpg.io "system-db" is forbidden)'),
    });
    expect(core.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('a failover toward the instance right before the delete keeps its data', async () => {
    const { k8s, core } = makeCluster({ failoverOnRead: 2 });
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(replica('system-db-2')), ...time,
    })).rejects.toMatchObject({ code: 'NODE_DELETE_DATABASE_MOVE_STALLED', message: expect.stringContaining('became the primary again') });
    expect(core.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('nothing to move once its only copy is no longer here', async () => {
    const { k8s, core } = makeCluster({});
    const time = fakeTime();
    expect(await movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], { coverOf: async () => 'moved', ...time })).toEqual([]);
    expect(core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it('a re-creation that does not finish stops the delete — said as what it is, with the leftover to tick', async () => {
    const { k8s } = makeCluster({ neverReady: true });
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(replica('system-db-2')), rebuildWaitMs: 120_000, ...time,
    })).rejects.toMatchObject({
      code: 'NODE_DELETE_DATABASE_MOVE_STALLED',
      message: expect.stringMatching(/re-creating it on another server from the primary, which has not finished within 2 min \(the cluster reads "Creating a new replica", 2\/3 instances Ready.*Delete lists it, to be ticked away with the node/),
    });
  });

  it('an instance re-created on the node being removed is not moved', async () => {
    const { k8s } = makeCluster({ rebuiltOn: 's2' });
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(replica('system-db-2')), rebuildWaitMs: 60_000, ...time,
    })).rejects.toMatchObject({ code: 'NODE_DELETE_DATABASE_MOVE_STALLED' });
  });

  it('an old claim still there (Terminating) is not moved yet, though the cluster reads whole', async () => {
    const { k8s } = makeCluster({ claimsLinger: true });
    const time = fakeTime();
    await expect(movePostgresInstancesOff(k8s, 's2', [ref('system-db-2')], {
      coverOf: async () => here(replica('system-db-2')), rebuildWaitMs: 60_000, ...time,
    })).rejects.toMatchObject({ code: 'NODE_DELETE_DATABASE_MOVE_STALLED' });
  });

  it('two instances on one node move one at a time: the second starts once the first is Ready elsewhere', async () => {
    const { k8s, events } = makeCluster({
      pods: { 'system-db-1': { node: 's1' }, 'system-db-2': { node: 's2' }, 'system-db-3': { node: 's2' } },
      rebuildPolls: 3,
    });
    const time = fakeTime();
    const coverOf = async (r: InstanceRef): Promise<CoverNow> => here(replica(r.instance));
    expect(await movePostgresInstancesOff(k8s, 's2', [ref('system-db-2'), ref('system-db-3')], { coverOf, ...time }))
      .toEqual(['platform/system-db-2', 'platform/system-db-3']);
    expect(events.indexOf('system-db-2 ready on s3')).toBeLessThan(events.indexOf('delete pvc system-db-3'));
    expect(events.indexOf('system-db-2 ready on s3')).toBeGreaterThan(events.indexOf('delete pod system-db-2'));
  });
});
