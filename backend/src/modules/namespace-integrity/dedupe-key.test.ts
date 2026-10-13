import { describe, expect, it } from 'vitest';
import { integrityDedupeKey } from './service.js';

/**
 * A day's sweeps announce each different thing they did to a tenant once —
 * not only the first thing.
 */
describe('the integrity notification\'s dedupe key', () => {
  const noon = new Date('2026-10-12T12:00:00Z');
  const key = (repaired: string[], errors: string[] = [], at = noon, tenant = 't-1') => integrityDedupeKey(tenant, repaired, errors, at);

  it('the same outcome on the same day is one notification — a repair that keeps failing says so once, not every half hour', () => {
    expect(key(['pvc_missing'])).toBe(key(['pvc_missing'], [], new Date('2026-10-12T23:59:00Z')));
    expect(key([], ['pvc_missing: the API server timed out'])).toBe(key([], ['pvc_missing: quota exceeded (request 4711)']));
  });

  it('a different repair on the same day is announced: the leftover volume removed in the afternoon, after a quota repaired in the morning', () => {
    expect(key(['archived_volume_unused'])).not.toBe(key(['resource_quota_missing']));
  });

  it('a repair that failed and the same repair that worked are different outcomes', () => {
    expect(key(['pvc_missing'])).not.toBe(key([], ['pvc_missing: boom']));
  });

  it('the order the sweep found things in does not matter, nor does finding one twice', () => {
    expect(key(['a', 'b'], ['d: x', 'c: y'])).toBe(key(['b', 'a', 'a'], ['c: z', 'd: w']));
  });

  it('the next day, and another tenant, are told again', () => {
    expect(key(['pvc_missing'])).not.toBe(key(['pvc_missing'], [], new Date('2026-10-13T00:00:01Z')));
    expect(key(['pvc_missing'])).not.toBe(key(['pvc_missing'], [], noon, 't-2'));
  });

  it('reads as what it is', () => {
    expect(key(['resource_quota_missing', 'archived_volume_unused'], ['pvc_missing: boom']))
      .toBe('ns-integrity:t-1:2026-10-12:+archived_volume_unused,+resource_quota_missing,-pvc_missing');
  });
});
