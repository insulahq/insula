/**
 * Boot-time reconcile: re-push platform-managed mail rules (Sieve
 * forwarding / send-only scripts + the send-only permission profile)
 * for every mailbox that declares them in the platform DB.
 *
 * The platform DB is authoritative. Stalwart-side state can drift when:
 *   - a mailbox was recreated empty via the mail-drift remediation UI,
 *   - a tenant restore replayed an old Sieve state,
 *   - a power user replaced their own script via ManageSieve,
 *   - a forwarding edit hit a transient Stalwart error after the DB write.
 * One idempotent sweep per platform-api boot converges all of it without
 * per-tenant action (same pattern as the tenant-netpol boot reconcile).
 */
import { eq, isNotNull, or } from 'drizzle-orm';
import { mailboxes } from '../../db/schema.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { getJmapSession } from '../stalwart-jmap/client.js';
import {
  applyMailRules,
  applySendOnlyPermissions,
  ensureSieveInterpreterLimits,
} from '../stalwart-jmap/sieve.js';
import type { Database } from '../../db/index.js';

const log = mailLogger().child({ module: 'mail-rules-reconcile' });

export async function reconcileAllMailboxMailRules(db: Database): Promise<void> {
  // Rows that declare platform-managed rules: every send-only account
  // (permission profile + inbound script) and every forwarding mailbox.
  // Disabled rows are INCLUDED (2026-08-25 drift audit): their desired
  // state is the STRIPPED script (no forwarding/auto-reply; send-only
  // keeps its ereject) — excluding them left a suspended tenant's
  // forwarding script unmanaged, silently redirecting mail forever.
  const rows = await db
    .select({
      id: mailboxes.id,
      fullAddress: mailboxes.fullAddress,
      status: mailboxes.status,
      mailboxType: mailboxes.mailboxType,
      forwardingAddresses: mailboxes.forwardingAddresses,
      autoReply: mailboxes.autoReply,
      autoReplySubject: mailboxes.autoReplySubject,
      autoReplyBody: mailboxes.autoReplyBody,
      stalwartPrincipalId: mailboxes.stalwartPrincipalId,
    })
    .from(mailboxes)
    .where(
      or(
        eq(mailboxes.mailboxType, 'send_only'),
        isNotNull(mailboxes.forwardingAddresses),
        eq(mailboxes.autoReply, 1),
      ),
    );
  if (rows.length === 0) return;

  // Resolve the admin principals account once. Unreachable Stalwart =
  // skip the sweep (dev stacks without the mail overlay, unit tests).
  let accountId: string | undefined;
  try {
    const session = await getJmapSession(process.env.STALWART_MGMT_URL, process.env);
    accountId = session.primaryAccounts['urn:ietf:params:jmap:principals'];
  } catch {
    log.info({ mailboxCount: rows.length }, 'mail-rules reconcile skipped (Stalwart unreachable)');
    return;
  }
  if (!accountId) return;

  if (rows.some((r) => (r.forwardingAddresses?.length ?? 0) > 0)) {
    await ensureSieveInterpreterLimits({ accountId }).catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'sieve interpreter limits ensure failed');
    });
  }

  let applied = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.stalwartPrincipalId) continue; // not provisioned yet — principals-sync backfills first
    try {
      if (row.mailboxType === 'send_only') {
        await applySendOnlyPermissions({ accountId, principalId: row.stalwartPrincipalId });
      }
      const disabled = row.status === 'disabled';
      await applyMailRules({
        principalId: row.stalwartPrincipalId,
        mailboxType: row.mailboxType === 'send_only' ? 'send_only' : 'mailbox',
        forwardingAddresses: disabled ? [] : (row.forwardingAddresses ?? []),
        autoReply: !disabled && row.autoReply === 1 && row.autoReplyBody?.trim()
          ? { subject: row.autoReplySubject, body: row.autoReplyBody }
          : null,
      });
      applied += 1;
    } catch (err) {
      failed += 1;
      log.warn({
        mailboxId: row.id,
        fullAddress: row.fullAddress,
        err: err instanceof Error ? err.message : String(err),
      }, 'mail-rules reconcile failed for mailbox (retried next boot)');
    }
  }
  log.info({ applied, failed, total: rows.length }, 'mailbox mail-rules reconcile complete');
}
