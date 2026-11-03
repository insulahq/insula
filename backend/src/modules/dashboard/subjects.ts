/**
 * The words a dashboard tile uses to name what it counts.
 *
 * A warning tile or a red figure that only repeats its number makes the
 * operator open a page to learn which things it means. These helpers keep the
 * lists the hover cards show worded and capped the same way everywhere. Pure.
 */
import { DASHBOARD_SUBJECT_LIMIT } from '@insula/api-contracts';

export { DASHBOARD_SUBJECT_LIMIT };

/** The closing row of a capped list: how many it leaves out. None when it shows them all. */
export function moreRow(total: number, shown: number): Array<[string, string]> {
  const rest = total - shown;
  return rest > 0 ? [['More', `${rest} not shown`]] : [];
}

/** "expires today", "3 days left", "expired 2 days ago" — from whole days until expiry. */
export function daysLeft(days: number): string {
  if (days === 0) return 'expires today';
  if (days < 0) return `expired ${-days} day${days === -1 ? '' : 's'} ago`;
  return `${days} day${days === 1 ? '' : 's'} left`;
}

/** "12 min", "3 h", "2 d" — how long something has been the case. */
export function forHowLong(minutes: number): string {
  if (minutes < 60) return `${Math.max(0, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
