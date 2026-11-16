/**
 * Words for a sending limit that is holding a domain's mail back — shared by
 * the dashboard's warning card and Email → Statistics, so both say the same.
 *
 * The limits apply to each mail domain on its own, and their windows are whole
 * UTC hours and days: held mail goes out at the next full hour or 00:00 UTC.
 */
import type { MailThrottle } from '@insula/api-contracts';
import { formatLocalInstant } from '@/lib/format-timestamp';

/** Email → Statistics with this domain picked; without a pick for a domain that only relays. */
export function statisticsPath(emailDomainId: string | null): string {
  return emailDomainId ? `/email/statistics?emailDomain=${encodeURIComponent(emailDomainId)}` : '/email/statistics';
}

/**
 * When held mail goes out, in the viewer's zone with the offset named — e.g.
 * "YYYY-MM-DD 02:00 UTC+2" for the daily limit's 00:00 UTC.
 */
export function releaseLabel(iso: string | null): string {
  return iso ? formatLocalInstant(iso) : '';
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "9 messages held back until YYYY-MM-DD 02:00 UTC+2 · 2 refused today". */
export function throttleText(t: MailThrottle): string {
  const parts: string[] = [];
  if (t.heldNow > 0) parts.push(`${plural(t.heldNow, 'message', 'messages')} held back until ${releaseLabel(t.releasesAt)}`);
  if (t.refusing) parts.push('new mail refused while the queue is full');
  if (t.refusedToday > 0) parts.push(`${t.refusedToday} refused today`);
  return parts.join(' · ');
}

/** Which limit is full, in the customer's words. */
export function windowText(t: MailThrottle): string {
  if (t.window === 'day') return 'The daily sending limit is reached';
  if (t.window === 'hour') return 'The hourly sending limit is reached';
  return 'New mail is being refused';
}

export const HOLDING_EXPLAINED
  = 'Mail over a limit is not lost: it is accepted, held in the queue and delivered when the limit resets — '
  + 'at the next full hour for the hourly limit, at 00:00 UTC for the daily one.';

export const REFUSAL_EXPLAINED
  = 'Once a domain has as many messages waiting as its daily limit, new messages are refused with a temporary '
  + 'error. Your mail program keeps them in its outbox and tries again; webmail shows an error and keeps the draft.';

export const COUNTING_EXPLAINED
  = 'Each of your mail domains has its own limits. Every delivery attempt counts, retries to a server that did '
  + 'not answer included, so mail can be held a little before the count here reaches the limit.';
