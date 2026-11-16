/**
 * Words for a sending limit that is holding mail back.
 *
 * The limits are per mail domain and their windows are whole UTC hours and
 * days, so "held until" is always the next full hour or 00:00 UTC.
 */
import type { MailThrottle } from '@insula/api-contracts';
import { formatLocalInstant } from '@/lib/format-timestamp';

/**
 * When held mail goes out, in the viewer's zone with the offset named — e.g.
 * "YYYY-MM-DD 02:00 UTC+2" for the daily limit's 00:00 UTC.
 */
export function releaseLabel(iso: string | null): string {
  return iso ? formatLocalInstant(iso) : '';
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One domain: "10 messages held back until YYYY-MM-DD 02:00 UTC+2 · 2 refused today". */
export function throttleText(t: MailThrottle): string {
  const parts: string[] = [];
  if (t.heldNow > 0) parts.push(`${plural(t.heldNow, 'message', 'messages')} held back until ${releaseLabel(t.releasesAt)}`);
  if (t.refusing) parts.push('new mail refused while the queue is full');
  if (t.refusedToday > 0) parts.push(`${t.refusedToday} refused today`);
  return parts.join(' · ');
}

/** Several domains, for a one-line note: "shop.example.test: 10 messages held back until …". */
export function throttlesSummary(throttles: readonly MailThrottle[]): string | null {
  if (throttles.length === 0) return null;
  if (throttles.length === 1) return `${throttles[0].domain}: ${throttleText(throttles[0])}`;
  const held = throttles.reduce((n, t) => n + t.heldNow, 0);
  return `${throttles.length} domains at their limit · ${plural(held, 'message', 'messages')} held back`;
}

/** How the limits act on mail — the same words wherever the limits are shown. */
export const LIMITS_EXPLAINED
  = 'The limits apply to each mail domain on its own. Mail over a limit is accepted and held in the queue, '
  + 'then delivered when the window resets: the next full hour for the hourly limit, 00:00 UTC for the daily one. '
  + 'Once a domain has as many messages waiting as its daily limit, new submissions are refused with a '
  + 'temporary error and the sending program tries again later. The mail server counts every delivery '
  + 'attempt, retries included, so it can start holding mail before the counts here reach the limit.';
