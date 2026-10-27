import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { inspectArchivedVolume, MIN_CLAIM_AGE_MS, removeUnusedVolume } from './archived-volume.js';

/**
 * Which storage volume on an archived tenant may be removed. Removing one
 * cannot be undone, so every case that is not "provably never written to"
 * must come out as kept — each condition is taken away in turn below.
 */

const NS = 'tenant-acme';
const CLAIM = `${NS}-storage`;
const ARCHIVED_AT = new Date('2026-06-01T10:00:00.000Z');
const AFTER = new Date('2026-06-01T10:20:00.000Z');

const notFound = (): Error => Object.assign(new Error('not found'), { code: 404 });

interface Cluster {
  /** null: no claim. */
  claim: { created?: Date | string; volume?: string; deleting?: boolean } | null;
  pods: Array<{ claims: string[] }>;
  pv: { driver?: string; handle?: string } | null;
  longhorn: { state?: string; actualSize?: number | string; lastPodRefAt?: string } | null | 'unreadable';
  deleted: string[];
  /** How many reads of the claim still find it after it was deleted. */
  lingers?: number;
  failOn?: 'pods' | 'pv';
}

/** A volume the archive sweep's earlier release left behind: bound, never mounted, zero bytes. */
function stray(over: Partial<Cluster> = {}): Cluster {
  return {
    claim: { created: AFTER, volume: 'pvc-123' },
    pods: [],
    pv: { driver: 'driver.longhorn.io', handle: 'pvc-123' },
    longhorn: { state: 'detached', actualSize: 0, lastPodRefAt: '' },
    deleted: [],
    ...over,
  };
}

function k8s(c: Cluster): K8sClients {
  let claimGone = false;
  let lingering = c.lingers ?? 0;
  return {
    core: {
      readNamespacedPersistentVolumeClaim: async () => {
        if (!c.claim) throw notFound();
        if (claimGone) {
          if (lingering > 0) { lingering -= 1; } else { throw notFound(); }
        }
        return {
          metadata: { creationTimestamp: c.claim.created, ...(c.claim.deleting ? { deletionTimestamp: AFTER } : {}) },
          spec: { volumeName: c.claim.volume },
        };
      },
      listNamespacedPod: async () => {
        if (c.failOn === 'pods') throw new Error('the API server did not answer');
        return { items: c.pods.map((p) => ({ spec: { volumes: p.claims.map((claimName) => ({ persistentVolumeClaim: { claimName } })) } })) };
      },
      readPersistentVolume: async () => {
        if (c.failOn === 'pv') throw new Error('the API server did not answer');
        if (!c.pv) throw notFound();
        return { spec: { csi: { driver: c.pv.driver, volumeHandle: c.pv.handle } } };
      },
      deleteNamespacedPersistentVolumeClaim: async ({ name }: { name: string }) => {
        if (!c.claim || claimGone) throw notFound();
        claimGone = true;
        c.deleted.push(`claim ${name}`);
      },
      deletePersistentVolume: async ({ name }: { name: string }) => { c.deleted.push(`pv ${name}`); },
    },
    custom: {
      getNamespacedCustomObject: async () => {
        if (c.longhorn === 'unreadable') throw new Error('longhorn did not answer');
        if (!c.longhorn) throw notFound();
        return { status: { state: c.longhorn.state, actualSize: c.longhorn.actualSize, kubernetesStatus: { lastPodRefAt: c.longhorn.lastPodRefAt } } };
      },
      deleteNamespacedCustomObject: async ({ name }: { name: string }) => { c.deleted.push(`longhorn ${name}`); },
    },
  } as unknown as K8sClients;
}

/** Looked at a day after the claim was made — unless a case says when. */
const LOOKED_AT = AFTER.getTime() + 24 * 60 * 60 * 1000;
const inspect = (c: Cluster, archivedAt: Date | null = ARCHIVED_AT, nowMs: number = LOOKED_AT) => inspectArchivedVolume(k8s(c), NS, archivedAt, nowMs);

describe('a storage volume on an archived tenant', () => {
  it('is absent when the tenant has no claim — the state an archive leaves', async () => {
    expect(await inspect(stray({ claim: null }))).toEqual({ kind: 'absent' });
  });

  it('is releasing when the claim is being deleted — the archive\'s own, older than the archive, still held by a pod that names it', async () => {
    const c = stray({ claim: { created: new Date('2026-05-01T00:00:00.000Z'), volume: 'pvc-old', deleting: true }, pods: [{ claims: [CLAIM] }] });
    expect(await inspect(c)).toEqual({ kind: 'releasing' });
    expect(c.deleted).toEqual([]);
  });

  it('is unused when it was created after the archive, no pod uses it, and Longhorn holds zero bytes for it', async () => {
    expect(await inspect(stray())).toEqual({ kind: 'unused', pv: 'pvc-123', longhornVolume: 'pvc-123' });
  });

  it('names the PersistentVolume and the Longhorn volume apart when they differ — a volume provisioned by hand', async () => {
    const c = stray({ claim: { created: AFTER, volume: 'static-pv' }, pv: { driver: 'driver.longhorn.io', handle: 'lh-vol-7' } });
    expect(await inspect(c)).toEqual({ kind: 'unused', pv: 'static-pv', longhornVolume: 'lh-vol-7' });
  });

  it('does not judge a claim made within the last hour: whatever made it may be about to fill it', async () => {
    const madeAt = AFTER.getTime();
    for (const age of [0, 60_000, MIN_CLAIM_AGE_MS]) {
      const found = await inspect(stray(), ARCHIVED_AT, madeAt + age);
      expect(found, `${age} ms old`).toEqual({ kind: 'kept', why: 'the volume is less than an hour old' });
    }
    expect((await inspect(stray(), ARCHIVED_AT, madeAt + MIN_CLAIM_AGE_MS + 1)).kind).toBe('unused');
  });

  it('is unused when the claim never got a volume at all', async () => {
    expect(await inspect(stray({ claim: { created: AFTER }, pv: null, longhorn: null }))).toEqual({ kind: 'unused', pv: null, longhornVolume: null });
  });

  it('reads the size Longhorn reports as a string like the one it reports as a number', async () => {
    expect((await inspect(stray({ longhorn: { state: 'detached', actualSize: '0', lastPodRefAt: '' } }))).kind).toBe('unused');
    expect((await inspect(stray({ longhorn: { state: 'detached', actualSize: '4096', lastPodRefAt: '' } }))).kind).toBe('kept');
  });

  it.each<[string, Partial<Cluster>, Date | null, string]>([
    ['the tenant has no archive date', {}, null, 'no recorded archive date'],
    ['the volume was created before the archive', { claim: { created: new Date('2026-05-01T00:00:00Z'), volume: 'pvc-123' } }, ARCHIVED_AT, 'older than the archive'],
    ['the volume was created at the very moment of the archive', { claim: { created: ARCHIVED_AT, volume: 'pvc-123' } }, ARCHIVED_AT, 'older than the archive'],
    ['the claim carries no creation time', { claim: { volume: 'pvc-123' } }, ARCHIVED_AT, 'older than the archive'],
    ['a pod uses the claim', { pods: [{ claims: ['other'] }, { claims: [CLAIM] }] }, ARCHIVED_AT, 'a pod uses the volume'],
    ['the volume is on another storage driver', { pv: { driver: 'rancher.io/local-path' } }, ARCHIVED_AT, 'not a Longhorn volume'],
    ['the volume object is gone', { pv: null }, ARCHIVED_AT, 'not a Longhorn volume'],
    ['Longhorn does not know the volume', { longhorn: null }, ARCHIVED_AT, 'could not be read'],
    ['the volume is attached', { longhorn: { state: 'attached', actualSize: 0, lastPodRefAt: '' } }, ARCHIVED_AT, 'is attached'],
    ['a pod has mounted it at some time', { longhorn: { state: 'detached', actualSize: 0, lastPodRefAt: '2026-06-02T00:00:00Z' } }, ARCHIVED_AT, 'a pod has mounted'],
    ['a single block was ever written', { longhorn: { state: 'detached', actualSize: 4096, lastPodRefAt: '' } }, ARCHIVED_AT, 'has been written to'],
    ['Longhorn reports no size', { longhorn: { state: 'detached', lastPodRefAt: '' } }, ARCHIVED_AT, 'has been written to'],
    ['Longhorn reports an empty size', { longhorn: { state: 'detached', actualSize: '', lastPodRefAt: '' } }, ARCHIVED_AT, 'has been written to'],
    ['Longhorn reports a size that is no number', { longhorn: { state: 'detached', actualSize: 'n/a', lastPodRefAt: '' } }, ARCHIVED_AT, 'has been written to'],
  ])('is kept when %s', async (_what, over, archivedAt, why) => {
    const found = await inspect(stray(over), archivedAt);
    expect(found.kind).toBe('kept');
    if (found.kind === 'kept') expect(found.why).toContain(why);
  });

  it('does not guess when the cluster cannot be read: the error is the answer', async () => {
    await expect(inspect(stray({ failOn: 'pods' }))).rejects.toThrow('the API server did not answer');
    await expect(inspect(stray({ failOn: 'pv' }))).rejects.toThrow('the API server did not answer');
    await expect(inspect(stray({ longhorn: 'unreadable' }))).rejects.toThrow('longhorn did not answer');
  });

  it('compares a creation time given as text like one given as a date', async () => {
    expect((await inspect(stray({ claim: { created: '2026-06-01T10:20:00Z', volume: 'pvc-123' } }))).kind).toBe('unused');
    expect((await inspect(stray({ claim: { created: '2026-06-01T09:59:59Z', volume: 'pvc-123' } }))).kind).toBe('kept');
  });
});

describe('removing an unused volume', () => {
  it('deletes the claim, waits until it is gone, then the volume behind it — in that order', async () => {
    const c = stray({ lingers: 2 });
    await removeUnusedVolume(k8s(c), NS, { pv: 'pvc-123', longhornVolume: 'pvc-123' }, { pollMs: 1 });
    expect(c.deleted).toEqual([`claim ${CLAIM}`, 'pv pvc-123', 'longhorn pvc-123']);
  });

  it('deletes each by its own name when the two differ', async () => {
    const c = stray();
    await removeUnusedVolume(k8s(c), NS, { pv: 'static-pv', longhornVolume: 'lh-vol-7' }, { pollMs: 1 });
    expect(c.deleted).toEqual([`claim ${CLAIM}`, 'pv static-pv', 'longhorn lh-vol-7']);
  });

  it('deletes only the claim when it had no volume', async () => {
    const c = stray();
    await removeUnusedVolume(k8s(c), NS, { pv: null, longhornVolume: null }, { pollMs: 1 });
    expect(c.deleted).toEqual([`claim ${CLAIM}`]);
  });

  it('is content with a claim that is gone already', async () => {
    const c = stray({ claim: null });
    await removeUnusedVolume(k8s(c), NS, { pv: null, longhornVolume: null }, { pollMs: 1 });
    expect(c.deleted).toEqual([]);
  });

  it('does not touch the volume while the claim will not go, and says so', async () => {
    const c = stray({ lingers: 1_000_000 });
    await expect(removeUnusedVolume(k8s(c), NS, { pv: 'pvc-123', longhornVolume: 'pvc-123' }, { timeoutMs: 20, pollMs: 2 })).rejects.toThrow(/was still there/);
    expect(c.deleted).toEqual([`claim ${CLAIM}`]);
  });
});
