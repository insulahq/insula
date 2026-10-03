/**
 * Whether the mail server should accept mail for a mailbox alias right now.
 * Pure — the one rule the alias push and the drift check share.
 *
 * Live only while the alias row is enabled AND its mailbox is active. Suspending
 * a tenant sets its mailboxes `disabled` and pushes every alias off, keeping the
 * rows (and their `enabled` flag) so reactivation can restore them: an enabled
 * row on a disabled mailbox is the tenant's intent, not an address the server
 * has lost.
 */
export function aliasIsLive(mailboxActive: boolean, aliasEnabled: number): boolean {
  return mailboxActive && aliasEnabled === 1;
}
