import { describe, expect, it } from 'vitest';
import {
  EVICTION_CRITICAL_THRESHOLD,
  EVICTION_WARNING_THRESHOLD,
  DISK_USED_PCT_CRITICAL,
  DISK_USED_PCT_WARNING,
  buildEntry,
  computeClusterBaseline,
  decideHealthNotification,
  lastAnnouncedSeverity,
  missingDriversFor,
  overallSeverity,
  severityFor,
  shouldNotify,
  type NodeFacts,
} from './service.js';

const HEALTHY: NodeFacts = {
  name: 'staging1',
  ready: true,
  diskPressure: false,
  memoryPressure: false,
  pidPressure: false,
  csiDrivers: ['csi.tigera.io', 'driver.longhorn.io'],
  evictionsLastHour: 0,
  diskUsedPct: 30,
};

describe('computeClusterBaseline', () => {
  it('returns drivers present on > 50% of nodes', () => {
    const nodes = [
      { csiDrivers: ['csi.tigera.io', 'driver.longhorn.io'] },
      { csiDrivers: ['csi.tigera.io', 'driver.longhorn.io'] },
      { csiDrivers: ['csi.tigera.io', 'driver.longhorn.io'] },
      { csiDrivers: ['csi.tigera.io'] }, // worker missing longhorn
    ];
    const baseline = computeClusterBaseline(nodes);
    expect(baseline.expectedDrivers).toEqual(['csi.tigera.io', 'driver.longhorn.io']);
  });

  it('drops drivers tied at 50%', () => {
    // Avoid false-positives on small clusters with split driver state.
    const nodes = [
      { csiDrivers: ['a', 'b'] },
      { csiDrivers: ['a'] },
    ];
    expect(computeClusterBaseline(nodes).expectedDrivers).toEqual(['a']);
  });

  it('handles empty / single-node clusters', () => {
    expect(computeClusterBaseline([]).expectedDrivers).toEqual([]);
    expect(computeClusterBaseline([{ csiDrivers: ['a'] }]).expectedDrivers).toEqual(['a']);
  });

  it('output is sorted for stable diffing', () => {
    const nodes = [{ csiDrivers: ['z', 'a', 'm'] }];
    expect(computeClusterBaseline(nodes).expectedDrivers).toEqual(['a', 'm', 'z']);
  });
});

describe('missingDriversFor', () => {
  it('returns drivers in baseline missing on this node', () => {
    const baseline = { expectedDrivers: ['csi.tigera.io', 'driver.longhorn.io'] };
    expect(missingDriversFor({ csiDrivers: ['csi.tigera.io'] }, baseline))
      .toEqual(['driver.longhorn.io']);
  });

  it('empty when in line', () => {
    const baseline = { expectedDrivers: ['a', 'b'] };
    expect(missingDriversFor({ csiDrivers: ['a', 'b'] }, baseline)).toEqual([]);
  });

  it('does NOT flag drivers this node has but baseline does not', () => {
    // A node with EXTRA drivers (e.g. specialised hardware CSI) is fine.
    const baseline = { expectedDrivers: ['a'] };
    expect(missingDriversFor({ csiDrivers: ['a', 'b'] }, baseline)).toEqual([]);
  });
});

describe('severityFor', () => {
  const baseline = { expectedDrivers: ['csi.tigera.io', 'driver.longhorn.io'] };

  it('healthy node → normal', () => {
    expect(severityFor(HEALTHY, baseline).severity).toBe('normal');
  });

  it('not Ready → critical', () => {
    expect(severityFor({ ...HEALTHY, ready: false }, baseline).severity).toBe('critical');
  });

  it('disk pressure → critical', () => {
    expect(severityFor({ ...HEALTHY, diskPressure: true }, baseline).severity).toBe('critical');
  });

  it('missing CSI driver → critical (the 2026-05-08 worker case)', () => {
    const result = severityFor(
      { ...HEALTHY, csiDrivers: ['csi.tigera.io'] },
      baseline,
    );
    expect(result.severity).toBe('critical');
    expect(result.missingDrivers).toEqual(['driver.longhorn.io']);
  });

  it(`evictions ≥ ${EVICTION_CRITICAL_THRESHOLD}/hr → critical`, () => {
    expect(severityFor(
      { ...HEALTHY, evictionsLastHour: EVICTION_CRITICAL_THRESHOLD },
      baseline,
    ).severity).toBe('critical');
  });

  it(`evictions ${EVICTION_WARNING_THRESHOLD}-${EVICTION_CRITICAL_THRESHOLD - 1}/hr → warning`, () => {
    expect(severityFor(
      { ...HEALTHY, evictionsLastHour: EVICTION_WARNING_THRESHOLD },
      baseline,
    ).severity).toBe('warning');
  });

  it(`diskUsedPct ≥ ${DISK_USED_PCT_CRITICAL} → critical (early warning before kubelet fires DiskPressure)`, () => {
    expect(severityFor(
      { ...HEALTHY, diskUsedPct: DISK_USED_PCT_CRITICAL },
      baseline,
    ).severity).toBe('critical');
  });

  it(`diskUsedPct ${DISK_USED_PCT_WARNING}-${DISK_USED_PCT_CRITICAL - 1} → warning`, () => {
    expect(severityFor(
      { ...HEALTHY, diskUsedPct: DISK_USED_PCT_WARNING },
      baseline,
    ).severity).toBe('warning');
  });

  it('null diskUsedPct does NOT trigger any disk severity', () => {
    expect(severityFor(
      { ...HEALTHY, diskUsedPct: null, evictionsLastHour: 0 },
      baseline,
    ).severity).toBe('normal');
  });

  it('precedence: not-Ready beats everything else', () => {
    const result = severityFor(
      {
        ...HEALTHY,
        ready: false,
        diskPressure: true,
        evictionsLastHour: EVICTION_CRITICAL_THRESHOLD + 5,
      },
      baseline,
    );
    expect(result.severity).toBe('critical');
  });
});

describe('buildEntry', () => {
  it('returns api-contract shape with all fields', () => {
    const baseline = { expectedDrivers: ['driver.longhorn.io'] };
    const facts: NodeFacts = {
      ...HEALTHY,
      name: 'worker',
      csiDrivers: ['csi.tigera.io'], // missing longhorn
    };
    const observedAt = new Date('2026-05-08T16:30:00Z');
    const entry = buildEntry(facts, baseline, observedAt);
    expect(entry).toEqual({
      name: 'worker',
      ready: true,
      pressures: [],
      csiDriversPresent: 1,
      csiDriversExpected: 1,
      csiDriversMissing: ['driver.longhorn.io'],
      evictionsLastHour: 0,
      diskUsedPct: 30,
      severity: 'critical',
      observedAt: '2026-05-08T16:30:00.000Z',
    });
  });

  it('multiple pressures land in the array in canonical order', () => {
    const baseline = { expectedDrivers: [] };
    const entry = buildEntry(
      { ...HEALTHY, diskPressure: true, memoryPressure: true, pidPressure: true },
      baseline,
      new Date(),
    );
    expect(entry.pressures).toEqual(['disk', 'memory', 'pid']);
  });
});

describe('overallSeverity', () => {
  it('critical wins', () => {
    expect(overallSeverity([
      { severity: 'normal' } as never,
      { severity: 'warning' } as never,
      { severity: 'critical' } as never,
    ])).toBe('critical');
  });

  it('warning when no critical', () => {
    expect(overallSeverity([
      { severity: 'normal' } as never,
      { severity: 'warning' } as never,
    ])).toBe('warning');
  });

  it('normal on empty', () => {
    expect(overallSeverity([])).toBe('normal');
  });
});

describe('shouldNotify', () => {
  const now = new Date('2026-05-08T16:30:00Z');

  it('transition normal → critical fires', () => {
    expect(shouldNotify({
      newSeverity: 'critical', prevSeverity: 'normal',
      lastNotifiedAt: null, now,
    })).toBe(true);
  });

  it('transition critical → normal fires (recovery)', () => {
    expect(shouldNotify({
      newSeverity: 'normal', prevSeverity: 'critical',
      lastNotifiedAt: now, now,
    })).toBe(true);
  });

  it('same critical severity within 24h does NOT re-fire', () => {
    expect(shouldNotify({
      newSeverity: 'critical', prevSeverity: 'critical',
      lastNotifiedAt: new Date(now.getTime() - 23 * 60 * 60 * 1000),
      now,
    })).toBe(false);
  });

  it('same critical severity after 24h re-fires', () => {
    expect(shouldNotify({
      newSeverity: 'critical', prevSeverity: 'critical',
      lastNotifiedAt: new Date(now.getTime() - 25 * 60 * 60 * 1000),
      now,
    })).toBe(true);
  });

  it('persistent normal does not fire', () => {
    expect(shouldNotify({
      newSeverity: 'normal', prevSeverity: 'normal',
      lastNotifiedAt: null, now,
    })).toBe(false);
  });
});

// Join grace window (join-grace.ts). The decision is driven tick by tick the
// way the reconciler drives it: persist what it returns, feed it back in.
describe('decideHealthNotification — join grace', () => {
  const H = 60 * 60 * 1000;
  const t0 = new Date('2026-10-01T12:00:00Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it('notifies nothing while the node is joining and records the episode as unannounced', () => {
    const d = decideHealthNotification({ newSeverity: 'critical', prev: undefined, suppressed: true, now: t0 });
    expect(d).toEqual({ notify: false, prevSeverityForCopy: 'normal', lastNotifiedAt: null });
  });

  it('fires on the first tick after the window when the node is STILL unhealthy — the alert is late, not lost', () => {
    let prev: { severity: 'critical'; lastNotifiedAt: Date | null } | undefined;
    for (let m = 0; m < 30; m += 5) {
      const d = decideHealthNotification({ newSeverity: 'critical', prev, suppressed: true, now: at(m * 60_000) });
      expect(d.notify).toBe(false);
      prev = { severity: 'critical', lastNotifiedAt: d.lastNotifiedAt };
    }
    const after = decideHealthNotification({ newSeverity: 'critical', prev, suppressed: false, now: at(30 * 60_000) });
    expect(after.notify).toBe(true);
    // Copy reads "flagged CRITICAL", not "still CRITICAL": nobody was told yet.
    expect(after.prevSeverityForCopy).toBe('normal');
    expect(after.lastNotifiedAt).toEqual(at(30 * 60_000));
  });

  it('sends no "recovered" for a problem that resolved inside the window', () => {
    const during = decideHealthNotification({ newSeverity: 'critical', prev: undefined, suppressed: true, now: t0 });
    const after = decideHealthNotification({
      newSeverity: 'normal',
      prev: { severity: 'critical', lastNotifiedAt: during.lastNotifiedAt },
      suppressed: false,
      now: at(H),
    });
    expect(after.notify).toBe(false);
  });

  it('never erases what the operator was already told — a known-bad node keeps the normal rules', () => {
    // E.g. an established, announced-CRITICAL node that a fresh
    // ClusterPendingPeer now matches because it is being re-bootstrapped.
    const announced = { severity: 'critical' as const, lastNotifiedAt: at(-2 * H) };
    const recovered = decideHealthNotification({ newSeverity: 'normal', prev: announced, suppressed: true, now: t0 });
    expect(recovered).toEqual({ notify: true, prevSeverityForCopy: 'critical', lastNotifiedAt: t0 });
    const still = decideHealthNotification({ newSeverity: 'critical', prev: announced, suppressed: true, now: t0 });
    expect(still).toEqual({ notify: false, prevSeverityForCopy: 'critical', lastNotifiedAt: at(-2 * H) });
  });

  it('still holds news for a node whose last announcement was a recovery', () => {
    const d = decideHealthNotification({
      newSeverity: 'critical',
      prev: { severity: 'normal', lastNotifiedAt: at(-2 * H) },
      suppressed: true,
      now: t0,
    });
    expect(d).toEqual({ notify: false, prevSeverityForCopy: 'normal', lastNotifiedAt: null });
  });

  it('leaves the normal rules untouched outside a window', () => {
    const announced = { severity: 'critical' as const, lastNotifiedAt: at(-H) };
    expect(decideHealthNotification({ newSeverity: 'critical', prev: announced, suppressed: false, now: t0 }).notify)
      .toBe(false);
    expect(decideHealthNotification({ newSeverity: 'critical', prev: announced, suppressed: false, now: at(24 * H) }).notify)
      .toBe(true);
    const recovered = decideHealthNotification({ newSeverity: 'normal', prev: announced, suppressed: false, now: t0 });
    expect(recovered).toEqual({ notify: true, prevSeverityForCopy: 'critical', lastNotifiedAt: t0 });
    expect(decideHealthNotification({ newSeverity: 'critical', prev: undefined, suppressed: false, now: t0 }).notify)
      .toBe(true);
  });

  it('reads an unannounced row as "the operator was told: normal"', () => {
    expect(lastAnnouncedSeverity(undefined)).toBe('normal');
    expect(lastAnnouncedSeverity({ severity: 'warning', lastNotifiedAt: null })).toBe('normal');
    expect(lastAnnouncedSeverity({ severity: 'warning', lastNotifiedAt: t0 })).toBe('warning');
  });
});
