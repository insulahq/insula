/**
 * The operator's list of a tenant's mailboxes also holds the platform's own
 * report-intake mailbox on each mail domain: postmaster@, which carries
 * abuse@ and dmarc@ as aliases, and a legacy dmarc@ mailbox on some older
 * domains. The platform creates and runs these. They do not count against the
 * tenant's mailbox limit (`getTenantMailboxCount` in the backend's
 * mailboxes/limit.ts leaves them out), and the tenant panel does not list them.
 *
 * Counting them anyway is how the Limits tab read "6 of 5 mailboxes (120%)"
 * for a tenant at exactly its limit. Every count, sum or "largest" figure on
 * these tabs goes through this split, so it uses the same rows as the limit.
 */
export interface MailboxLike {
  readonly platformManaged?: boolean;
}

export interface SplitMailboxes<T> {
  /** The tenant's own mailboxes: what the mailbox limit counts. */
  readonly tenant: readonly T[];
  /** The platform's intake mailboxes on the tenant's domains. */
  readonly platform: readonly T[];
}

export function splitPlatformMailboxes<T extends MailboxLike>(all: readonly T[]): SplitMailboxes<T> {
  return {
    tenant: all.filter((m) => m.platformManaged !== true),
    platform: all.filter((m) => m.platformManaged === true),
  };
}

/** " · 1 platform mailbox not counted", or "" when there is none. */
export function platformNote(count: number): string {
  if (count === 0) return '';
  return ` · ${count} platform mailbox${count === 1 ? '' : 'es'} not counted`;
}
