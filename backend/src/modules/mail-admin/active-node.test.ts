/**
 * One answer for "which node is the active mail node" — VM release
 * verification found the port-exposure validation refusing assignedMailNodes
 * ("no active mail node is set") while Stalwart ran on an assigned node,
 * because mail_active_node is NULL on a cluster installed on several nodes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { systemSettings } from '../../db/schema.js';
import {
  __resetActiveNodePersistForTest,
  deriveActiveNodeFromMailPvc,
  readLiveStalwartNode,
  resolveActiveMailNode,
} from './active-node.js';

function dbStub(stored: string | null) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: (t: unknown) => ({
        where: async () => (t === systemSettings ? [{ activeNode: stored }] : []),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => { updates.push(v); },
      }),
    }),
  };
  return { db: db as never, updates };
}

type Pod = { node?: string; phase?: string; terminating?: boolean };
function coreStub(pods: Pod[] | Error, pvc?: { selectedNode?: string; volumeName?: string; pvHost?: string } | Error) {
  return {
    listNamespacedPod: vi.fn(async () => {
      if (pods instanceof Error) throw pods;
      return {
        items: pods.map((p) => ({
          metadata: p.terminating ? { deletionTimestamp: new Date() } : {},
          spec: { nodeName: p.node },
          status: { phase: p.phase ?? 'Running' },
        })),
      };
    }),
    readNamespacedPersistentVolumeClaim: vi.fn(async () => {
      if (!pvc) throw Object.assign(new Error('nf'), { code: 404 });
      if (pvc instanceof Error) throw pvc;
      return {
        metadata: { annotations: pvc.selectedNode ? { 'volume.kubernetes.io/selected-node': pvc.selectedNode } : {} },
        spec: { volumeName: pvc.volumeName },
      };
    }),
    readPersistentVolume: vi.fn(async () => ({
      spec: { nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [
        { key: 'topology.kubernetes.io/zone', values: ['z1'] },
        { key: 'kubernetes.io/hostname', values: [pvc && !(pvc instanceof Error) ? pvc.pvHost : undefined] },
      ] }] } } },
    })),
  };
}

const KNOWN = new Set(['sv1', 'sv2', 'w1']);

beforeEach(() => __resetActiveNodePersistForTest());

describe('resolveActiveMailNode — order', () => {
  it('prefers the node a Running Stalwart pod is on, over a stale stored value', async () => {
    const { db } = dbStub('sv2');
    const r = await resolveActiveMailNode(db, coreStub([{ node: 'sv1' }]) as never, { knownNodes: KNOWN });
    expect(r).toEqual({ node: 'sv1', source: 'pod' });
  });

  it('ignores terminating and non-Running pods', async () => {
    const { db } = dbStub('sv2');
    const pods = [{ node: 'sv1', terminating: true }, { node: 'w1', phase: 'Pending' }];
    expect(await resolveActiveMailNode(db, coreStub(pods) as never, { knownNodes: KNOWN }))
      .toEqual({ node: 'sv2', source: 'settings' });
  });

  it('falls back to the mail PVC when nothing runs and nothing is stored (fresh multi-node install)', async () => {
    const { db } = dbStub(null);
    const r = await resolveActiveMailNode(db, coreStub([], { selectedNode: 'sv1' }) as never, { knownNodes: KNOWN });
    expect(r).toEqual({ node: 'sv1', source: 'pvc' });
  });

  it('reads the bound PV hostname when the PVC has no selected-node annotation', async () => {
    const core = coreStub([], { volumeName: 'pv-1', pvHost: 'w1' });
    expect(await deriveActiveNodeFromMailPvc(core as never)).toBe('w1');
  });

  it('skips a candidate that is not a node of this cluster', async () => {
    const { db } = dbStub('gone-node');
    const r = await resolveActiveMailNode(db, coreStub([{ node: 'old-node' }], { selectedNode: 'sv2' }) as never, { knownNodes: KNOWN });
    expect(r).toEqual({ node: 'sv2', source: 'pvc' });
  });

  it('answers null when no source knows', async () => {
    const { db } = dbStub(null);
    expect(await resolveActiveMailNode(db, coreStub([]) as never, { knownNodes: KNOWN }))
      .toEqual({ node: null, source: null });
  });

  it('a failed pod lookup falls back to the stored value and says so', async () => {
    const { db } = dbStub('sv2');
    const warn = vi.fn();
    const r = await resolveActiveMailNode(db, coreStub(new Error('forbidden')) as never, { knownNodes: KNOWN, logger: { warn } });
    expect(r).toEqual({ node: 'sv2', source: 'settings' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('forbidden'));
  });
});

describe('resolveActiveMailNode — persist', () => {
  it('writes a pod-derived node that differs from the stored one, once per debounce window', async () => {
    const { db, updates } = dbStub(null);
    const core = coreStub([{ node: 'sv1' }]);
    await resolveActiveMailNode(db, core as never, { knownNodes: KNOWN, persist: true });
    await resolveActiveMailNode(db, core as never, { knownNodes: KNOWN, persist: true });
    expect(updates).toEqual([{ mailActiveNode: 'sv1' }]);
  });

  it('never writes without persist, when the stored value already matches, or for a PVC-derived guess', async () => {
    const a = dbStub(null);
    await resolveActiveMailNode(a.db, coreStub([{ node: 'sv1' }]) as never, { knownNodes: KNOWN });
    const b = dbStub('sv1');
    await resolveActiveMailNode(b.db, coreStub([{ node: 'sv1' }]) as never, { knownNodes: KNOWN, persist: true });
    const c = dbStub(null);
    await resolveActiveMailNode(c.db, coreStub([], { selectedNode: 'sv1' }) as never, { knownNodes: KNOWN, persist: true });
    expect([...a.updates, ...b.updates, ...c.updates]).toEqual([]);
  });
});

describe('readLiveStalwartNode', () => {
  it('asks for the stalwart-mail pods in the mail namespace', async () => {
    const core = coreStub([{ node: 'sv1' }]);
    await readLiveStalwartNode(core as never);
    expect(core.listNamespacedPod).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'mail', labelSelector: 'app=stalwart-mail' }));
  });
});
