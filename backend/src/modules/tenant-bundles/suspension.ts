/**
 * Backups pause while a tenant is suspended (operator decision).
 *
 * Suspension disables every sign-in on the tenant's mailboxes in Stalwart —
 * including the backup's own master-user IMAP session — so a bundle taken
 * while suspended can only fail its mailbox capture and alert every night.
 * Nothing is lost by pausing: inbound mail is rejected and nobody can sign in,
 * so the tenant's data does not change, and the platform's mail-store
 * snapshots keep covering its mailboxes.
 *
 * Paused means, while `tenants.status = 'suspended'`:
 *   - the nightly wave skips the tenant (global-scheduler.ts);
 *   - "Back up now" (admin and tenant panel) is refused with
 *     409 TENANT_SUSPENDED;
 *   - retention neither expires nor deletes its bundles, so a long suspension
 *     cannot age the tenant out of its own backups. The hold is defined once
 *     (bundle-hold.ts) and used by the expiry sweep AND the restic
 *     reconciler's keep-set — the reconciler decides liveness from expires_at,
 *     so a hold it did not share would have forgotten the snapshots of bundles
 *     the sweep was keeping.
 *
 * Not paused: the files-only safety snapshot a destructive storage resize
 * takes (storage-lifecycle/prebundle.ts). It belongs to the resize, not to the
 * backup schedule, and captures no mailboxes.
 */
import { ApiError } from '../../shared/errors.js';

export const TENANT_SUSPENDED_BACKUP_MESSAGE =
  'Backups are paused while this tenant is suspended. Reactivate the tenant to back it up again.';

/** Refuse to start a bundle for a suspended tenant. */
export function assertTenantBackupsAllowed(tenant: { readonly status: string }): void {
  if (tenant.status === 'suspended') {
    throw new ApiError('TENANT_SUSPENDED', TENANT_SUSPENDED_BACKUP_MESSAGE, 409);
  }
}
