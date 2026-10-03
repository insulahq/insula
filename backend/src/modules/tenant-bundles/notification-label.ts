/**
 * How a notification names a backup bundle and words its failure.
 *
 * The dispatcher replaces every UUID in a notification variable with the name
 * of the tenant, user, mailbox or domain it identifies — and with "(unnamed)"
 * when it identifies none of them. A bundle id (`bkp-<uuid>`) is none of them,
 * so passing it as the label mailed operators "Tenant backup: bkp-(unnamed)",
 * and the Job and pod names inside the error text rendered the same way.
 *
 * Both helpers are pure so the exact wording is pinned by tests.
 */
import { formatUtcMinute } from '../../shared/format-utc.js';
import { operatorNotificationText, tenantVisibleText } from '../../shared/operator-only-text.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A UUID glued to a name prefix (`pvc-<uuid>`): an object name, not an id the dispatcher can resolve. */
const EMBEDDED_UUID_RE = new RegExp(`([A-Za-z0-9]-)(${UUID})`, 'gi');

/** The words a reader recognises a bundle by: its label, else when it ran. */
export function bundleNotificationLabel(bundle: {
  readonly label: string | null;
  readonly startedAt: Date;
}): string {
  const when = `run of ${formatUtcMinute(bundle.startedAt)}`;
  const label = bundle.label?.trim();
  return label ? `"${label}" (${when})` : when;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Who reads the notification: a tenant's users, or platform operators. */
export type NotificationAudience = 'tenant' | 'operator';

/**
 * The bundle's component errors, worded for a notification.
 *
 *  - Operator-only detail is cut per audience (shared/operator-only-text.ts):
 *    a tenant gets the headline only; an operator keeps the `; diagnosis:`
 *    (which node, which pod, which event) but never the `; logs:` pod output.
 *    The full text stays in `backup_jobs.last_error`.
 *  - Tokens carrying THIS bundle's id (its Job and pod names) are dropped: the
 *    subject already says which bundle this is.
 *  - A UUID embedded in another object name (`pvc-<uuid>`) is shortened to its
 *    first block, which still identifies it to an operator.
 *  - A bare UUID is left alone: it is a tenant/user/mailbox/domain id the
 *    dispatcher turns into a name.
 */
export function notificationErrorText(
  errors: readonly string[],
  bundleId: string,
  audience: NotificationAudience,
  maxLength = 500,
): string {
  return notificationErrorItems(errors, bundleId, audience).join('; ').slice(0, maxLength);
}

/**
 * The same cut, one entry per failed component — for a notification's `items`,
 * which every channel renders as a list (one component per line), instead of
 * running "files: …; mailboxes: …; data_export: …" into a paragraph.
 */
export function notificationErrorItems(
  errors: readonly string[],
  bundleId: string,
  audience: NotificationAudience,
  maxPerItem = 500,
): string[] {
  const ownToken = new RegExp(`\\s*\\S*${escapeRegExp(bundleId)}\\S*`, 'g');
  const cut = audience === 'tenant' ? tenantVisibleText : operatorNotificationText;
  return errors
    .map((e) => cut(e)
      .replace(ownToken, '')
      .replace(EMBEDDED_UUID_RE, (_m, prefix: string, id: string) => `${prefix}${id.slice(0, 8)}…`)
      .trim()
      .slice(0, maxPerItem))
    .filter((e) => e.length > 0);
}
