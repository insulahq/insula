import { describe, it, expect } from 'vitest';
import { formatSloValue, SLO_RULES } from './rules.js';

describe('formatSloValue', () => {
  it('renders a ratio as a percentage (the reported raw-float bug)', () => {
    expect(formatSloValue(0.03865979381443299, 'ratio')).toBe('3.87%');
    expect(formatSloValue(0.005, 'ratio')).toBe('0.50%');
  });

  it('renders seconds as a human duration, incl. sub-second ms', () => {
    expect(formatSloValue(0.62, 'seconds')).toBe('620ms');
    expect(formatSloValue(45, 'seconds')).toBe('45s');
    expect(formatSloValue(120, 'seconds')).toBe('2m');
    expect(formatSloValue(7200, 'seconds')).toBe('2.0h');
    expect(formatSloValue(93600, 'seconds')).toBe('1.1d');
  });

  it('renders a NEGATIVE duration readably (already-expired certificate)', () => {
    // cert-expiry emits `expiration - now`, which is negative once expired.
    expect(formatSloValue(-2 * 86400, 'seconds')).toBe('-2.0d');
    expect(formatSloValue(-90 * 86400, 'seconds')).toBe('-90.0d');
    expect(formatSloValue(-0.5, 'seconds')).toBe('-500ms');
  });

  it('renders non-finite values as a placeholder, never "NaN"/"Infinity"', () => {
    expect(formatSloValue(NaN, 'ratio')).toBe('n/a');
    expect(formatSloValue(Infinity, 'seconds')).toBe('n/a');
    expect(formatSloValue(-Infinity, 'count')).toBe('n/a');
  });

  it('renders counts as integers (default unit)', () => {
    expect(formatSloValue(3)).toBe('3');
    expect(formatSloValue(3, 'count')).toBe('3');
    expect(formatSloValue(2.5, 'count')).toBe('2.50');
  });

  it('never emits a bare long float for any rule unit', () => {
    for (const rule of SLO_RULES) {
      const out = formatSloValue(0.03865979381443299, rule.unit);
      expect(out).not.toBe('0.03865979381443299');
      expect(out.length).toBeLessThan(12);
    }
  });
});
