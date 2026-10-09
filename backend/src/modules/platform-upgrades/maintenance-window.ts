/**
 * ADR-064 §7 — the maintenance window automatic updates may act in. Pure.
 *
 * A window is a set of weekdays plus a start and end time in an IANA time zone.
 * `start` < `end` is a window within a day; `start` > `end` spans midnight and
 * belongs to the day it starts on; `start` == `end` is the whole day.
 */
import type { MaintenanceWindow } from '@insula/api-contracts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Weekday (0 = Sunday) and minutes past midnight of `now`, in the window's time zone. */
export function localTime(now: Date, timeZone: string): { readonly day: number; readonly minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = WEEKDAYS.indexOf(get('weekday') as (typeof WEEKDAYS)[number]);
  return { day: day < 0 ? 0 : day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function insideWindow(w: MaintenanceWindow, now: Date): boolean {
  const { day, minutes } = localTime(now, w.timeZone);
  const start = toMinutes(w.start);
  const end = toMinutes(w.end);
  const days = new Set(w.days);
  if (start === end) return days.has(day);
  if (start < end) return days.has(day) && minutes >= start && minutes < end;
  // Spans midnight: the evening part on a listed day, or the morning after one.
  const yesterday = (day + 6) % 7;
  return (days.has(day) && minutes >= start) || (days.has(yesterday) && minutes < end);
}

/** "Sun, Wed 02:00–05:00 (Europe/Berlin)" */
export function describeWindow(w: MaintenanceWindow): string {
  const days = [...new Set(w.days)].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(', ');
  const span = w.start === w.end ? 'all day' : `${w.start}–${w.end}`;
  return `${days} ${span} (${w.timeZone})`;
}
