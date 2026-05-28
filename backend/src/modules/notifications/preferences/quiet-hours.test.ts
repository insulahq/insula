import { describe, it, expect } from 'vitest';
import { isInQuietHours } from './quiet-hours.js';

describe('isInQuietHours', () => {
  it('returns false when either bound is unset', () => {
    expect(isInQuietHours({ quietHoursStart: null, quietHoursEnd: '07:00', timezone: 'UTC' }, new Date())).toBe(false);
    expect(isInQuietHours({ quietHoursStart: '22:00', quietHoursEnd: null, timezone: 'UTC' }, new Date())).toBe(false);
  });

  it('returns false for malformed time strings', () => {
    expect(isInQuietHours({ quietHoursStart: 'nope', quietHoursEnd: '07:00', timezone: 'UTC' }, new Date())).toBe(false);
  });

  it('returns false for zero-length window', () => {
    expect(isInQuietHours(
      { quietHoursStart: '12:00', quietHoursEnd: '12:00', timezone: 'UTC' },
      new Date('2026-01-01T12:00:00Z'),
    )).toBe(false);
  });

  it('handles same-day window (08:00 → 18:00 UTC)', () => {
    expect(isInQuietHours(
      { quietHoursStart: '08:00', quietHoursEnd: '18:00', timezone: 'UTC' },
      new Date('2026-01-01T10:00:00Z'),
    )).toBe(true);
    expect(isInQuietHours(
      { quietHoursStart: '08:00', quietHoursEnd: '18:00', timezone: 'UTC' },
      new Date('2026-01-01T19:00:00Z'),
    )).toBe(false);
  });

  it('handles wrap-around window (22:00 → 07:00 UTC)', () => {
    expect(isInQuietHours(
      { quietHoursStart: '22:00', quietHoursEnd: '07:00', timezone: 'UTC' },
      new Date('2026-01-01T23:00:00Z'),
    )).toBe(true);
    expect(isInQuietHours(
      { quietHoursStart: '22:00', quietHoursEnd: '07:00', timezone: 'UTC' },
      new Date('2026-01-01T05:00:00Z'),
    )).toBe(true);
    expect(isInQuietHours(
      { quietHoursStart: '22:00', quietHoursEnd: '07:00', timezone: 'UTC' },
      new Date('2026-01-01T12:00:00Z'),
    )).toBe(false);
  });

  it('falls back to UTC when timezone is invalid', () => {
    expect(isInQuietHours(
      { quietHoursStart: '08:00', quietHoursEnd: '18:00', timezone: 'Mars/Olympus' },
      new Date('2026-01-01T10:00:00Z'),
    )).toBe(true);
  });
});
