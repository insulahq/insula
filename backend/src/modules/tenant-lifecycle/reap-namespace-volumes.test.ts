import { describe, it, expect } from 'vitest';
import {
  reapNamespaceVolumes,
  type ReapDeps,
  type ReapPv,
  type ReapLonghornVolume,
} from './reap-namespace-volumes.js';

interface Harness {
  readonly deps: ReapDeps;
  readonly deletedPvs: string[];
  readonly deletedVols: string[];
  readonly remainingPvs: () => ReapPv[];
  readonly remainingVols: () => ReapLonghornVolume[];
}

function makeHarness(initial: {
  nsGoneAtMs?: number; // clock ms at/after which the namespace reads as gone (default 0 = already gone)
  pvs?: ReapPv[];
  vols?: ReapLonghornVolume[];
}): Harness {
  let clock = 0;
  const pvs = [...(initial.pvs ?? [])];
  const vols = [...(initial.vols ?? [])];
  const deletedPvs: string[] = [];
  const deletedVols: string[] = [];
  const nsGoneAt = initial.nsGoneAtMs ?? 0;

  const deps: ReapDeps = {
    namespaceGone: async () => clock >= nsGoneAt,
    listPvs: async () => pvs.slice(),
    listLonghornVolumes: async () => vols.slice(),
    deletePv: async (name) => {
      const i = pvs.findIndex((p) => p.name === name);
      if (i >= 0) pvs.splice(i, 1);
      deletedPvs.push(name);
    },
    deleteLonghornVolume: async (name) => {
      const i = vols.findIndex((v) => v.name === name);
      if (i >= 0) vols.splice(i, 1);
      deletedVols.push(name);
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };

  return { deps, deletedPvs, deletedVols, remainingPvs: () => pvs, remainingVols: () => vols };
}

const NS = 'tenant-bundle-test-abc';

describe('reapNamespaceVolumes', () => {
  it('reaps a Released PV claimed by the namespace AND its Longhorn volume CR (by PV name)', async () => {
    const h = makeHarness({
      pvs: [{ name: 'pvc-aaa', claimNamespace: NS, phase: 'Released' }],
      vols: [{ name: 'pvc-aaa', namespace: NS }],
    });
    const r = await reapNamespaceVolumes(h.deps, NS);
    expect(r.namespaceGone).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(h.deletedPvs).toEqual(['pvc-aaa']);
    expect(h.deletedVols).toContain('pvc-aaa');
    expect(r.pvsReaped).toEqual(['pvc-aaa']);
  });

  it('catch-all: reaps a stranded Longhorn volume CR by namespace when its PV is already gone', async () => {
    // The exact leak the by-PV-name pv-cleanup-released hook cannot reach:
    // PV deleted (Delete reclaimPolicy test tenant), volume CR survives.
    const h = makeHarness({
      pvs: [],
      vols: [{ name: 'pvc-orphan', namespace: NS }],
    });
    const r = await reapNamespaceVolumes(h.deps, NS);
    expect(h.deletedVols).toEqual(['pvc-orphan']);
    expect(r.lhVolsReaped).toEqual(['pvc-orphan']);
    expect(h.deletedPvs).toEqual([]);
  });

  it('NEVER touches a Bound PV (still serving a live pod)', async () => {
    const h = makeHarness({
      pvs: [{ name: 'pvc-live', claimNamespace: NS, phase: 'Bound' }],
    });
    const r = await reapNamespaceVolumes(h.deps, NS);
    expect(h.deletedPvs).toEqual([]);
    expect(r.pvsReaped).toEqual([]);
    expect(h.remainingPvs()).toHaveLength(1);
  });

  it('NEVER touches PVs/volumes belonging to another namespace', async () => {
    const h = makeHarness({
      pvs: [{ name: 'pvc-other', claimNamespace: 'tenant-other-xyz', phase: 'Released' }],
      vols: [{ name: 'v-other', namespace: 'tenant-other-xyz' }],
    });
    const r = await reapNamespaceVolumes(h.deps, NS);
    expect(h.deletedPvs).toEqual([]);
    expect(h.deletedVols).toEqual([]);
    expect(r.pvsReaped).toEqual([]);
    expect(r.lhVolsReaped).toEqual([]);
  });

  it('refuses to act on a non-tenant namespace (safety guard)', async () => {
    const h = makeHarness({
      pvs: [{ name: 'pvc-sys', claimNamespace: 'platform', phase: 'Released' }],
      vols: [{ name: 'pvc-sys', namespace: 'platform' }],
    });
    const r = await reapNamespaceVolumes(h.deps, 'platform');
    expect(h.deletedPvs).toEqual([]);
    expect(h.deletedVols).toEqual([]);
    expect(r).toEqual({ namespaceGone: false, pvsReaped: [], lhVolsReaped: [], timedOut: false });
  });

  it('waits for the namespace to terminate, then reaps the PV that becomes Released', async () => {
    // Namespace reads as gone only after 6s; the PV is Released from the start.
    const h = makeHarness({
      nsGoneAtMs: 6_000,
      pvs: [{ name: 'pvc-slow', claimNamespace: NS, phase: 'Released' }],
      vols: [{ name: 'pvc-slow', namespace: NS }],
    });
    const r = await reapNamespaceVolumes(h.deps, NS, { intervalMs: 3_000, timeoutMs: 45_000 });
    expect(r.namespaceGone).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(h.deletedPvs).toEqual(['pvc-slow']);
  });

  it('returns timedOut=true when the namespace never terminates, without throwing', async () => {
    const h = makeHarness({
      nsGoneAtMs: Number.POSITIVE_INFINITY,
      pvs: [],
      vols: [],
    });
    const r = await reapNamespaceVolumes(h.deps, NS, { intervalMs: 10, timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.namespaceGone).toBe(false);
  });

  it('tolerates a deletePv failure (best-effort) and still reaps the rest', async () => {
    const h = makeHarness({
      pvs: [
        { name: 'pvc-fail', claimNamespace: NS, phase: 'Released' },
        { name: 'pvc-ok', claimNamespace: NS, phase: 'Released' },
      ],
    });
    // Make the first delete throw; reapNamespaceVolumes swallows per-item errors.
    const realDelete = h.deps.deletePv;
    (h.deps as { deletePv: ReapDeps['deletePv'] }).deletePv = async (name) => {
      if (name === 'pvc-fail') throw new Error('boom');
      return realDelete(name);
    };
    const r = await reapNamespaceVolumes(h.deps, NS, { intervalMs: 10, timeoutMs: 1_000 });
    expect(r.pvsReaped).toContain('pvc-ok');
    expect(r.pvsReaped).toContain('pvc-fail'); // marked handled so we don't spin on it
  });
});
