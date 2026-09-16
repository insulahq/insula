import { describe, it, expect } from 'vitest';
import { coerceAutoPruneDays } from './settings.js';
import { DEFAULT_AUTO_PRUNE_DAYS, MAX_AUTO_PRUNE_DAYS } from '@insula/api-contracts';

/**
 * A corrupt or missing retention row must fall back to the default.
 *
 * The two failure directions are both silent: coercing junk to 0 turns the sweep
 * OFF, which looks exactly like "working, nothing to do"; coercing it to a tiny
 * number turns it into an aggressive sweep that deletes a record the moment it
 * dies, taking the post-mortem with it.
 */
describe('coerceAutoPruneDays', () => {
  it('defaults when the row is absent or blank', () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(coerceAutoPruneDays(v), String(v)).toBe(DEFAULT_AUTO_PRUNE_DAYS);
    }
  });

  it('accepts a valid integer, including 0 meaning disabled', () => {
    expect(coerceAutoPruneDays('0')).toBe(0);
    expect(coerceAutoPruneDays('7')).toBe(7);
    expect(coerceAutoPruneDays(String(MAX_AUTO_PRUNE_DAYS))).toBe(MAX_AUTO_PRUNE_DAYS);
    expect(coerceAutoPruneDays(' 14 ')).toBe(14);
  });

  it('defaults rather than coercing junk to 0 — which would silently disable the sweep', () => {
    for (const v of ['abc', 'NaN', 'null', '7 days', '']) {
      expect(coerceAutoPruneDays(v), v).toBe(DEFAULT_AUTO_PRUNE_DAYS);
    }
  });

  it('defaults on out-of-range and non-integer values', () => {
    for (const v of ['-1', '0.5', '1e9', String(MAX_AUTO_PRUNE_DAYS + 1)]) {
      expect(coerceAutoPruneDays(v), v).toBe(DEFAULT_AUTO_PRUNE_DAYS);
    }
  });

  it('ships a default that keeps a month of post-mortem history', () => {
    expect(DEFAULT_AUTO_PRUNE_DAYS).toBe(30);
  });
});
