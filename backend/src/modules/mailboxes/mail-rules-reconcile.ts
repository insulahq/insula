/**
 * Reconcile: re-push platform-managed mail state (Sieve forwarding /
 * send-only / suspension scripts + the account access-permission
 * profile) for every mailbox that declares any of it in the platform DB
 * (boot + the 15-min periodic sweep).
 *
 * The platform DB is authoritative. Stalwart-side state can drift when:
 *   - a mailbox was recreated empty via the mail-drift remediation UI,
 *   - a tenant restore replayed an old Sieve state,
 *   - a power user replaced their own script via ManageSieve,
 *   - a forwarding edit hit a transient Stalwart error after the DB write,
 *   - a suspend/reactivate hook run failed mid-tenant.
 *
 * Permissions converge by DIFF: ONE bulk x:Account/get of every
 * account's stored `permissions`, compared against the composed desired
 * object (buildAccountPermissions) — only drifted accounts get a patch,
 * so the steady-state sweep writes nothing. This covers ALL mailboxes
 * (a plain active mailbox stuck with a suspension leftover converges
 * too); the script push stays scoped to rows that declare rules or are
 * disabled, plus any permission-drifted row (the drift is the tell that
 * a lifecycle push failed halfway).
 */
import { isNotNull } from 'drizzle-orm';
import { mailboxes } from '../../db/schema.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { getJmapSession, rawStalwartCall } from '../stalwart-jmap/client.js';
import {
  applyMailRules,
  applyAccountAccessState,
  buildAccountPermissions,
  ensureSieveInterpreterLimits,
} from '../stalwart-jmap/sieve.js';
import type { Database } from '../../db/index.js';

const log = mailLogger().child({ module: 'mail-rules-reconcile' });

interface StoredPermissions {
  readonly enabledPermissions?: Record<string, boolean>;
  readonly disabledPermissions?: Record<string, boolean>;
}

/**
 * Stored-vs-desired permission equivalence. The meaningful signal is the
 * DISABLED set (what the platform turns off); the enabled set only
 * exists to flip a previous disable back. An account with NO stored
 * permissions object equals "nothing disabled".
 * Exported pure for unit tests.
 */
export function permissionsMatch(
  stored: StoredPermissions | undefined,
  desired: { enabledPermissions: Record<string, boolean>; disabledPermissions: Record<string, boolean> },
): boolean {
  const storedDis = Object.entries(stored?.disabledPermissions ?? {})
    .filter(([, v]) => v === true).map(([k]) => k).sort();
  const desiredDis = Object.entries(desired.disabledPermissions)
    .filter(([, v]) => v === true).map(([k]) => k).sort();
  return storedDis.length === desiredDis.length && storedDis.every((k, i) => k === desiredDis[i]);
}

export async function reconcileAllMailboxMailRules(db: Database): Promise<void> {
  // Every PROVISIONED mailbox: the permission diff needs all of them,
  // and unprovisioned rows are skipped in the loop anyway (principals-
  // sync backfills first). The script push below narrows to
  // rules-bearing / disabled / perm-drifted rows.
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
    .where(isNotNull(mailboxes.stalwartPrincipalId));
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

  // ONE bulk fetch of every account's stored permissions for the diff.
  let storedPermsByPrincipal = new Map<string, StoredPermissions | undefined>();
  try {
    const res = await rawStalwartCall<{ list?: readonly { id: string; permissions?: StoredPermissions }[] }>({
      using: ['urn:stalwart:jmap'],
      method: 'x:Account/get',
      args: { accountId, ids: null, properties: ['id', 'permissions'] },
    });
    storedPermsByPrincipal = new Map((res.list ?? []).map((a) => [a.id, a.permissions]));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) },
      'mail-rules reconcile: bulk permissions fetch failed — skipping permission diff this sweep');
  }

  const anyActiveForwarding = rows.some(
    (r) => r.status !== 'disabled' && (r.forwardingAddresses?.length ?? 0) > 0,
  );
  if (anyActiveForwarding) {
    await ensureSieveInterpreterLimits({ accountId }).catch((err) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'sieve interpreter limits ensure failed');
    });
  }

  let applied = 0;
  let permsPatched = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.stalwartPrincipalId) continue; // not provisioned yet — principals-sync backfills first
    const mailboxType = row.mailboxType === 'send_only' ? 'send_only' : 'mailbox';
    const suspended = row.status === 'disabled';
    try {
      // Permission diff → patch only when drifted.
      const desired = buildAccountPermissions({ mailboxType, suspended });
      const stored = storedPermsByPrincipal.get(row.stalwartPrincipalId);
      const permsDrifted = storedPermsByPrincipal.size > 0
        && !permissionsMatch(stored, desired);
      if (permsDrifted) {
        await applyAccountAccessState({
          accountId,
          principalId: row.stalwartPrincipalId,
          mailboxType,
          suspended,
        });
        permsPatched += 1;
      }

      // Script push: rules-bearing rows, disabled rows, and any row whose
      // permissions drifted (the tell that a lifecycle push died halfway —
      // its script may be stale too).
      const rulesBearing =
        mailboxType === 'send_only' ||
        (row.forwardingAddresses?.length ?? 0) > 0 ||
        row.autoReply === 1;
      if (rulesBearing || suspended || permsDrifted) {
        await applyMailRules({
          principalId: row.stalwartPrincipalId,
          mailboxType,
          suspended,
          forwardingAddresses: suspended ? [] : (row.forwardingAddresses ?? []),
          autoReply: !suspended && row.autoReply === 1 && row.autoReplyBody?.trim()
            ? { subject: row.autoReplySubject, body: row.autoReplyBody }
            : null,
        });
        applied += 1;
      }
    } catch (err) {
      failed += 1;
      log.warn({
        mailboxId: row.id,
        fullAddress: row.fullAddress,
        err: err instanceof Error ? err.message : String(err),
      }, 'mail-rules reconcile failed for mailbox (retried next sweep)');
    }
  }
  log.info({ applied, permsPatched, failed, total: rows.length }, 'mailbox mail-rules reconcile complete');
}
