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
      { warnPressurePct: 20, tripPressurePct: 30 },
    );
    expect(a.shouldTrip).toBe(true);
  });
});
