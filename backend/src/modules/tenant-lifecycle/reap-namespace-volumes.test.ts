import { describe, it, expect } from 'vitest';
import {
  reapNamespaceVolumes,
  type ReapDeps,
  type ReapPv,
  type ReapLonghornVolume,
} from './reap-namespace-volumes.js';

interface HarnessPv extends ReapPv {
  /** When set, the PV reads as Bound until the fake clock reaches this, then Released. */
  readonly releaseAtMs?: number;
}

interface Harness {
  readonly deps: ReapDeps;
  readonly deletedPvs: string[];
  readonly deletedVols: string[];
  readonly remainingPvs: () => HarnessPv[];
  readonly remainingVols: () => ReapLonghornVolume[];
}

function makeHarness(initial: {
  pvs?: HarnessPv[];
  vols?: ReapLonghornVolume[];
}): Harness {
  let clock = 0;
  const pvs = [...(initial.pvs ?? [])];
  const vols = [...(initial.vols ?? [])];
  const deletedPvs: string[] = [];
  const deletedVols: string[] = [];

  const deps: ReapDeps = {
    listPvs: async () => pvs.map((p) => ({
      name: p.name,
      claimNamespace: p.claimNamespace,
      phase: (p.releaseAtMs !== undefined && clock >= p.releaseAtMs) ? 'Released' : p.phase,
    })),
    listLonghornVolumes: async () => vols.map((v) => ({ name: v.name, namespace: v.namespace })),
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
  it('exits immediately for a tenant with no storage (no PV/vol → pass 1)', async () => {
    // The hot-path case that must NOT block the delete: nothing to reap.
    const h = makeHarness({ pvs: [], vols: [] });
    const r = await reapNamespaceVolumes(h.deps, NS);
    expect(r).toEqual({ pvsReaped: [], lhVolsReaped: [], timedOut: false });
    expect(h.deletedPvs).toEqual([]);
  });

  it('reaps a Released PV claimed by the namespace AND its Longhorn volume CR (by PV name)', async () => {
    const h = makeHarness({
      pvs: [{ name: 'pvc-aaa', claimNamespace: NS, phase: 'Released' }],
      vols: [{ name: 'pvc-aaa', namespace: NS }],
    });
    const r = await reapNamespaceVolumes(h.deps, NS);
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

  it('NEVER touches a Bound PV (still serving a live pod); times out instead', async () => {
    const h = makeHarness({
      pvs: [{ name: 'pvc-live', claimNamespace: NS, phase: 'Bound' }],
    });
    const r = await reapNamespaceVolumes(h.deps, NS, { intervalMs: 10, timeoutMs: 100 });
    expect(h.deletedPvs).toEqual([]);
    expect(r.pvsReaped).toEqual([]);
    expect(r.timedOut).toBe(true);
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
    expect(r).toEqual({ pvsReaped: [], lhVolsReaped: [], timedOut: false });
  });

  it('waits for a Bound PV to become Released, then reaps it (Retain-policy hard-delete)', async () => {
    // PV starts Bound and flips to Released once the namespace teardown drains
    // the PVC — the reap must keep polling until then, then reap it.
    const h = makeHarness({
      pvs: [{ name: 'pvc-slow', claimNamespace: NS, phase: 'Bound', releaseAtMs: 6_000 }],
      vols: [{ name: 'pvc-slow', namespace: NS }],
    });
    const r = await reapNamespaceVolumes(h.deps, NS, { intervalMs: 3_000, timeoutMs: 45_000 });
    expect(r.timedOut).toBe(false);
    expect(h.deletedPvs).toEqual(['pvc-slow']);
    expect(h.deletedVols).toContain('pvc-slow');
  });

  it('returns timedOut=true when a Bound PV never releases, without throwing', async () => {
    const h = makeHarness({
      pvs: [{ name: 'pvc-stuck', claimNamespace: NS, phase: 'Bound' }],
    });
    const r = await reapNamespaceVolumes(h.deps, NS, { intervalMs: 10, timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.pvsReaped).toEqual([]);
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
