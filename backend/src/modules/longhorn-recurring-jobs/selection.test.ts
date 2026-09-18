/**
 * The sweep's whole safety argument lives in these cases.
 *
 * It deletes Longhorn snapshots — data — so the tests that matter are the ones
 * that prove it DOESN'T delete: the platform database's chain, a snapshot whose
 * job still covers its volume, a tenant's own manual snapshot, and anything it
 * cannot prove is an orphan.
 */
import { describe, it, expect } from 'vitest';
import {
  jobCoversVolume,
  planGroupLabelling,
  planSnapshotSweep,
  GROUP_LABEL_PREFIX,
  JOB_LABEL_PREFIX,
} from './selection.js';

const hourly = { name: 'hourly-snap', groups: ['system-critical'] };
const hourlyOld = { name: 'hourly-snap', groups: ['default'] };
const trim = { name: 'daily-fstrim', groups: ['default'] };

const vol = (name: string, labels: Record<string, string> = {}, attached = true) =>
  ({ name, labels, attached });
const detachedVol = (name: string, labels: Record<string, string> = {}) => vol(name, labels, false);
const tenantVol = (name: string) => vol(name, { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' });
const dbVol = (name: string) => vol(name, {
  [`${GROUP_LABEL_PREFIX}default`]: 'enabled',
  [`${GROUP_LABEL_PREFIX}system-critical`]: 'enabled',
});

const snap = (name: string, volume: string, recurringJob: string | null = 'hourly-snap') =>
  ({ name, volume, recurringJob, terminating: false, headAdjacent: false });
const terminatingSnap = (name: string, volume: string, headAdjacent = false) =>
  ({ ...snap(name, volume), terminating: true, headAdjacent });

describe('jobCoversVolume', () => {
  it('covers a volume that carries the job group label', () => {
    expect(jobCoversVolume(hourly, dbVol('pvc-db'))).toBe(true);
  });

  it('does not cover a volume in a DIFFERENT group', () => {
    // The whole point of moving hourly-snap to `system-critical`: a tenant
    // volume labelled `default` stops being selected.
    expect(jobCoversVolume(hourly, tenantVol('pvc-t1'))).toBe(false);
  });

  it('covers a volume bound to the job directly, bypassing groups', () => {
    const v = vol('pvc-x', { [`${JOB_LABEL_PREFIX}hourly-snap`]: 'enabled' });
    expect(jobCoversVolume(hourly, v)).toBe(true);
  });

  it('treats a volume with NO membership label as a member of `default`', () => {
    // Longhorn's implicit-default rule. This is how tenant volumes ended up in
    // every job the `default` group held even before the provisioner labelled
    // them, so the sweep has to honour it or it would delete live snapshots.
    expect(jobCoversVolume(trim, vol('pvc-bare'))).toBe(true);
    expect(jobCoversVolume(hourlyOld, vol('pvc-bare'))).toBe(true);
    // …but a job with no `default` in its groups still does not cover it.
    expect(jobCoversVolume(hourly, vol('pvc-bare'))).toBe(false);
  });

  it('does not read a disabled membership label as membership', () => {
    const v = vol('pvc-y', { [`${GROUP_LABEL_PREFIX}system-critical`]: 'ignored' });
    expect(jobCoversVolume(hourly, v)).toBe(false);
    // …and it is NOT implicitly in `default` either: the label exists, so the
    // volume has been spoken about explicitly.
    expect(jobCoversVolume(trim, v)).toBe(false);
  });
});

describe('planSnapshotSweep', () => {
  const base = { jobs: [hourly, trim], protectedVolumes: ['pvc-db'], maxVolumesPerTick: 10 };

  it('sweeps scheduled snapshots on volumes the job no longer covers', () => {
    const plan = planSnapshotSweep({
      ...base,
      volumes: [tenantVol('pvc-t1'), dbVol('pvc-db')],
      snapshots: [snap('s1', 'pvc-t1'), snap('s2', 'pvc-t1')],
    });
    expect(plan.byVolume).toEqual([{ volume: 'pvc-t1', snapshots: ['s1', 's2'] }]);
  });

  it('NEVER sweeps the platform database, even when its label is missing', () => {
    // The label is applied by the same tick. If that patch failed, the database
    // volume reads as uncovered — and its six-hour rollback chain would be the
    // first thing deleted. The protected list is the second lock on that door.
    const plan = planSnapshotSweep({
      ...base,
      volumes: [vol('pvc-db', { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' })],
      snapshots: [snap('s1', 'pvc-db'), snap('s2', 'pvc-db')],
    });
    expect(plan.byVolume).toEqual([]);
    expect(plan.skippedProtected).toBe(2);
  });

  it('leaves snapshots alone while their job still covers the volume', () => {
    // No duel with the creating job: if someone puts `default` back on
    // hourly-snap, the same snapshots stop being orphans on the next tick
    // instead of being deleted as fast as they are created.
    const plan = planSnapshotSweep({
      ...base,
      jobs: [hourlyOld, trim],
      volumes: [tenantVol('pvc-t1')],
      snapshots: [snap('s1', 'pvc-t1')],
    });
    expect(plan.byVolume).toEqual([]);
  });

  it('ignores a snapshot with no RecurringJob label', () => {
    // A tenant's own snapshot from the panel, or a CSI VolumeSnapshot's. Those
    // have a DB row and an expiry; the tenant-snapshot reaper owns them.
    const plan = planSnapshotSweep({
      ...base,
      volumes: [tenantVol('pvc-t1')],
      snapshots: [snap('manual-1', 'pvc-t1', null)],
    });
    expect(plan.byVolume).toEqual([]);
  });

  it('sweeps a snapshot whose job no longer exists at all', () => {
    const plan = planSnapshotSweep({
      ...base,
      volumes: [tenantVol('pvc-t1')],
      snapshots: [snap('s1', 'pvc-t1', 'retired-weekly-backup')],
    });
    expect(plan.byVolume).toEqual([{ volume: 'pvc-t1', snapshots: ['s1'] }]);
  });

  it('leaves a snapshot whose volume it cannot read', () => {
    // An unreadable volume means unreadable labels, which means no way to prove
    // the snapshot is an orphan. Counted, not deleted.
    const plan = planSnapshotSweep({ ...base, volumes: [], snapshots: [snap('s1', 'pvc-gone')] });
    expect(plan.byVolume).toEqual([]);
    expect(plan.skippedUnknownVolume).toBe(1);
  });

  it('counts a snapshot already being purged instead of re-deleting it', () => {
    // On a DETACHED volume the object sits in Terminating until the volume
    // next attaches. Re-issuing the delete changes nothing, and treating the
    // object as gone would report a converged cluster while it is still there.
    const plan = planSnapshotSweep({
      ...base,
      volumes: [tenantVol('pvc-t1')],
      snapshots: [terminatingSnap('going', 'pvc-t1'), snap('fresh', 'pvc-t1')],
    });
    expect(plan.byVolume).toEqual([{ volume: 'pvc-t1', snapshots: ['fresh'] }]);
    expect(plan.pendingPurge).toBe(1);
    expect(plan.pendingPurgeVolumes).toEqual(['pvc-t1']);
  });

  it('blames a DETACHED volume, not head adjacency, when the volume is detached', () => {
    // Longhorn cannot purge a detached volume at all. Getting this wrong meant
    // logging "waiting for their volume to attach" about an attached one.
    const plan = planSnapshotSweep({
      ...base,
      volumes: [detachedVol('pvc-t1', { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' })],
      snapshots: [terminatingSnap('going', 'pvc-t1', true)],
    });
    expect(plan.pendingDetached).toBe(1);
    expect(plan.pendingHeadParent).toBe(0);
  });

  it('blames head adjacency on an ATTACHED volume', () => {
    // Measured: the engine finishes its purge (progress 100, state complete)
    // and still leaves the head's parent behind, because folding it would mean
    // merging into the volume being written to. It clears on the next snapshot.
    const plan = planSnapshotSweep({
      ...base,
      volumes: [tenantVol('pvc-t1')],
      snapshots: [terminatingSnap('going', 'pvc-t1', true)],
    });
    expect(plan.pendingHeadParent).toBe(1);
    expect(plan.pendingDetached).toBe(0);
  });

  it('attributes a mid-purge snapshot to neither cause', () => {
    // Attached, not head-adjacent: Longhorn is simply working on it, which
    // finishes in seconds. Counted as pending, blamed on nothing.
    const plan = planSnapshotSweep({
      ...base,
      volumes: [tenantVol('pvc-t1')],
      snapshots: [terminatingSnap('going', 'pvc-t1', false)],
    });
    expect(plan.pendingPurge).toBe(1);
    expect(plan.pendingDetached).toBe(0);
    expect(plan.pendingHeadParent).toBe(0);
  });

  it('does not count a terminating snapshot on a protected volume', () => {
    const plan = planSnapshotSweep({
      ...base,
      volumes: [dbVol('pvc-db')],
      snapshots: [terminatingSnap('going', 'pvc-db')],
    });
    expect(plan.pendingPurge).toBe(0);
    expect(plan.skippedProtected).toBe(1);
  });

  it('spends no per-tick budget on a volume whose snapshots are all terminating', () => {
    // Otherwise a handful of detached volumes could starve the sweep forever.
    const plan = planSnapshotSweep({
      ...base,
      volumes: [tenantVol('pvc-a'), tenantVol('pvc-b')],
      snapshots: [terminatingSnap('a1', 'pvc-a'), snap('b1', 'pvc-b')],
      maxVolumesPerTick: 1,
    });
    expect(plan.byVolume).toEqual([{ volume: 'pvc-b', snapshots: ['b1'] }]);
    expect(plan.deferredVolumes).toBe(0);
  });

  it('caps volumes per tick and defers the rest', () => {
    // The cap is the I/O brake: deleting a snapshot coalesces its blocks into
    // the next one in the chain, and this platform has measured multi-second
    // fsync stalls on the disk that also holds etcd.
    const volumes = ['pvc-a', 'pvc-b', 'pvc-c', 'pvc-d'].map(tenantVol);
    const snapshots = volumes.flatMap((v) => [snap(`${v.name}-s1`, v.name), snap(`${v.name}-s2`, v.name)]);
    const plan = planSnapshotSweep({ ...base, volumes, snapshots, maxVolumesPerTick: 2 });
    expect(plan.byVolume.map((g) => g.volume)).toEqual(['pvc-a', 'pvc-b']);
    expect(plan.byVolume.flatMap((g) => g.snapshots)).toHaveLength(4);
    expect(plan.deferredVolumes).toBe(2);
  });

  it('purges one volume as a whole rather than spreading a tick across many', () => {
    // Coalescing a chain once is cheaper than touching the same volume on
    // several ticks, so the cap counts VOLUMES, not snapshots.
    const volumes = [tenantVol('pvc-a'), tenantVol('pvc-b')];
    const snapshots = [
      snap('a1', 'pvc-a'), snap('a2', 'pvc-a'), snap('a3', 'pvc-a'),
      snap('b1', 'pvc-b'),
    ];
    const plan = planSnapshotSweep({ ...base, volumes, snapshots, maxVolumesPerTick: 1 });
    expect(plan.byVolume).toEqual([{ volume: 'pvc-a', snapshots: ['a1', 'a2', 'a3'] }]);
  });

  it('orders volumes deterministically so concurrent replicas agree', () => {
    const volumes = [tenantVol('pvc-z'), tenantVol('pvc-a'), tenantVol('pvc-m')];
    const snapshots = volumes.map((v) => snap(`${v.name}-s`, v.name));
    const plan = planSnapshotSweep({ ...base, volumes, snapshots, maxVolumesPerTick: 2 });
    expect(plan.byVolume.map((g) => g.volume)).toEqual(['pvc-a', 'pvc-m']);
  });
});

describe('planGroupLabelling', () => {
  it('labels a volume that should be a member but is not', () => {
    const volumes = [vol('pvc-db', { [`${GROUP_LABEL_PREFIX}default`]: 'enabled' }), tenantVol('pvc-t1')];
    expect(planGroupLabelling(volumes, ['pvc-db'], 'system-critical')).toEqual(['pvc-db']);
  });

  it('is a no-op once the label is there (no patch every tick)', () => {
    expect(planGroupLabelling([dbVol('pvc-db')], ['pvc-db'], 'system-critical')).toEqual([]);
  });

  it('re-labels a volume whose label says something other than enabled', () => {
    const v = vol('pvc-db', { [`${GROUP_LABEL_PREFIX}system-critical`]: 'ignored' });
    expect(planGroupLabelling([v], ['pvc-db'], 'system-critical')).toEqual(['pvc-db']);
  });

  it('never labels a volume that is not on the wanted list', () => {
    expect(planGroupLabelling([tenantVol('pvc-t1')], ['pvc-db'], 'system-critical')).toEqual([]);
  });

  it('ignores a wanted volume that does not exist in the cluster', () => {
    expect(planGroupLabelling([], ['pvc-db'], 'system-critical')).toEqual([]);
  });
});
