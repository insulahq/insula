import { describe, it, expect } from 'vitest';
import { describeWindow, insideWindow, localTime } from './maintenance-window.js';

const at = (iso: string) => new Date(iso);

describe('maintenance window', () => {
  const sun2to5utc = { days: [0], start: '02:00', end: '05:00', timeZone: 'UTC' };

  it('inside a same-day window, by weekday and time', () => {
    expect(insideWindow(sun2to5utc, at('2026-10-11T02:00:00Z'))).toBe(true); // Sunday 02:00
    expect(insideWindow(sun2to5utc, at('2026-10-11T04:59:00Z'))).toBe(true);
    expect(insideWindow(sun2to5utc, at('2026-10-11T05:00:00Z'))).toBe(false); // end is exclusive
    expect(insideWindow(sun2to5utc, at('2026-10-11T01:59:00Z'))).toBe(false);
    expect(insideWindow(sun2to5utc, at('2026-10-12T03:00:00Z'))).toBe(false); // Monday
  });

  it('judges in the window\'s time zone, not the server\'s', () => {
    const berlin = { days: [0], start: '02:00', end: '05:00', timeZone: 'Europe/Berlin' };
    // Sunday 03:00 in Berlin (CEST, UTC+2) is Sunday 01:00 UTC.
    expect(insideWindow(berlin, at('2026-10-11T01:00:00Z'))).toBe(true);
    expect(insideWindow(berlin, at('2026-10-11T03:30:00Z'))).toBe(false);
    expect(localTime(at('2026-10-11T01:00:00Z'), 'Europe/Berlin')).toEqual({ day: 0, minutes: 180 });
  });

  it('a window spanning midnight belongs to the day it starts on', () => {
    const satNight = { days: [6], start: '23:00', end: '02:00', timeZone: 'UTC' };
    expect(insideWindow(satNight, at('2026-10-10T23:30:00Z'))).toBe(true); // Saturday 23:30
    expect(insideWindow(satNight, at('2026-10-11T01:30:00Z'))).toBe(true); // Sunday 01:30 — Saturday's window
    expect(insideWindow(satNight, at('2026-10-11T23:30:00Z'))).toBe(false); // Sunday night is not listed
    expect(insideWindow(satNight, at('2026-10-10T01:30:00Z'))).toBe(false); // Saturday morning — Friday not listed
  });

  it('start == end is the whole listed day', () => {
    const wed = { days: [3], start: '00:00', end: '00:00', timeZone: 'UTC' };
    expect(insideWindow(wed, at('2026-10-14T13:00:00Z'))).toBe(true);
    expect(insideWindow(wed, at('2026-10-15T13:00:00Z'))).toBe(false);
  });

  it('describes itself for the status line', () => {
    expect(describeWindow({ days: [3, 0], start: '02:00', end: '05:00', timeZone: 'Europe/Berlin' })).toBe('Sun, Wed 02:00–05:00 (Europe/Berlin)');
    expect(describeWindow({ days: [3], start: '00:00', end: '00:00', timeZone: 'UTC' })).toBe('Wed all day (UTC)');
  });

  it('across daylight-saving changes it follows the wall clock of the zone', () => {
    const berlin = { days: [0], start: '02:00', end: '03:00', timeZone: 'Europe/Berlin' };
    // Autumn change in Berlin: clocks go back 03:00 → 02:00, so 02:30 happens twice — both are inside.
    expect(insideWindow(berlin, at('2026-10-25T00:30:00Z'))).toBe(true); // 02:30 CEST
    expect(insideWindow(berlin, at('2026-10-25T01:30:00Z'))).toBe(true); // 02:30 CET
    expect(insideWindow(berlin, at('2026-10-25T02:30:00Z'))).toBe(false); // 03:30 CET
    // Spring change in Berlin: clocks go forward 02:00 → 03:00 — the window's hour does not exist.
    expect(insideWindow(berlin, at('2026-03-29T00:59:00Z'))).toBe(false); // 01:59 CET
    expect(insideWindow(berlin, at('2026-03-29T01:00:00Z'))).toBe(false); // 03:00 CEST
  });
});

