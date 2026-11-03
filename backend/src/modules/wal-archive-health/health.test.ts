import { describe, it, expect } from 'vitest';
import {
  assessWalArchive,
  pressurePercent,
  DEFAULT_THRESHOLDS,
  type WalArchiveSnapshot,
} from './health.js';

const GiB = 1024 ** 3;
function snap(over: Partial<WalArchiveSnapshot> = {}): WalArchiveSnapshot {
  return {
    clusterName: 'system-db',
    barmanPluginPresent: true,
    continuousArchivingHealthy: true,
    continuousArchivingConfirmed: true,
    failingSince: null,
    walBytes: 1 * GiB,
    volumeBytes: 20 * GiB,
    ...over,
  };
}

describe('pressurePercent', () => {
  it('computes pg_wal as a % of the volume', () => {
    expect(pressurePercent(10 * GiB, 20 * GiB)).toBe(50);
  });
  it('returns 0 when volume size is unknown', () => {
    expect(pressurePercent(5 * GiB, 0)).toBe(0);
  });
});

describe('assessWalArchive', () => {
  it('OK when no barman plugin (archiving off — WAL recycles)', () => {
    const a = assessWalArchive(snap({ barmanPluginPresent: false, continuousArchivingHealthy: false, walBytes: 18 * GiB }));
    expect(a.state).toBe('ok');
    expect(a.shouldAlert).toBe(false);
    expect(a.shouldTrip).toBe(false);
  });

  it('OK when plugin present and archiving healthy', () => {
    const a = assessWalArchive(snap({ continuousArchivingHealthy: true }));
    expect(a.state).toBe('ok');
    expect(a.shouldAlert).toBe(false);
    expect(a.shouldTrip).toBe(false);
  });

  it('FAILING (warning) when archiving fails and pressure is low', () => {
    const a = assessWalArchive(snap({ continuousArchivingHealthy: false, walBytes: 2 * GiB })); // 10%
    expect(a.state).toBe('failing');
    expect(a.shouldAlert).toBe(true);
    expect(a.shouldTrip).toBe(false);
    expect(a.severity).toBe('warning');
  });

  it('FAILING (error) once pressure crosses the warn threshold', () => {
    const a = assessWalArchive(snap({ continuousArchivingHealthy: false, walBytes: 11 * GiB })); // 55% ≥ 50
    expect(a.state).toBe('failing');
    expect(a.shouldAlert).toBe(true);
    expect(a.shouldTrip).toBe(false);
    expect(a.severity).toBe('error');
  });

  it('CRITICAL + TRIP once pressure crosses the trip threshold', () => {
    const a = assessWalArchive(snap({ continuousArchivingHealthy: false, walBytes: 16 * GiB })); // 80% ≥ 75
    expect(a.state).toBe('critical');
    expect(a.shouldAlert).toBe(true);
    expect(a.shouldTrip).toBe(true);
    expect(a.severity).toBe('critical');
    expect(a.reason).toMatch(/80%|trip/i);
  });

  it('does NOT trip on high pressure when archiving is HEALTHY (e.g. huge legit WAL)', () => {
    const a = assessWalArchive(snap({ continuousArchivingHealthy: true, walBytes: 18 * GiB })); // 90% but healthy
    expect(a.state).toBe('ok');
    expect(a.shouldTrip).toBe(false);
  });

  it('does NOT trip when there is no plugin even at high pressure', () => {
    const a = assessWalArchive(snap({ barmanPluginPresent: false, continuousArchivingHealthy: false, walBytes: 19 * GiB }));
    expect(a.state).toBe('ok');
    expect(a.shouldTrip).toBe(false);
  });

  it('exactly at the trip threshold trips (>=)', () => {
    const a = assessWalArchive(snap({ continuousArchivingHealthy: false, walBytes: 15 * GiB })); // exactly 75%
    expect(a.shouldTrip).toBe(true);
  });

  it('unknown volume size (0) → pressure 0 → alerts but never trips', () => {
    const a = assessWalArchive(snap({ continuousArchivingHealthy: false, walBytes: 9 * GiB, volumeBytes: 0 }));
    expect(a.state).toBe('failing');
    expect(a.shouldAlert).toBe(true);
    expect(a.shouldTrip).toBe(false);
  });

  it('honours custom thresholds', () => {
    const a = assessWalArchive(
      snap({ continuousArchivingHealthy: false, walBytes: 7 * GiB }), // 35%
      { warnPressurePct: 20, tripPressurePct: 30, alertAfterMs: 0 },
    );
    expect(a.shouldTrip).toBe(true);
  });
});

describe('assessWalArchive: a failure alerts only once it has lasted', () => {
  const NOW = Date.parse('2026-11-03T16:30:47Z');
  const failing = (since: string | null, walBytes = 2 * GiB): WalArchiveSnapshot =>
    snap({ continuousArchivingHealthy: false, failingSince: since, walBytes });

  it('holds the alert for a failure seconds old (the failover upload the retry fixed)', () => {
    const a = assessWalArchive(failing('2026-11-03T16:30:45Z'), DEFAULT_THRESHOLDS, NOW);
    expect(a.state).toBe('failing');
    expect(a.shouldAlert).toBe(false);
    expect(a.reason).toBe('WAL archiving has been failing for 0 minutes; it alerts if it still fails after 10 minutes');
  });

  it('still holds it at 9 minutes 59 seconds', () => {
    const a = assessWalArchive(failing('2026-11-03T16:20:48Z'), DEFAULT_THRESHOLDS, NOW);
    expect(a.shouldAlert).toBe(false);
  });

  it('alerts at exactly 10 minutes (>=)', () => {
    const a = assessWalArchive(failing('2026-11-03T16:20:47Z'), DEFAULT_THRESHOLDS, NOW);
    expect(a.shouldAlert).toBe(true);
    expect(a.reason).toBe('WAL archiving is failing; pg_wal is at 10% of the data volume');
  });

  it('alerts at once when the start is unknown or unreadable', () => {
    expect(assessWalArchive(failing(null), DEFAULT_THRESHOLDS, NOW).shouldAlert).toBe(true);
    expect(assessWalArchive(failing('not-a-time'), DEFAULT_THRESHOLDS, NOW).shouldAlert).toBe(true);
  });

  it('alerts at once when pg_wal is already past the warn threshold', () => {
    const a = assessWalArchive(failing('2026-11-03T16:30:45Z', 11 * GiB), DEFAULT_THRESHOLDS, NOW); // 55%
    expect(a.severity).toBe('error');
    expect(a.shouldAlert).toBe(true);
  });

  it('never delays a trip', () => {
    const a = assessWalArchive(failing('2026-11-03T16:30:45Z', 16 * GiB), DEFAULT_THRESHOLDS, NOW); // 80%
    expect(a.state).toBe('critical');
    expect(a.shouldTrip).toBe(true);
  });

  it('reads a start in the future (clock skew) as just started', () => {
    expect(assessWalArchive(failing('2026-11-03T16:35:00Z'), DEFAULT_THRESHOLDS, NOW).shouldAlert).toBe(false);
  });
});
