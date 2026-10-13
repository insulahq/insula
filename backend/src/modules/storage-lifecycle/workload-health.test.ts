import { describe, it, expect } from 'vitest';
import {
  GRACE_MS, RECENT_EVENT_MS,
  classifyUnavailability, currentEvidence, evidenceIsStale, isHealable, labelForReason, parsePreQuiesceReplicas,
  type EvidenceEvent, type EvidencePod, type HealReason,
} from './workload-health.js';

/**
 * Message fixtures are the VERBATIM text production emitted during the
 * outage described above, copied out of a real k3s journal.
 * Classifying kubelet-speak from memory is how you get a matcher that reads
 * plausibly and matches nothing — cf. parsing a format from docs rather than
 * from what the tool actually prints.
 */
const REAL_STALE_GLOBALMOUNT = 'MountVolume.MountDevice failed for volume '
  + '"pvc-00000000-1111-2222-3333-444444444444" (UniqueName: '
  + '"kubernetes.io/csi/driver.longhorn.io^pvc-00000000-1111-2222-3333-444444444444") '
  + 'pod "website-6b8c9d7f4-ab12c" : kubernetes.io/csi: attacher.MountDevice failed to '
  + 'create dir "/var/lib/kubelet/plugins/kubernetes.io/csi/driver.longhorn.io/'
  + '0000000000000000000000000000000000000000000000000000000000000000/globalmount": '
  + 'mkdir /var/lib/kubelet/plugins/kubernetes.io/csi/driver.longhorn.io/'
  + '0000000000000000000000000000000000000000000000000000000000000000/globalmount: file exists';

const REAL_NOT_READY_FOR_WORKLOADS = 'AttachVolume.Attach failed for volume '
  + '"pvc-00000000-1111-2222-3333-444444444444" : rpc error: code = Aborted desc = '
  + 'volume pvc-00000000-1111-2222-3333-444444444444 is not ready for workloads';

const REAL_QUOTA = 'FailedCreate: pods "moodle-7c9d8e6a5-cd34e" is forbidden: exceeded quota: '
  + 'tenant-example-0a1b2c3d-quota, requested: limits.memory=512Mi, '
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

  it('names the stale staging directory even when a quota rejection sits beside it (the production case)', () => {
    // After a salvage Longhorn deletes the pods; each replacement is refused
    // while its predecessor is still terminating, and that FailedCreate stays
    // in the namespace's events while a later replacement sits unmountable.
    // Two production tenants in exactly this state were recorded as
    // quota_rejected — a failed heal would have said "raise the plan limits".
    for (const r of [
      classifyUnavailability(REAL_QUOTA, [REAL_STALE_GLOBALMOUNT]),
      classifyUnavailability(null, [REAL_QUOTA, REAL_STALE_GLOBALMOUNT]),
      classifyUnavailability(null, [REAL_STALE_GLOBALMOUNT, REAL_QUOTA]),
    ]) {
      expect(r.reason).toBe('volume_attach');
      expect(r.label).toMatch(/stale CSI staging directory/);
    }
  });

  it('still prefers the quota cause over any OTHER volume failure', () => {
    // The ReplicaSet refuses to create a pod that could not have mounted
    // anyway. Of those two the quota is the one a human must decide about.
    const r = classifyUnavailability(REAL_QUOTA, [REAL_NOT_READY_FOR_WORKLOADS]);
    expect(r.reason).toBe('quota_rejected');
    expect(classifyUnavailability(null, [REAL_NOT_READY_FOR_WORKLOADS, REAL_QUOTA]).reason).toBe('quota_rejected');
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

// ── the alert's human-readable cause ───────────────────────────────────
//
// It used to fall back to re-classifying the stored `detail` column when a
// reason had no label. `detail` is truncated to 1000 chars at write time, so for
// a long pod-message list whose determinative keyword fell past the cut, the
// label contradicted the `reason` the row was classified as — two fields
// describing the same episode, disagreeing.
describe('labelForReason — total, and never re-derived from truncated detail', () => {
  const ALL: HealReason[] = [
    'volume_attach', 'quota_rejected', 'unschedulable', 'image', 'crash',
    'stranded_at_zero', 'unknown',
  ];

  it('gives every reason a distinct, non-empty label', () => {
    const labels = ALL.map(labelForReason);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(10);
    expect(new Set(labels).size).toBe(ALL.length);
  });

  it('never returns a placeholder or the slug itself', () => {
    for (const r of ALL) {
      const l = labelForReason(r);
      expect(l).not.toContain('undefined');
      expect(l).not.toBe(r);
    }
  });

  it('falls back to the unknown label for an unrecognised slug, not to empty', () => {
    // Rows are written by an older release than the one reading them; a slug
    // this build does not know must still render a sentence.
    const l = labelForReason('something_new_from_a_later_release' as HealReason);
    expect(l).toBe(labelForReason('unknown'));
  });

  it('is independent of detail — the same reason labels identically however long the text', () => {
    const short = classifyUnavailability(null, ['ImagePullBackOff: x']);
    const buried = classifyUnavailability(null, [`${'y'.repeat(1200)} ImagePullBackOff`]);
    // The classifier may not see a keyword past truncation, but the LABEL used
    // by the alert comes from the persisted reason, so it cannot disagree.
    expect(labelForReason('image')).toBe(labelForReason('image'));
    expect(short.reason).toBe('image');
    expect(buried.detail!.length).toBeLessThanOrEqual(1000);
  });
});

// ── the pre-quiesce replica annotation ──────────────────────────────────
//
// It is operator-visible and hand-editable, so it is untrusted input. A restore
// driven by a coerced value is worse than falling back to a validated operation
// snapshot: it would scale a tenant to NaN, to 0, or to something wild.
describe('parsePreQuiesceReplicas — untrusted annotation input', () => {
  it('accepts a plain positive integer', () => {
    expect(parsePreQuiesceReplicas('1')).toBe(1);
    expect(parsePreQuiesceReplicas('3')).toBe(3);
    expect(parsePreQuiesceReplicas('12')).toBe(12);
  });

  it('treats absent or empty as absent, not as zero', () => {
    expect(parsePreQuiesceReplicas(undefined)).toBeNull();
    expect(parsePreQuiesceReplicas('')).toBeNull();
  });

  it('rejects 0 — quiesce only stamps workloads it scaled down FROM a positive count', () => {
    expect(parsePreQuiesceReplicas('0')).toBeNull();
    expect(parsePreQuiesceReplicas('00')).toBeNull();
  });

  it('rejects everything that is not a plain integer rather than coercing it', () => {
    for (const bad of ['abc', '-1', '1e9', '1.5', ' 2', '2 ', '+2', 'Infinity', 'NaN', '0x10', '99999']) {
      expect(parsePreQuiesceReplicas(bad)).toBeNull();
    }
  });

  it('never returns NaN or a non-integer for any input', () => {
    for (const v of ['1', 'x', '', '-3', '2.2', undefined]) {
      const r = parsePreQuiesceReplicas(v as string | undefined);
      if (r !== null) {
        expect(Number.isSafeInteger(r)).toBe(true);
        expect(r).toBeGreaterThan(0);
      }
    }
  });
});


describe('currentEvidence — only what is wrong NOW', () => {
  const NOW = Date.parse('2026-10-13T03:00:00Z');
  const ago = (ms: number) => new Date(NOW - ms);
  const pending = (uid: string, over: Partial<NonNullable<EvidencePod['status']>> = {}): EvidencePod => ({
    metadata: { uid },
    status: {
      phase: 'Pending',
      conditions: [{ type: 'ContainersReady', status: 'False', reason: 'ContainersNotReady', message: 'containers with unready status: [web]' }],
      containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }],
      ...over,
    },
  });
  const running = (uid: string, over: Partial<NonNullable<EvidencePod['status']>> = {}): EvidencePod => ({
    metadata: { uid },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady', message: 'containers with unready status: [mariadb]' }],
      containerStatuses: [{ state: {} }],
      ...over,
    },
  });
  const podEvent = (uid: string, message: string, over: Partial<EvidenceEvent> = {}): EvidenceEvent => ({
    type: 'Warning', reason: 'FailedMount', message, involvedObject: { kind: 'Pod', uid }, lastTimestamp: ago(60_000), ...over,
  });
  const rsEvent = (message: string, lastSeen: Date | string | null): EvidenceEvent => ({
    type: 'Warning', reason: 'FailedCreate', message, involvedObject: { kind: 'ReplicaSet', uid: 'rs-1' }, lastTimestamp: lastSeen,
  });
  const reasonOf = (pods: EvidencePod[], events: EvidenceEvent[], replicaFailure: string | null = null) =>
    classifyUnavailability(replicaFailure, currentEvidence(pods, events, NOW)).reason;

  it('counts a mount failure of a pod that exists and has not started', () => {
    expect(reasonOf([pending('p1')], [podEvent('p1', REAL_STALE_GLOBALMOUNT)])).toBe('volume_attach');
  });

  it('a database in crash recovery is NOT a volume that will not mount, whatever its start-up logged', () => {
    // The pod mounted, started, and is merely not ready yet. Its own earlier
    // FailedMount and the deleted predecessor's are both history.
    const events = [
      podEvent('db-now', REAL_NOT_READY_FOR_WORKLOADS, { reason: 'FailedAttachVolume' }),
      podEvent('db-before-the-salvage', REAL_STALE_GLOBALMOUNT),
    ];
    const evidence = currentEvidence([running('db-now')], events, NOW);
    expect(evidence).toEqual(['ContainersNotReady: containers with unready status: [mariadb]']);
    expect(classifyUnavailability(null, evidence).reason).toBe('unknown');
  });

  it('drops the events of pods that no longer exist: a healed stale mount does not explain a later quota rejection', () => {
    const old = podEvent('pod-healed-20-minutes-ago', REAL_STALE_GLOBALMOUNT, { lastTimestamp: ago(20 * 60_000) });
    expect(reasonOf([], [old], REAL_QUOTA)).toBe('quota_rejected');
    // ...and with no pod at all and nothing else said, it is not a volume problem either.
    expect(reasonOf([], [old])).toBe('unknown');
  });

  it('still names the stale mount beside a quota rejection while a pod is really stuck on it', () => {
    expect(reasonOf([pending('p1')], [podEvent('p1', REAL_STALE_GLOBALMOUNT), rsEvent(REAL_QUOTA, ago(120_000))], REAL_QUOTA))
      .toBe('volume_attach');
  });

  it('counts an event about a ReplicaSet only while it is recent', () => {
    expect(reasonOf([], [rsEvent(REAL_QUOTA, ago(RECENT_EVENT_MS - 1000))])).toBe('quota_rejected');
    expect(reasonOf([], [rsEvent(REAL_QUOTA, ago(RECENT_EVENT_MS + 1000))])).toBe('unknown');
  });

  it('dates an event by its latest occurrence, in whichever field carries it', () => {
    const base = { type: 'Warning', reason: 'FailedCreate', message: REAL_QUOTA, involvedObject: { kind: 'ReplicaSet' } };
    const recent = ago(60_000);
    const old = ago(RECENT_EVENT_MS * 3);
    for (const e of [
      { ...base, lastTimestamp: recent.toISOString() },
      { ...base, lastTimestamp: null, eventTime: recent },
      { ...base, eventTime: old, series: { lastObservedTime: recent } },
      { ...base, metadata: { creationTimestamp: recent } },
      { ...base, lastTimestamp: recent, metadata: { creationTimestamp: old } },
    ] as EvidenceEvent[]) {
      expect(currentEvidence([], [e], NOW)).toHaveLength(1);
    }
    expect(currentEvidence([], [{ ...base, lastTimestamp: old, metadata: { creationTimestamp: old } }], NOW)).toEqual([]);
  });

  it('does not take an event nobody can date as the present', () => {
    expect(currentEvidence([], [{ type: 'Warning', reason: 'FailedCreate', message: REAL_QUOTA, involvedObject: { kind: 'ReplicaSet' } }], NOW)).toEqual([]);
    expect(currentEvidence([], [rsEvent(REAL_QUOTA, 'not a date')], NOW)).toEqual([]);
  });

  it('keeps what a pod says about itself — crash loops and image pulls need no event', () => {
    const crashing = running('p1', { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s restarting failed container=web' } } }] });
    expect(reasonOf([crashing], [])).toBe('crash');
    const pulling = pending('p2', { containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff', message: 'Back-off pulling image' } } }] });
    expect(reasonOf([pulling], [])).toBe('image');
    const unschedulable = pending('p3', {
      conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/3 nodes are available: 3 Insufficient memory.' }],
      containerStatuses: [],
    });
    expect(reasonOf([unschedulable], [])).toBe('unschedulable');
  });

  it('ignores finished pods, Normal events and events without text, and stays bounded', () => {
    const done: EvidencePod = { metadata: { uid: 'job-1' }, status: { phase: 'Succeeded', conditions: [{ type: 'Ready', status: 'False', reason: 'PodCompleted', message: 'done' }] } };
    expect(currentEvidence([done], [
      podEvent('job-1', REAL_STALE_GLOBALMOUNT),
      { type: 'Normal', reason: 'Pulled', message: 'ok', involvedObject: { kind: 'Pod', uid: 'p1' }, lastTimestamp: ago(1000) },
      { type: 'Warning', reason: 'FailedMount', involvedObject: { kind: 'Pod', uid: 'p1' }, lastTimestamp: ago(1000) },
    ], NOW)).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => podEvent('p1', `failure ${i}`));
    expect(currentEvidence([pending('p1')], many, NOW)).toHaveLength(20);
  });
});

describe('evidenceIsStale — how often an outage is diagnosed afresh', () => {
  const T = 1_000_000_000;
  it('reads a namespace it has not seen down before', () => {
    expect(evidenceIsStale(undefined, T)).toBe(true);
  });

  it('reads on every tick while the diagnosis still decides something — inside the grace window', () => {
    expect(evidenceIsStale({ since: T - 60_000, at: T - 1 }, T)).toBe(true);
    expect(evidenceIsStale({ since: T - (GRACE_MS - 1), at: T - 1 }, T)).toBe(true);
  });

  it('past the grace window reads again only every five minutes', () => {
    const since = T - GRACE_MS - 60_000;
    expect(evidenceIsStale({ since, at: T - 60_000 }, T)).toBe(false);
    expect(evidenceIsStale({ since, at: T - (5 * 60_000 - 1) }, T)).toBe(false);
    expect(evidenceIsStale({ since, at: T - 5 * 60_000 }, T)).toBe(true);
  });
});
