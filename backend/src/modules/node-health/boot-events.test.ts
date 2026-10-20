import { describe, it, expect } from 'vitest';
import {
  detectBootTransitions,
  formatDowntime,
  kubeletReportsShutdown,
  wentDownAt,
  type BootFacts,
  type PrevBootState,
} from './boot-events.js';

const NOW = new Date('2026-09-11T12:40:00Z');

function facts(o: Partial<BootFacts> = {}): BootFacts {
  return {
    nodeName: o.nodeName ?? 'node-a',
    bootId: o.bootId === undefined ? 'boot-B' : o.bootId,
    ready: o.ready ?? true,
    readySince: o.readySince === undefined ? new Date('2026-09-11T12:32:34Z') : o.readySince,
    shuttingDown: o.shuttingDown ?? false,
  };
}

describe('kubeletReportsShutdown', () => {
  it('reads the kubelet graceful-shutdown report off Ready=False', () => {
    expect(kubeletReportsShutdown({ status: 'False', message: 'node is shutting down' })).toBe(true);
  });

  it('finds it inside the aggregated readiness message', () => {
    // The kubelet joins every readiness error into one message.
    expect(kubeletReportsShutdown({
      status: 'False',
      message: '[container runtime status check may not have completed yet, node is shutting down]',
    })).toBe(true);
  });

  it('is false for a crash, a power cut or a lost network — the kubelet just stops posting', () => {
    expect(kubeletReportsShutdown({ status: 'Unknown', message: 'Kubelet stopped posting node status.' })).toBe(false);
  });

  it('is false for any other NotReady reason, and for a Ready node', () => {
    expect(kubeletReportsShutdown({ status: 'False', message: 'container runtime network not ready' })).toBe(false);
    expect(kubeletReportsShutdown({ status: 'True', message: 'kubelet is posting ready status' })).toBe(false);
    expect(kubeletReportsShutdown(undefined)).toBe(false);
  });
});

function prev(o: Partial<PrevBootState> = {}): ReadonlyMap<string, PrevBootState> {
  return new Map([['node-a', {
    bootId: o.bootId === undefined ? 'boot-A' : o.bootId,
    ready: o.ready ?? true,
    observedAt: o.observedAt === undefined ? new Date('2026-09-11T12:25:44Z') : o.observedAt,
    rebootAnnounced: o.rebootAnnounced ?? false,
    downSince: o.downSince ?? null,
  }]]);
}

describe('detectBootTransitions', () => {
  // ── startup-complete: the signal that works on EVERY topology ──

  it('reports startup complete when the bootID changed and the node is Ready', () => {
    const out = detectBootTransitions([facts()], prev(), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'startup-complete', nodeName: 'node-a', bootId: 'boot-B' });
  });

  it('computes downtime from the last observation to the Ready transition', () => {
    const out = detectBootTransitions([facts()], prev(), NOW);
    const t = out[0];
    // 12:25:44 last seen -> 12:32:34 Ready = 6m50s, the real figure.
    expect(t.kind).toBe('startup-complete');
    if (t.kind !== 'startup-complete') throw new Error('unreachable');
    expect(t.downtimeMs).toBe(410_000);
    expect(formatDowntime(t.downtimeMs as number)).toBe('6m 50s');
  });

  it('flags that the reboot was never announced (the single-node case)', () => {
    const out = detectBootTransitions([facts()], prev({ rebootAnnounced: false }), NOW);
    if (out[0].kind !== 'startup-complete') throw new Error('unreachable');
    expect(out[0].rebootWasAnnounced).toBe(false);
  });

  it('flags that the reboot WAS announced (multi-node)', () => {
    const out = detectBootTransitions([facts()], prev({ rebootAnnounced: true }), NOW);
    if (out[0].kind !== 'startup-complete') throw new Error('unreachable');
    expect(out[0].rebootWasAnnounced).toBe(true);
  });

  // ── the false-positive guards ──

  it('says NOTHING the first time a node is seen', () => {
    // Fresh install, restored DB, or a newly joined worker. Announcing a reboot
    // nobody performed is exactly the noise this whole change exists to remove.
    expect(detectBootTransitions([facts()], new Map(), NOW)).toEqual([]);
  });

  it('says NOTHING when no previous bootID was recorded', () => {
    // Upgrading from before the boot_id column existed: adopt, do not claim.
    expect(detectBootTransitions([facts()], prev({ bootId: null }), NOW)).toEqual([]);
  });

  it('does NOT report a reboot when the bootID is unchanged', () => {
    // A kubelet restart or an API blip leaves the kernel bootID alone. This is
    // the whole reason the detector keys on bootID and not on Ready.
    expect(detectBootTransitions([facts({ bootId: 'boot-A' })], prev(), NOW)).toEqual([]);
  });

  it('does NOT report startup complete while the rebooted node is still NotReady', () => {
    expect(detectBootTransitions([facts({ ready: false })], prev(), NOW)).toEqual([]);
  });

  // ── shutting down ──

  it('reports shutting-down when the kubelet reports a graceful shutdown on the SAME boot', () => {
    const out = detectBootTransitions(
      [facts({ bootId: 'boot-A', ready: false, shuttingDown: true })],
      prev({ bootId: 'boot-A', ready: true }),
      NOW,
    );
    expect(out).toEqual([{ kind: 'shutting-down', nodeName: 'node-a' }]);
  });

  it('says nothing when a node leaves Ready WITHOUT a shutdown report — that is down, not shutting down', () => {
    // Operator report: a server being shut down was announced as "rebooting",
    // and the same notice fired for a crash, claiming a drain that never ran.
    // The down notice (fast-down-watch.ts) is the one for this case.
    const out = detectBootTransitions(
      [facts({ bootId: 'boot-A', ready: false, shuttingDown: false })],
      prev({ bootId: 'boot-A', ready: true }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('does not re-announce a shutdown already announced', () => {
    const out = detectBootTransitions(
      [facts({ bootId: 'boot-A', ready: false, shuttingDown: true })],
      prev({ bootId: 'boot-A', ready: true, rebootAnnounced: true }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('does not report shutting-down for a node that was already NotReady', () => {
    const out = detectBootTransitions(
      [facts({ bootId: 'boot-A', ready: false, shuttingDown: true })],
      prev({ bootId: 'boot-A', ready: false }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('prefers startup-complete over shutting-down when a reboot completed between ticks', () => {
    // The single-node reality: the node went down AND came back inside one tick.
    // Announcing "is shutting down" now would describe a past state as the present.
    const out = detectBootTransitions([facts()], prev({ ready: true }), NOW);
    expect(out.map((t) => t.kind)).toEqual(['startup-complete']);
  });

  it('falls back to now when the kubelet reported no Ready transition time', () => {
    const out = detectBootTransitions([facts({ readySince: null })], prev(), NOW);
    if (out[0].kind !== 'startup-complete') throw new Error('unreachable');
    expect(out[0].bootedAt).toBeNull();
    expect(out[0].downtimeMs).toBe(NOW.getTime() - new Date('2026-09-11T12:25:44Z').getTime());
  });

  // Production: a server shut down for ~21 minutes came back as "~1m 59s" —
  // measured from the last tick, which had already seen it down.
  it('measures downtime from the moment the node went down when that was seen', () => {
    const out = detectBootTransitions([facts()], prev({
      ready: false,
      observedAt: new Date('2026-09-11T12:30:00Z'),
      downSince: new Date('2026-09-11T12:11:34Z'),
    }), NOW);
    if (out[0].kind !== 'startup-complete') throw new Error('unreachable');
    expect(out[0].downtimeMs).toBe(21 * 60_000);
  });

  it('reports null downtime when the node was never observed before', () => {
    const out = detectBootTransitions([facts()], prev({ observedAt: null }), NOW);
    if (out[0].kind !== 'startup-complete') throw new Error('unreachable');
    expect(out[0].downtimeMs).toBeNull();
  });
});

describe('wentDownAt', () => {
  const now = new Date('2026-09-11T12:40:00Z');

  it('is the Ready condition\'s own transition time — the moment it left Ready', () => {
    expect(wentDownAt({ lastTransitionTime: '2026-09-11T12:11:34Z' }, now)).toEqual(new Date('2026-09-11T12:11:34Z'));
  });

  it('is now when the kubelet reported no usable time', () => {
    expect(wentDownAt(undefined, now)).toEqual(now);
    expect(wentDownAt({ lastTransitionTime: 'not a time' }, now)).toEqual(now);
  });

  it('is never later than now — a skewed clock cannot make an outage negative', () => {
    expect(wentDownAt({ lastTransitionTime: '2026-09-11T13:00:00Z' }, now)).toEqual(now);
  });
});

describe('formatDowntime', () => {
  it('renders seconds, minutes and hours', () => {
    expect(formatDowntime(45_000)).toBe('45s');
    expect(formatDowntime(410_000)).toBe('6m 50s');
    expect(formatDowntime(3_840_000)).toBe('1h 04m');
  });

  it('never renders a negative duration', () => {
    expect(formatDowntime(-5_000)).toBe('0s');
  });
});
