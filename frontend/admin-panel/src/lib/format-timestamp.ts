/**
 * Absolute timestamps for event tables (WAF events, auto-ban runs, WAF
 * exclusions, backups, audit events). They read in the viewer's own zone —
 * the zone the range filters already take their input in — and the column
 * header names it, so a row and the filter that found it agree.
 */
import { browserTimeZone, utcOffsetLabel } from './format-traffic';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export interface TimestampOptions {
  readonly seconds?: boolean;
  readonly dateOnly?: boolean;
  readonly utc?: boolean;
}

/**
 * `YYYY-MM-DD HH:MM` (or `…:SS` with `seconds`, or just the date with
 * `dateOnly`): sortable and fixed-width. Viewer's zone by default; `utc`
 * reads the UTC fields instead.
 */
export function formatTimestamp(at: Date, { seconds = false, dateOnly = false, utc = false }: TimestampOptions = {}): string {
  const [y, mo, d, h, mi, s] = utc
    ? [at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()]
    : [at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()];
  const date = `${y}-${pad(mo + 1)}-${pad(d)}`;
  if (dateOnly) return date;
  const minute = `${date} ${pad(h)}:${pad(mi)}`;
  return seconds ? `${minute}:${pad(s)}` : minute;
}

/**
 * An instant as plain text in the viewer's zone, naming the offset — for
 * prose and labels with no column header to name it. A date carries no offset.
 */
export function formatLocalInstant(iso: string | null | undefined, { seconds = false, dateOnly = false }: TimestampOptions = {}): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  const local = formatTimestamp(at, { seconds, dateOnly });
  return dateOnly ? local : `${local} ${utcOffsetLabel(at)}`;
}

/** Tooltip for a column header whose times are in the viewer's zone. */
export function localZoneTitle(): string {
  return `Shown in your browser's time zone (${browserTimeZone()}). Hover a time to see it in UTC.`;
}
