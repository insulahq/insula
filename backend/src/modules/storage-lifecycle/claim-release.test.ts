import { describe, expect, it } from 'vitest';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { claimBeingDeleted, claimHolders, deleteClaimAndWait, describeHolders } from './claim-release.js';

/**
 * A deleted claim goes only once no scheduled pod names it — finished pods
 * included, as Kubernetes' claim protection has it. The fake below does the
 * same: that is what kept an archive's claim "terminating" for the ten minutes
 * a backup's finished Job pod lives.
 */

const NS = 'tenant-acme';
const CLAIM = `${NS}-storage`;
const notFound = (): Error => Object.assign(new Error('not found'), { code: 404 });

interface FakePod { name: string; phase: string; claims: string[]; nodeName?: string }

interface Cluster {
  claim: 'there' | 'deleting' | 'gone';
  pods: FakePod[];
  deletedPods: string[];
  /** Pods whose phase changes after this many claim reads: a Job finishing meanwhile. */
  finishesAfter?: { pod: string; reads: number };
  /** Made again, once, by the read after it went: the namespace sweep repairing a "missing" volume. */
  recreatedOnce?: boolean;
  deletes?: number;
}

function cluster(over: Partial<Cluster> = {}): Cluster {
  return { claim: 'there', pods: [], deletedPods: [], ...over };
}

function k8s(c: Cluster): K8sClients {
  let reads = 0;
  const holds = (): boolean => c.pods.some((p) => p.nodeName !== '' && p.claims.includes(CLAIM));
  const settle = (): void => { if (c.claim === 'deleting' && !holds()) c.claim = 'gone'; };
  return {
    core: {
      readNamespacedPersistentVolumeClaim: async () => {
        reads += 1;
        if (c.finishesAfter && reads >= c.finishesAfter.reads) {
          const p = c.pods.find((x) => x.name === c.finishesAfter?.pod);
          if (p) p.phase = 'Succeeded';
        }
        settle();
        if (c.claim === 'gone' && c.recreatedOnce) { c.recreatedOnce = false; c.claim = 'there'; }
        if (c.claim === 'gone') throw notFound();
        return { metadata: { name: CLAIM, ...(c.claim === 'deleting' ? { deletionTimestamp: '2026-10-27T21:13:28Z' } : {}) } };
      },
      deleteNamespacedPersistentVolumeClaim: async () => {
        c.deletes = (c.deletes ?? 0) + 1;
        if (c.claim === 'gone') throw notFound();
        c.claim = 'deleting';
        settle();
      },
      listNamespacedPod: async () => ({
        items: c.pods.map((p) => ({
          metadata: { name: p.name },
          spec: { nodeName: p.nodeName ?? 'node-1', volumes: p.claims.map((claimName) => ({ persistentVolumeClaim: { claimName } })) },
          status: { phase: p.phase },
        })),
      }),
      deleteNamespacedPod: async ({ name }: { name: string }) => {
        if (!c.pods.some((p) => p.name === name)) throw notFound();
        c.pods = c.pods.filter((p) => p.name !== name);
        c.deletedPods.push(name);
      },
    },
  } as unknown as K8sClients;
}

/** A clock the waits advance, so a timeout takes no real time. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

const backupPod = (phase: string): FakePod => ({ name: 'bk-files-bkp-1-abcde', phase, claims: [CLAIM] });

describe('claimHolders', () => {
  it('tells the finished pods that name the claim from the ones that have not finished, and ignores the rest', async () => {
    const c = cluster({
      pods: [
        backupPod('Succeeded'),
        { name: 'bk-files-bkp-0-failed', phase: 'Failed', claims: [CLAIM] },
        { name: 'web-1', phase: 'Running', claims: [CLAIM] },
        { name: 'web-2', phase: 'Pending', claims: [CLAIM] },
        { name: 'other', phase: 'Succeeded', claims: ['tenant-acme-other'] },
        // Not placed: it holds nothing, but is named all the same — the report errs towards saying more.
        { name: 'web-unplaced', phase: 'Pending', claims: [CLAIM], nodeName: '' },
      ],
    });
    expect(await claimHolders(k8s(c), NS, CLAIM)).toEqual({
      finished: ['bk-files-bkp-1-abcde', 'bk-files-bkp-0-failed'],
      live: ['web-1', 'web-2', 'web-unplaced'],
    });
  });
});

describe('deleteClaimAndWait', () => {
  it('a backup\'s finished Job pod no longer holds the claim: it is removed, and the claim goes', async () => {
    const c = cluster({ pods: [backupPod('Succeeded')] });
    const out = await deleteClaimAndWait(k8s(c), NS, CLAIM, clock());
    expect(out).toEqual({ gone: true, live: [] });
    expect(c.deletedPods).toEqual(['bk-files-bkp-1-abcde']);
    expect(c.claim).toBe('gone');
  });

  it('without that, the same claim stays terminating (the fake models claim protection)', async () => {
    const c = cluster({ pods: [backupPod('Succeeded')] });
    const fake = k8s(c);
    await fake.core.deleteNamespacedPersistentVolumeClaim({ name: CLAIM, namespace: NS });
    expect(await claimBeingDeleted(fake, NS, CLAIM)).toBe(true);
  });

  it('a pod that has not finished is never touched: the wait ends, saying which pod still uses the claim', async () => {
    const c = cluster({ pods: [{ name: 'debug-shell', phase: 'Running', claims: [CLAIM] }] });
    const out = await deleteClaimAndWait(k8s(c), NS, CLAIM, { ...clock(), timeoutMs: 10_000 });
    expect(out).toEqual({ gone: false, live: ['debug-shell'] });
    expect(c.deletedPods).toEqual([]);
    expect(describeHolders(out.live)).toBe('still used by debug-shell');
  });

  it('a Job that finishes during the wait: its pod is removed then, and the claim goes', async () => {
    const c = cluster({ pods: [backupPod('Running')], finishesAfter: { pod: 'bk-files-bkp-1-abcde', reads: 3 } });
    const out = await deleteClaimAndWait(k8s(c), NS, CLAIM, { ...clock(), timeoutMs: 60_000 });
    expect(out.gone).toBe(true);
    expect(c.deletedPods).toEqual(['bk-files-bkp-1-abcde']);
  });

  it('a claim made again while it waits — the namespace sweep repairing a "missing" volume — is deleted too', async () => {
    const c = cluster({ recreatedOnce: true });
    const out = await deleteClaimAndWait(k8s(c), NS, CLAIM, clock());
    expect(out.gone).toBe(true);
    expect(c.deletes).toBe(2);
  });

  it('a claim that is already gone is gone', async () => {
    const c = cluster({ claim: 'gone' });
    expect(await deleteClaimAndWait(k8s(c), NS, CLAIM, clock())).toEqual({ gone: true, live: [] });
  });

  it('a pod that was never placed does not hold the claim, and is not removed', async () => {
    const c = cluster({ pods: [{ name: 'web-pending', phase: 'Pending', claims: [CLAIM], nodeName: '' }] });
    const out = await deleteClaimAndWait(k8s(c), NS, CLAIM, clock());
    expect(out.gone).toBe(true);
    expect(c.deletedPods).toEqual([]);
  });
});

describe('claimBeingDeleted', () => {
  it('true only for a claim that is there with a deletion time', async () => {
    expect(await claimBeingDeleted(k8s(cluster({ claim: 'deleting', pods: [backupPod('Succeeded')] })), NS, CLAIM)).toBe(true);
    expect(await claimBeingDeleted(k8s(cluster()), NS, CLAIM)).toBe(false);
    expect(await claimBeingDeleted(k8s(cluster({ claim: 'gone' })), NS, CLAIM)).toBe(false);
  });
});

describe('describeHolders', () => {
  it('says so when no pod holds it', () => {
    expect(describeHolders([])).toBe('still held, though no pod in the namespace uses it');
  });
});
