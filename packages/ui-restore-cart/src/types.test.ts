import { describe, it, expect } from 'vitest';
import { formatBundleBytes, TERMINAL_BUNDLE_STATES } from './types.js';

describe('formatBundleBytes', () => {
  it('returns "-" for null/undefined/zero', () => {
    expect(formatBundleBytes(0)).toBe('-');
    expect(formatBundleBytes(null)).toBe('-');
    expect(formatBundleBytes(undefined)).toBe('-');
  });

  it('formats bytes without decimals', () => {
    expect(formatBundleBytes(512)).toBe('512 B');
  });

  it('formats kB/MB/GB decimally with one decimal, as the admin panel counts backups', () => {
    expect(formatBundleBytes(1000)).toBe('1.0 kB');
    expect(formatBundleBytes(1.5e6)).toBe('1.5 MB');
    // 2 GiB is 2.1 GB — it printed "2.0 GB" when this divided by 1024.
    expect(formatBundleBytes(2 * 1024 ** 3)).toBe('2.1 GB');
    expect(formatBundleBytes(999_960)).toBe('1.0 MB');
  });

  it('rounds before choosing the unit, and has no figure for infinity', () => {
    expect(formatBundleBytes(999.6)).toBe('1.0 kB');
    expect(formatBundleBytes(Number.POSITIVE_INFINITY)).toBe('-');
  });

  it('caps at TB (does not overflow units array)', () => {
    expect(formatBundleBytes(5e15)).toBe('5000.0 TB');
  });
});

describe('TERMINAL_BUNDLE_STATES', () => {
  it('contains exactly completed, partial, failed', () => {
    expect(TERMINAL_BUNDLE_STATES.has('completed')).toBe(true);
    expect(TERMINAL_BUNDLE_STATES.has('partial')).toBe(true);
    expect(TERMINAL_BUNDLE_STATES.has('failed')).toBe(true);
    expect(TERMINAL_BUNDLE_STATES.has('pending')).toBe(false);
    expect(TERMINAL_BUNDLE_STATES.has('running')).toBe(false);
  });
});
