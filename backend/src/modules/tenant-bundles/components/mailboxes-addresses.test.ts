/**
 * Which mailboxes a tenant bundle captures — and a restore of "all" restores.
 * Capture and restore share listTenantMailboxAddresses, so they must agree.
 *
 * Platform-managed report-intake boxes (postmaster@ / dmarc@, created by the
 * 5-min mail self-heal on every email domain) are the platform's plumbing, not
 * the tenant's mail. They were enumerated, so a bundle captured before the
 * self-heal created postmaster@ could never be restored: the restore listed
 * postmaster@, the bundle had no snapshot for it, and the whole restore failed
 * ("invalid snapshotId for 'postmaster@…'", EXECUTOR_FAILED) — v2026.10.3-rc.2
 * full VM run, integration-dr-tenant-restore.
 */
import { describe, it, expect } from 'vitest';
import { listTenantMailboxAddresses } from './mailboxes.js';

function dbCapturing() {
  const seen: string[] = [];
  const db = {
    execute: async (q: unknown) => {
      seen.push(JSON.stringify(q));
      return { rows: [{ full_address: 'info@example.test' }] };
    },
  };
  return { db: db as never, seen };
}

describe('listTenantMailboxAddresses', () => {
  it('leaves out platform-managed report-intake mailboxes and send-only accounts', async () => {
    const { db, seen } = dbCapturing();
    expect(await listTenantMailboxAddresses(db, 't1')).toEqual(['info@example.test']);
    expect(seen[0]).toContain('platform_managed = false');
    expect(seen[0]).toContain("send_only");
  });
});
