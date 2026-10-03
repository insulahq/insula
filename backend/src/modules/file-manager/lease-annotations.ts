/**
 * The file-manager Deployment annotations the idle loop and leases share.
 * Pure, and separate from both so neither has to import the other.
 */

/** Last tenant/SFTP access, epoch ms — written by `recordFileManagerAccess`. */
export const LAST_ACCESS_ANNOTATION = 'insula.host/file-manager-last-access';

/**
 * One key per held lease (`fm-lease.insula.host/<purpose>-<id>`), value = the
 * hold's expiry in epoch ms. One key per holder rather than one shared field,
 * so holders on different platform-api replicas cannot overwrite each other.
 */
export const FM_LEASE_PREFIX = 'fm-lease.insula.host/';

/** True when any lease on the Deployment has not expired yet. */
export function hasLiveLease(annotations: Readonly<Record<string, string>> | undefined, now: number): boolean {
  return Object.entries(annotations ?? {}).some(
    ([k, v]) => k.startsWith(FM_LEASE_PREFIX) && Number(v) > now,
  );
}
