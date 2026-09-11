import { describe, it, expect } from 'vitest';
import {
  detectBootTransitions,
  formatDowntime,
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
  };
}

function prev(o: Partial<PrevBootState> = {}): ReadonlyMap<string, PrevBootState> {
  return new Map([['node-a', {
    bootId: o.bootId === undefined ? 'boot-A' : o.bootId,
    ready: o.ready ?? true,
    observedAt: o.observedAt === undefined ? new Date('2026-09-11T12:25:44Z') : o.observedAt,
    rebootAnnounced: o.rebootAnnounced ?? false,
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
    // 12:25:44 last seen -> 12:32:34 Ready = 6m50s, the real 2026-08-27 figure.
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

  // ── rebooting ──

  it('reports rebooting when a node leaves Ready on the SAME boot', () => {
    const out = detectBootTransitions(
      [facts({ bootId: 'boot-A', ready: false })],
      prev({ bootId: 'boot-A', ready: true }),
      NOW,
    );
    expect(out).toEqual([{ kind: 'rebooting', nodeName: 'node-a' }]);
  });

  it('does not re-announce a shutdown already announced', () => {
    const out = detectBootTransitions(
      [facts({ bootId: 'boot-A', ready: false })],
      prev({ bootId: 'boot-A', ready: true, rebootAnnounced: true }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('does not report rebooting for a node that was already NotReady', () => {
    const out = detectBootTransitions(
      [facts({ bootId: 'boot-A', ready: false })],
      prev({ bootId: 'boot-A', ready: false }),
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('prefers startup-complete over rebooting when a reboot completed between ticks', () => {
    // The single-node reality: the node went down AND came back inside one tick.
    // Announcing "is rebooting" now would describe a past state as the present.
    const out = detectBootTransitions([facts()], prev({ ready: true }), NOW);
    expect(out.map((t) => t.kind)).toEqual(['startup-complete']);
  });

  it('falls back to now when the kubelet reported no Ready transition time', () => {
    const out = detectBootTransitions([facts({ readySince: null })], prev(), NOW);
    if (out[0].kind !== 'startup-complete') throw new Error('unreachable');
    expect(out[0].bootedAt).toBeNull();
    expect(out[0].downtimeMs).toBe(NOW.getTime() - new Date('2026-09-11T12:25:44Z').getTime());
  });

  it('reports null downtime when the node was never observed before', () => {
    const out = detectBootTransitions([facts()], prev({ observedAt: null }), NOW);
    if (out[0].kind !== 'startup-complete') throw new Error('unreachable');
    expect(out[0].downtimeMs).toBeNull();
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
