import { describe, it, expect } from 'vitest';
import { freshStartSentinelIsStale } from './migration.js';

// The sentinel format is written by the stalwart deployment's init
// container: `$(date -Iseconds) reason=<no-restic|allow-restore-not-set>`
// — see k8s/base/stalwart-mail/stalwart/deployment.yaml.
describe('mail-admin freshStartSentinelIsStale', () => {
  const runStartedAt = new Date('2026-06-11T22:57:00Z');

  it('STALE: bootstrap-era sentinel hours before the run (the 2026-06-11 staging false-positive)', () => {
    // Verbatim shape from the live incident: bootstrap wrote it at
    // 14:33, the 22:57 migration carried it along in the PVC copy.
    expect(freshStartSentinelIsStale('2026-06-11T14:33:25+00:00 reason=no-restic\n', runStartedAt)).toBe(true);
  });

  it('NOT stale: sentinel written during the run (real silent-loss case)', () => {
    expect(freshStartSentinelIsStale('2026-06-11T22:58:10+00:00 reason=no-restic', runStartedAt)).toBe(false);
  });

  it('NOT stale: sentinel inside the 60s clock-skew grace before run start', () => {
    expect(freshStartSentinelIsStale('2026-06-11T22:56:30+00:00 reason=no-restic', runStartedAt)).toBe(false);
  });

  it('STALE: sentinel just beyond the grace window', () => {
    expect(freshStartSentinelIsStale('2026-06-11T22:55:30+00:00 reason=no-restic', runStartedAt)).toBe(true);
  });

  it('NOT stale (fail closed): unparseable timestamp', () => {
    expect(freshStartSentinelIsStale('reason unrecorded', runStartedAt)).toBe(false);
    expect(freshStartSentinelIsStale('', runStartedAt)).toBe(false);
    expect(freshStartSentinelIsStale('garbage reason=no-restic', runStartedAt)).toBe(false);
  });

  it('handles the allow-restore-not-set variant', () => {
    expect(freshStartSentinelIsStale('2026-06-10T08:00:00+00:00 reason=allow-restore-not-set', runStartedAt)).toBe(true);
  });
});
