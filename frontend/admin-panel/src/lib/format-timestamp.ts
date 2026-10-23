/**
 * Absolute timestamps for event tables (WAF events, auto-ban runs, WAF
 * exclusions). They read in the viewer's own zone — the zone the range
 * filters already take their input in — and the column header names it,
 * so a row and the filter that found it agree.
 */
import { browserTimeZone } from './format-traffic';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `2026-10-23 14:05` (or `…:09` with `seconds`): sortable and fixed-width.
 * Viewer's zone by default; `utc` reads the UTC fields instead.
 */
export function formatTimestamp(at: Date, { seconds = false, utc = false } = {}): string {
  const [y, mo, d, h, mi, s] = utc
    ? [at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()]
    : [at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()];
  const minute = `${y}-${pad(mo + 1)}-${pad(d)} ${pad(h)}:${pad(mi)}`;
  return seconds ? `${minute}:${pad(s)}` : minute;
}

/** Tooltip for a column header whose times are in the viewer's zone. */
export function localZoneTitle(): string {
  return `Shown in your browser's time zone (${browserTimeZone()}). Hover a time to see it in UTC.`;
}
