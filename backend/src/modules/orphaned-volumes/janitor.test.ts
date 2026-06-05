import { describe, it, expect, vi } from 'vitest';
import { sweepReleasedSystemPvs, type JanitorPv } from './janitor.js';

const NOW = Date.parse('2026-06-05T12:00:00Z');
const DAYS = 24 * 60 * 60 * 1000;

function pv(over: Partial<JanitorPv>): JanitorPv {
  return {
    name: 'pvc-old',
    phase: 'Released',
    claimNamespace: 'platform',
    claimName: 'system-db-2',
    longhornVolumeName: 'pvc-old',
    lastTransitionMs: NOW - 3 * DAYS,
    ...over,
  };
}

function deps(pvs: JanitorPv[]) {
  const deleteOrphan = vi.fn(async () => ({ deletedPv: true, deletedLonghornVolume: true, deletedNamespace: false }));
  const audit = vi.fn(async () => {});
  return { listPvs: async () => pvs, deleteOrphan, audit };
}

describe('sweepReleasedSystemPvs', () => {
  it('deletes a Released system-db PV whose claim is bound to a NEWER PV', async () => {
    const d = deps([
      pv({ name: 'pvc-old', claimName: 'system-db-2' }),
      pv({ name: 'pvc-new', claimName: 'system-db-2', phase: 'Bound' }),
    ]);
    const r = await sweepReleasedSystemPvs(d, NOW);
    expect(r.deleted).toEqual(['pvc-old']);
    expect(d.deleteOrphan).toHaveBeenCalledWith({ pvName: 'pvc-old', longhornVolumeName: 'pvc-old' });
    expect(d.audit).toHaveBeenCalledTimes(1);
  });

  it('KEEPS a Released PV with no Bound successor (mid-recreate / data not superseded)', async () => {
    const d = deps([pv({ name: 'pvc-only', claimName: 'system-db-3' })]);
    const r = await sweepReleasedSystemPvs(d, NOW);
    expect(r.deleted).toEqual([]);
    expect(d.deleteOrphan).not.toHaveBeenCalled();
  });

  it('KEEPS Released PVs outside platform/system-db scope (tenant data is never auto-deleted)', async () => {
    const d = deps([
      pv({ name: 'pvc-tenant', claimNamespace: 'tenant-abc', claimName: 'tenant-abc-storage' }),
      pv({ name: 'pvc-tenant-bound', claimNamespace: 'tenant-abc', claimName: 'tenant-abc-storage', phase: 'Bound' }),
      pv({ name: 'pvc-mail', claimNamespace: 'mail', claimName: 'mail-stack-data' }),
    ]);
    const r = await sweepReleasedSystemPvs(d, NOW);
    expect(r.deleted).toEqual([]);
  });

  it('KEEPS a too-young Released PV (grace for operator inspection)', async () => {
    const d = deps([
      pv({ name: 'pvc-young', lastTransitionMs: NOW - 0.5 * DAYS }),
      pv({ name: 'pvc-new', phase: 'Bound' }),
    ]);
    const r = await sweepReleasedSystemPvs(d, NOW);
    expect(r.deleted).toEqual([]);
  });

  it('never deletes Bound or Available PVs', async () => {
    const d = deps([
      pv({ name: 'pvc-bound', phase: 'Bound' }),
      pv({ name: 'pvc-avail', phase: 'Available' }),
    ]);
    const r = await sweepReleasedSystemPvs(d, NOW);
    expect(r.deleted).toEqual([]);
  });

  it('continues past a failing deletion and reports it', async () => {
    const d = deps([
      pv({ name: 'pvc-a', claimName: 'system-db-1' }),
      pv({ name: 'pvc-a2', claimName: 'system-db-1', phase: 'Bound' }),
      pv({ name: 'pvc-b', claimName: 'system-db-2' }),
      pv({ name: 'pvc-b2', claimName: 'system-db-2', phase: 'Bound' }),
    ]);
    d.deleteOrphan.mockRejectedValueOnce(new Error('api down'));
    const r = await sweepReleasedSystemPvs(d, NOW);
    expect(r.deleted).toEqual(['pvc-b']);
    expect(r.failed).toEqual(['pvc-a']);
  });
});
