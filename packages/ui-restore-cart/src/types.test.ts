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

  it('formats KB/MB/GB with one decimal', () => {
    expect(formatBundleBytes(1024)).toBe('1.0 KB');
    expect(formatBundleBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBundleBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });

  it('caps at TB (does not overflow units array)', () => {
    expect(formatBundleBytes(5 * 1024 ** 5)).toMatch(/TB$/);
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
