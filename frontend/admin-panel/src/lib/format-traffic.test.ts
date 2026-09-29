import { describe, it, expect } from 'vitest';
import {
  formatTrafficRate, formatTrafficTotal, formatTrafficVolume, utcOffsetLabel, formatAxisTick,
} from './format-traffic';

describe('formatTrafficRate', () => {
  it('scales bytes decimally, as bandwidth is billed', () => {
    // 1e9 B/s is 1 GB/s, not 0.93 GiB/s — the allowance is decimal.
    expect(formatTrafficRate(1e9, 'bytes')).toBe('1.00 GB/s');
    expect(formatTrafficRate(1.5e6, 'bytes')).toBe('1.50 MB/s');
    expect(formatTrafficRate(950, 'bytes')).toBe('950 B/s');
  });
  it('renders a measured zero as zero, and an unmeasured gap as a dash', () => {
    expect(formatTrafficRate(0, 'bytes')).toBe('0 B/s');
    expect(formatTrafficRate(null, 'bytes')).toBe('—');
  });
  it('formats requests and latency in their own units', () => {
    expect(formatTrafficRate(1234, 'requests')).toBe('1.2k req/s');
    expect(formatTrafficRate(42.37, 'milliseconds')).toBe('42.4 ms');
    expect(formatTrafficRate(338.7, 'milliseconds')).toBe('339 ms');
  });
});

describe('formatTrafficTotal', () => {
  it('integrates a rate over the step', () => {
    expect(formatTrafficTotal(1e6, 'bytes', 3600)).toBe('3.60 GB');
  });
  it('refuses to invent a total latency', () => {
    // Summing an average over an hour would produce a number with no meaning.
    expect(formatTrafficTotal(50, 'milliseconds', 3600)).toBe('50.0 ms');
  });
});

describe('formatTrafficVolume', () => {
  it('formats an already-integrated total', () => {
    expect(formatTrafficVolume(17.4e9, 'bytes')).toBe('17.4 GB');
    expect(formatTrafficVolume(null, 'bytes')).toBe('—');
  });
});

describe('utcOffsetLabel', () => {
  it('names the zero offset UTC rather than UTC+0', () => {
    const d = new Date();
    const spy = () => 0;
    const orig = Date.prototype.getTimezoneOffset;
    // eslint-disable-next-line no-extend-native
    Date.prototype.getTimezoneOffset = spy as never;
    try { expect(utcOffsetLabel(d)).toBe('UTC'); } finally { Date.prototype.getTimezoneOffset = orig; }
  });
  it('handles a half-hour offset', () => {
    const orig = Date.prototype.getTimezoneOffset;
    // eslint-disable-next-line no-extend-native
    Date.prototype.getTimezoneOffset = (() => -330) as never; // India, +5:30
    try { expect(utcOffsetLabel(new Date())).toBe('UTC+5:30'); } finally { Date.prototype.getTimezoneOffset = orig; }
  });
});

describe('formatAxisTick', () => {
  it('drops the time when the step is a whole day', () => {
    const tick = formatAxisTick('2026-09-29T00:00:00.000Z', 86_400);
    expect(tick).not.toMatch(/\d{2}:\d{2}/);
  });
});
