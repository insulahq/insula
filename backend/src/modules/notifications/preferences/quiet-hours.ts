/**
 * Quiet hours evaluation.
 *
 * Returns true when the user's local time is within their configured
 * window. Window wrap-around (e.g. 22:00 → 07:00) is supported by
 * comparing minutes-of-day arithmetic.
 *
 * Critical-severity messages bypass quiet hours — that decision is made
 * by the dispatcher; this helper only reports the window state.
 */
import type { UserNotificationSettingsResponse } from '@k8s-hosting/api-contracts';

function parseHM(hm: string): number | null {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(hm);
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const min = Number.parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Best-effort conversion of `now` into the user's tz (or process tz if
 * unset). Returns minutes-of-day (0..1439).
 *
 * We deliberately avoid pulling in luxon/date-fns-tz — the formatToParts
 * approach with Intl is built-in and accurate enough for hour-window
 * matching.
 */
function minutesOfDayInTimezone(now: Date, timezone: string | null): number {
  const tz = timezone ?? 'UTC';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const h = Number.parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const m = Number.parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    // Intl returns "24" for midnight in some locales; normalise.
    const hourNorm = h === 24 ? 0 : h;
    return hourNorm * 60 + m;
  } catch {
    // Unknown timezone → fall back to UTC. Avoids a single bad row
    // taking down the dispatcher for everybody.
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/**
 * Returns true when `now` falls within the user's quiet-hours window.
 * Returns false when either bound is unset.
 *
 * `now` parameter is overrideable for deterministic testing.
 */
export function isInQuietHours(
  settings: Pick<UserNotificationSettingsResponse, 'quietHoursStart' | 'quietHoursEnd' | 'timezone'>,
  now: Date = new Date(),
): boolean {
  if (!settings.quietHoursStart || !settings.quietHoursEnd) return false;
  const start = parseHM(settings.quietHoursStart);
  const end = parseHM(settings.quietHoursEnd);
  if (start === null || end === null) return false;

  const cur = minutesOfDayInTimezone(now, settings.timezone);
  if (start === end) return false; // zero-length window
  if (start < end) {
    return cur >= start && cur < end;
  }
  // Wrap-around (22:00 → 07:00)
  return cur >= start || cur < end;
}
