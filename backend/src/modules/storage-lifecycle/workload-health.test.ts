import { describe, it, expect } from 'vitest';
import { classifyUnavailability, isHealable, type HealReason } from './workload-health.js';

/**
 * Message fixtures are the VERBATIM text production emitted during the
 * 2026-09-25 outage, copied out of the k3s journal on cluster.phoenix-host.net.
 * Classifying kubelet-speak from memory is how you get a matcher that reads
 * plausibly and matches nothing — cf. parsing a format from docs rather than
 * from what the tool actually prints.
 */
const REAL_STALE_GLOBALMOUNT = 'MountVolume.MountDevice failed for volume '
  + '"pvc-60dd3bcd-d8d7-4fa2-85c3-e7b7548e3fcf" (UniqueName: '
  + '"kubernetes.io/csi/driver.longhorn.io^pvc-60dd3bcd-d8d7-4fa2-85c3-e7b7548e3fcf") '
  + 'pod "website-5d5f446499-6ds7v" : kubernetes.io/csi: attacher.MountDevice failed to '
  + 'create dir "/var/lib/kubelet/plugins/kubernetes.io/csi/driver.longhorn.io/'
  + 'e8fcfb523a4f9847c57539775ac5523584e24516163e342161fe89959940b573/globalmount": '
  + 'mkdir /var/lib/kubelet/plugins/kubernetes.io/csi/driver.longhorn.io/'
  + 'e8fcfb523a4f9847c57539775ac5523584e24516163e342161fe89959940b573/globalmount: file exists';

const REAL_NOT_READY_FOR_WORKLOADS = 'AttachVolume.Attach failed for volume '
  + '"pvc-60dd3bcd-d8d7-4fa2-85c3-e7b7548e3fcf" : rpc error: code = Aborted desc = '
  + 'volume pvc-60dd3bcd-d8d7-4fa2-85c3-e7b7548e3fcf is not ready for workloads';

const REAL_QUOTA = 'FailedCreate: pods "moodle-5558dbff57-x1y2z" is forbidden: exceeded quota: '
  + 'tenant-hatzlacha-college-9863d9c8-quota, requested: limits.memory=512Mi, '
  + 'used: limits.memory=844Mi, limited: limits.memory=1Gi';

describe('classifyUnavailability — real production messages', () => {
  it('recognises the stale CSI staging directory that caused an 18h38m outage', () => {
    const r = classifyUnavailability(null, [REAL_STALE_GLOBALMOUNT]);
    expect(r.reason).toBe('volume_attach');
    // The label has to say the thing that makes this different from a transient
    // attach failure: retrying forever does NOT fix it.
    expect(r.label).toMatch(/stale CSI staging directory/);
    expect(r.label).toMatch(/cannot self-repair/);
    expect(r.detail).toContain('file exists');
  });

  it('recognises a Longhorn volume that will not attach', () => {
    const r = classifyUnavailability(null, [REAL_NOT_READY_FOR_WORKLOADS]);
    expect(r.reason).toBe('volume_attach');
  });

  it('recognises a ResourceQuota rejection from the ReplicaSet condition', () => {
    const r = classifyUnavailability(REAL_QUOTA, []);
    expect(r.reason).toBe('quota_rejected');
    expect(r.label).toMatch(/ResourceQuota/);
  });

  it('prefers the quota cause when quota and volume failures are both present', () => {
    // Both happen together: the ReplicaSet refuses to create a pod that could
    // not have mounted anyway. The quota is the one a human must decide about.
    const r = classifyUnavailability(REAL_QUOTA, [REAL_STALE_GLOBALMOUNT]);
    expect(r.reason).toBe('quota_rejected');
  });

  it('recognises unschedulable, image and crash causes', () => {
    expect(classifyUnavailability(null, ['0/1 nodes are available: 1 Insufficient memory.']).reason)
      .toBe('unschedulable');
    expect(classifyUnavailability(null, ['ImagePullBackOff: Back-off pulling image']).reason)
      .toBe('image');
    expect(classifyUnavailability(null, ['CrashLoopBackOff: back-off 5m0s restarting failed container']).reason)
      .toBe('crash');
  });

  it('falls back to unknown rather than guessing, and keeps the raw text', () => {
    const r = classifyUnavailability(null, ['something nobody has seen before']);
    expect(r.reason).toBe('unknown');
    expect(r.detail).toContain('something nobody has seen before');
    expect(r.label).toBeTruthy();
  });

  it('reports detail as null when the cluster said nothing at all', () => {
    const r = classifyUnavailability(null, []);
    expect(r.reason).toBe('unknown');
    expect(r.detail).toBeNull();
  });

  it('truncates detail so one enormous event cannot bloat a DB row or an email', () => {
    const r = classifyUnavailability(null, ['x'.repeat(5000)]);
    expect(r.detail!.length).toBeLessThanOrEqual(1000);
  });
});

// ── the heal gate ───────────────────────────────────────────────────────
//
// Every arm is asserted explicitly. `isHealable` is a switch over a closed
// union with no `default`, so tsc fails if a reason is added without deciding
// this question — but a test that only checked the `true` arms would still pass
// while every cause was healable, which is the disruptive direction.
describe('isHealable — which causes a volume re-stage can actually fix', () => {
  it('heals the causes a detach/re-stage clears', () => {
    // The stale staging directory is the whole reason this exists: kubelet
    // retries it forever and only a full detach clears it.
    expect(isHealable('volume_attach')).toBe(true);
    // Restores from the operation's persisted replica snapshot.
    expect(isHealable('stranded_at_zero')).toBe(true);
    // A still-terminating pod holds its memory against the quota; waiting for
    // the detach lets it finish before the replacement is created.
    expect(isHealable('quota_rejected')).toBe(true);
    // No diagnosis — one bounded attempt is reasonable.
    expect(isHealable('unknown')).toBe(true);
  });

  it('refuses causes where a re-stage would bounce the namespace for nothing', () => {
    // Each of these comes back in exactly the same state. The PVC is RWO, so
    // healing takes the namespace's HEALTHY workloads down too — that price
    // buys nothing here.
    expect(isHealable('image')).toBe(false);
    expect(isHealable('crash')).toBe(false);
    expect(isHealable('unschedulable')).toBe(false);
  });

  it('covers every member of the union (an un-decided cause is a silent tenant)', () => {
    const all: HealReason[] = [
      'volume_attach', 'quota_rejected', 'unschedulable', 'image', 'crash',
      'stranded_at_zero', 'unknown',
    ];
    for (const r of all) expect(typeof isHealable(r)).toBe('boolean');
    // Both arms are actually exercised — a gate that answers the same way for
    // every input is not a gate.
    expect(all.filter(isHealable).length).toBeGreaterThan(0);
    expect(all.filter((r) => !isHealable(r)).length).toBeGreaterThan(0);
  });
});
