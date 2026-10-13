import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  checkTargetCapacity,
  diskRefusal,
  judgeTargetCapacity,
  nodeDisks,
  parseIntSetting,
  schedulableBytes,
  type DiskCapacity,
  type SchedulingSettings,
  type VolumeNeed,
} from './target-capacity.js';

const GIB = 2 ** 30;
const SETTINGS: SchedulingSettings = { overProvisioningPct: 100, minimalAvailablePct: 15 };

/** The two disks of the production case, in GiB. */
const small: DiskCapacity = { name: 'default', maximum: 150 * GIB, available: 128 * GIB, scheduled: 39 * GIB, reserved: 45 * GIB };
const large: DiskCapacity = { name: 'default', maximum: 314 * GIB, available: 233 * GIB, scheduled: 62 * GIB, reserved: 51 * GIB };
/** 100 GiB volume holding 28 GiB. */
const volume: VolumeNeed = { volumeName: 'pvc-1', size: 100 * GIB, actualSize: 28 * GIB };

describe('diskRefusal — Longhorn\'s IsSchedulableToDisk', () => {
  it('refuses the production move: 100 GiB onto a disk with 66 GiB left to schedule, though only 28 GiB is in use', () => {
    expect(schedulableBytes(small, SETTINGS)).toBe(66 * GIB);
    expect(diskRefusal(volume, small, SETTINGS)).toBe('over-provisioned');
  });

  it('accepts the same volume on the disk that has the room', () => {
    expect(schedulableBytes(large, SETTINGS)).toBe(201 * GIB);
    expect(diskRefusal(volume, large, SETTINGS)).toBeNull();
  });

  it('counts the FULL size against the schedule: exactly fitting is accepted, one byte over is not', () => {
    expect(diskRefusal({ ...volume, size: 66 * GIB }, small, SETTINGS)).toBeNull();
    expect(diskRefusal({ ...volume, size: 66 * GIB + 1 }, small, SETTINGS)).toBe('over-provisioned');
  });

  it('honours the over-provisioning setting', () => {
    // (150 − 45) × 200 % − 39 = 171 GiB.
    expect(diskRefusal(volume, small, { ...SETTINGS, overProvisioningPct: 200 })).toBeNull();
  });

  it('refuses a copy that would leave the disk at or under the free-space floor', () => {
    // Floor = 15 % of 150 = 22.5 GiB. 50 − 28 = 22 GiB left: under it.
    const tight = { ...small, available: 50 * GIB, scheduled: 0 };
    expect(diskRefusal({ ...volume, size: 30 * GIB }, tight, SETTINGS)).toBe('disk-full');
    // 51 − 28 = 23 GiB left: over it.
    expect(diskRefusal({ ...volume, size: 30 * GIB }, { ...tight, available: 51 * GIB }, SETTINGS)).toBeNull();
    // Exactly AT the floor is refused — Longhorn's comparison is strict.
    expect(diskRefusal({ ...volume, size: 30 * GIB, actualSize: 27.5 * GIB }, tight, SETTINGS)).toBe('disk-full');
  });

  it('judges the copy by what the volume HOLDS, not by its size', () => {
    // A 100 GiB volume holding 1 GiB does not trip the free-space floor on a
    // disk with 40 GiB free; it is the schedule clause that decides.
    const disk = { ...small, available: 40 * GIB, scheduled: 0 };
    expect(diskRefusal({ ...volume, actualSize: 1 * GIB }, disk, SETTINGS)).toBeNull();
  });

  it('refuses a disk that reports no capacity or no free space', () => {
    expect(diskRefusal(volume, { ...large, maximum: 0 }, SETTINGS)).toBe('disk-full');
    expect(diskRefusal(volume, { ...large, available: 0 }, SETTINGS)).toBe('disk-full');
  });
});

describe('judgeTargetCapacity', () => {
  it('is ok when nothing has to be placed', () => {
    expect(judgeTargetCapacity('node-a', [], [], SETTINGS)).toEqual({ state: 'ok' });
  });

  it('is ok when the volume fits', () => {
    expect(judgeTargetCapacity('node-a', [volume], [large], SETTINGS)).toEqual({ state: 'ok' });
  });

  it('says what does not fit, by how much, why, and what to do', () => {
    const v = judgeTargetCapacity('node-a', [volume], [small], SETTINGS);
    expect(v).toMatchObject({ state: 'insufficient', neededBytes: 100 * GIB, schedulableBytes: 66 * GIB });
    const detail = (v as { detail: string }).detail;
    expect(detail).toContain('node-a cannot hold this tenant\'s 100.0 GiB volume');
    expect(detail).toContain('66.0 GiB left to schedule');
    expect(detail).toContain('full size, not what is in use (28.0 GiB here)');
    expect(detail).toContain('shrink the volume');
  });

  it('words a full disk differently from an over-committed one', () => {
    const tight = { ...large, available: 40 * GIB };
    const v = judgeTargetCapacity('node-a', [volume], [tight], SETTINGS);
    expect(v.state).toBe('insufficient');
    expect((v as { detail: string }).detail).toContain('free-space floor (15% of the disk)');
    expect((v as { detail: string }).detail).not.toContain('shrink');
  });

  it('charges each placement to its disk: two volumes cannot both be promised the same room', () => {
    const fortyGiB = { volumeName: 'pvc-2', size: 40 * GIB, actualSize: 1 * GIB };
    // 66 GiB to schedule: one 40 GiB volume fits, two do not.
    expect(judgeTargetCapacity('node-a', [fortyGiB], [small], SETTINGS).state).toBe('ok');
    const v = judgeTargetCapacity('node-a', [fortyGiB, { ...fortyGiB, volumeName: 'pvc-3' }], [small], SETTINGS);
    expect(v).toMatchObject({ state: 'insufficient', neededBytes: 80 * GIB, schedulableBytes: 26 * GIB });
    expect((v as { detail: string }).detail).toContain('one of this tenant\'s volumes (40.0 GiB)');
  });

  it('uses a second disk when the first is taken', () => {
    const fortyGiB = { volumeName: 'pvc-2', size: 40 * GIB, actualSize: 1 * GIB };
    const v = judgeTargetCapacity('node-a', [fortyGiB, { ...fortyGiB, volumeName: 'pvc-3' }], [small, { ...small, name: 'second' }], SETTINGS);
    expect(v).toEqual({ state: 'ok' });
  });

  it('does not turn "no disk to judge" into a refusal', () => {
    expect(judgeTargetCapacity('node-a', [volume], [], SETTINGS).state).toBe('unknown');
  });

  it('never reports negative room on an over-committed disk', () => {
    const over = { ...small, scheduled: 200 * GIB };
    expect(judgeTargetCapacity('node-a', [volume], [over], SETTINGS)).toMatchObject({ state: 'insufficient', schedulableBytes: 0 });
  });
});

describe('parseIntSetting', () => {
  it('reads a plain number and a per-data-engine value', () => {
    expect(parseIntSetting('s', '100')).toBe(100);
    expect(parseIntSetting('s', ' 15 ')).toBe(15);
    expect(parseIntSetting('s', '{"v1":"200","v2":"100"}')).toBe(200);
    expect(parseIntSetting('s', 0)).toBe(0);
  });

  it('throws rather than guess when the value is not a number', () => {
    for (const bad of [undefined, null, '', 'abc', '-5', '1.5', '{"v2":"100"}', '{broken']) {
      expect(() => parseIntSetting('storage-over-provisioning-percentage', bad)).toThrow(/storage-over-provisioning-percentage is not a number/);
    }
  });
});

describe('nodeDisks — off is a decision, not-ready is not', () => {
  const diskStatus = { storageMaximum: 150 * GIB, storageAvailable: 128 * GIB, storageScheduled: 39 * GIB };
  const node = (
    spec: Record<string, unknown>,
    status: Record<string, unknown> = diskStatus,
    nodeSpec: Record<string, unknown> = {},
    nodeConditions: Array<{ type: string; status: string }> = [],
  ) => ({
    spec: { ...nodeSpec, disks: { d1: { storageReserved: 45 * GIB, ...spec } } },
    status: { conditions: nodeConditions, diskStatus: { d1: status } },
  });

  it('reads a schedulable disk in bytes', () => {
    expect(nodeDisks(node({ allowScheduling: true }))).toEqual({ state: 'ready', disks: [{ ...small, name: 'd1' }] });
    const healthy = [{ type: 'Ready', status: 'True' }, { type: 'Schedulable', status: 'True' }];
    expect(nodeDisks(node({}, { ...diskStatus, conditions: healthy }, {}, healthy)).state).toBe('ready');
  });

  it('is OFF when the operator has told Longhorn not to place data there', () => {
    expect(nodeDisks(node({}, diskStatus, { allowScheduling: false }))).toEqual({ state: 'off' });
    expect(nodeDisks(node({}, diskStatus, {}, [{ type: 'Schedulable', status: 'False' }]))).toEqual({ state: 'off' });
    expect(nodeDisks(node({ allowScheduling: false }))).toEqual({ state: 'off' });
    expect(nodeDisks(node({ evictionRequested: true }))).toEqual({ state: 'off' });
  });

  it('is NOT READY — never off — for a node that has only just joined or whose disk is briefly gone', () => {
    // A fresh Longhorn node: the object exists, its disk status does not yet.
    expect(nodeDisks({ spec: { disks: {} }, status: {} }).state).toBe('not-ready');
    expect(nodeDisks({ spec: { disks: { d1: { storageReserved: 0 } } }, status: { diskStatus: {} } }).state).toBe('not-ready');
    expect(nodeDisks({}).state).toBe('not-ready');
    expect(nodeDisks(node({}, { ...diskStatus, conditions: [{ type: 'Ready', status: 'False' }] })).state).toBe('not-ready');
    expect(nodeDisks(node({}, diskStatus, {}, [{ type: 'Ready', status: 'False' }])).state).toBe('not-ready');
    // A disk the node reports but its spec does not list is not one to schedule onto.
    expect(nodeDisks({ spec: { disks: {} }, status: { diskStatus: { ghost: diskStatus } } }).state).toBe('not-ready');
  });

  it('one switched-off disk beside one that is not ready is still not a decision against the node', () => {
    const mixed = {
      spec: { disks: { off: { allowScheduling: false }, down: { storageReserved: 0 } } },
      status: { diskStatus: { off: diskStatus, down: { ...diskStatus, conditions: [{ type: 'Ready', status: 'False' }] } } },
    };
    expect(nodeDisks(mixed).state).toBe('not-ready');
  });

  it('keeps a disk under pressure in the list: its own numbers decide', () => {
    const pressed = nodeDisks(node({}, { ...diskStatus, storageAvailable: 10 * GIB, conditions: [{ type: 'Schedulable', status: 'False' }] }));
    expect(pressed.state).toBe('ready');
    const disks = (pressed as { disks: DiskCapacity[] }).disks;
    expect(diskRefusal({ ...volume, size: 1 * GIB, actualSize: 1 * GIB }, disks[0]!, SETTINGS)).toBe('disk-full');
  });

  it('uses the ready disk and ignores the one switched off', () => {
    const two = {
      spec: { disks: { off: { allowScheduling: false }, on: { storageReserved: 45 * GIB } } },
      status: { diskStatus: { off: diskStatus, on: diskStatus } },
    };
    expect(nodeDisks(two)).toEqual({ state: 'ready', disks: [{ ...small, name: 'on' }] });
  });
});

const NS = 'tenant-acme';

interface FakeCluster {
  volumes?: unknown[];
  replicas?: unknown[];
  node?: unknown | Error;
  settings?: Record<string, unknown | Error>;
}

function fakeK8s(c: FakeCluster): { k8s: K8sClients; reads: string[] } {
  const reads: string[] = [];
  const settings: Record<string, unknown | Error> = {
    'storage-over-provisioning-percentage': { value: '100' },
    'storage-minimal-available-percentage': { value: '15' },
    ...c.settings,
  };
  const k8s = {
    custom: {
      listNamespacedCustomObject: async ({ plural }: { plural: string }) => {
        reads.push(`list:${plural}`);
        return { items: plural === 'volumes' ? c.volumes ?? [] : c.replicas ?? [] };
      },
      getNamespacedCustomObject: async ({ plural, name }: { plural: string; name: string }) => {
        reads.push(`get:${plural}:${name}`);
        const got = plural === 'nodes' ? c.node : settings[name];
        if (got instanceof Error) throw got;
        return got;
      },
    },
  } as unknown as K8sClients;
  return { k8s, reads };
}

const lhVolume = (over: Record<string, unknown> = {}) => ({
  metadata: { name: 'pvc-1' },
  spec: { numberOfReplicas: 1, size: String(100 * GIB) },
  status: { actualSize: 28 * GIB, kubernetesStatus: { namespace: NS, lastPVCRefAt: '' } },
  ...over,
});
const lhReplica = (nodeID: string, over: Record<string, unknown> = {}) => ({
  spec: { volumeName: 'pvc-1', nodeID }, status: { currentState: 'running' }, ...over,
});
const lhNode = (disk: DiskCapacity) => ({
  spec: { allowScheduling: true, disks: { d1: { allowScheduling: true, storageReserved: disk.reserved } } },
  status: { diskStatus: { d1: { storageMaximum: disk.maximum, storageAvailable: disk.available, storageScheduled: disk.scheduled } } },
});

describe('checkTargetCapacity', () => {
  it('refuses the production move, reading the node it was asked about', async () => {
    const { k8s, reads } = fakeK8s({ volumes: [lhVolume()], replicas: [lhReplica('node-b')], node: lhNode(small) });
    const v = await checkTargetCapacity(k8s, NS, 'node-a', 'local');
    expect(v).toMatchObject({ state: 'insufficient', neededBytes: 100 * GIB, schedulableBytes: 66 * GIB });
    expect(reads).toContain('get:nodes:node-a');
  });

  it('accepts it on the node with room', async () => {
    const { k8s } = fakeK8s({ volumes: [lhVolume()], replicas: [lhReplica('node-b')], node: lhNode(large) });
    expect(await checkTargetCapacity(k8s, NS, 'node-a', 'local')).toEqual({ state: 'ok' });
  });

  it('needs no room when the data is already on the target, and reads nothing more', async () => {
    const { k8s, reads } = fakeK8s({ volumes: [lhVolume()], replicas: [lhReplica('node-a')], node: lhNode(small) });
    expect(await checkTargetCapacity(k8s, NS, 'node-a', 'local')).toEqual({ state: 'ok' });
    expect(reads.filter((r) => r.startsWith('get:'))).toEqual([]);
  });

  it('does not count a failed replica on the target as the data being there', async () => {
    for (const dead of [lhReplica('node-a', { spec: { volumeName: 'pvc-1', nodeID: 'node-a', failedAt: '2026-10-13T02:56:37Z' } }),
      lhReplica('node-a', { status: { currentState: 'error' } })]) {
      const { k8s } = fakeK8s({ volumes: [lhVolume()], replicas: [dead], node: lhNode(small) });
      expect((await checkTargetCapacity(k8s, NS, 'node-a', 'local')).state).toBe('insufficient');
    }
  });

  it('places nothing for the HA tier, a multi-replica volume, another tenant\'s volume or a leftover one', async () => {
    const { k8s: ha, reads } = fakeK8s({ volumes: [lhVolume()], node: lhNode(small) });
    expect(await checkTargetCapacity(ha, NS, 'node-a', 'ha')).toEqual({ state: 'ok' });
    expect(reads).toEqual([]);
    for (const vol of [
      lhVolume({ spec: { numberOfReplicas: 3, size: String(100 * GIB) } }),
      lhVolume({ status: { actualSize: 1, kubernetesStatus: { namespace: 'tenant-other' } } }),
      lhVolume({ status: { actualSize: 1, kubernetesStatus: { namespace: NS, lastPVCRefAt: '2026-09-01T00:00:00Z' } } }),
    ]) {
      const { k8s } = fakeK8s({ volumes: [vol], node: lhNode(small) });
      expect(await checkTargetCapacity(k8s, NS, 'node-a', 'local')).toEqual({ state: 'ok' });
    }
  });

  it('is unknown — never a refusal — when the node or a setting cannot be read', async () => {
    const base = { volumes: [lhVolume()], replicas: [lhReplica('node-b')] };
    for (const broken of [
      { ...base, node: new Error('nodes.longhorn.io "node-a" not found') },
      { ...base, node: lhNode(small), settings: { 'storage-over-provisioning-percentage': new Error('settings.longhorn.io is forbidden') } },
      { ...base, node: lhNode(small), settings: { 'storage-minimal-available-percentage': { value: 'abc' } } },
      { ...base, volumes: [lhVolume({ spec: { numberOfReplicas: 1 } })], node: lhNode(small) },
    ]) {
      const v = await checkTargetCapacity(fakeK8s(broken).k8s, NS, 'node-a', 'local');
      expect(v.state).toBe('unknown');
      expect((v as { detail: string }).detail).not.toBe('');
    }
  });

  it('refuses a node whose Longhorn scheduling the operator has switched off', async () => {
    const off = { ...lhNode(large), spec: { allowScheduling: false, disks: lhNode(large).spec.disks } };
    const { k8s } = fakeK8s({ volumes: [lhVolume()], replicas: [lhReplica('node-b')], node: off });
    const v = await checkTargetCapacity(k8s, NS, 'node-a', 'local');
    expect(v).toMatchObject({ state: 'insufficient', neededBytes: 100 * GIB, schedulableBytes: 0 });
    expect((v as { detail: string }).detail).toContain('scheduling is switched off');
  });

  it('does NOT refuse a freshly joined node that reports no disk yet — the evacuation target case', async () => {
    for (const fresh of [
      { spec: { allowScheduling: true, disks: {} }, status: {} },
      { ...lhNode(small), status: { conditions: [{ type: 'Ready', status: 'False' }], diskStatus: lhNode(small).status.diskStatus } },
    ]) {
      const { k8s } = fakeK8s({ volumes: [lhVolume()], replicas: [lhReplica('node-b')], node: fresh });
      const v = await checkTargetCapacity(k8s, NS, 'node-a', 'local');
      expect(v.state).toBe('unknown');
      expect((v as { detail: string }).detail).toMatch(/^node-a: /);
    }
  });

  it('uses the settings it read, not a default', async () => {
    const { k8s } = fakeK8s({
      volumes: [lhVolume()], replicas: [lhReplica('node-b')], node: lhNode(small),
      settings: { 'storage-over-provisioning-percentage': { value: '200' } },
    });
    expect(await checkTargetCapacity(k8s, NS, 'node-a', 'local')).toEqual({ state: 'ok' });
  });
});
