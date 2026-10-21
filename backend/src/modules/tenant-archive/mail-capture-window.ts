/**
 * Lets an archive's final bundle read a SUSPENDED tenant's mail.
 *
 * Suspension turns each mailbox's Stalwart `authenticate` permission off, and
 * with it the master-user login the bundle's mailbox capture uses
 * (tenant-bundles/components/mailboxes.ts) — a suspended tenant's bundle used
 * to come back `partial`, without its mail. Archive needs that mail: once the
 * mailboxes are removed, the final bundle is the only copy. So login is
 * allowed again for the length of the capture, and taken away after it.
 *
 * Inbound mail stays refused the whole time: the suspension's reject script and
 * alias map are not touched, only the login permission. A mailbox owner who
 * knows their password could sign in during those minutes; that is the price
 * of keeping their mail, and it is the operator's archive, not their own.
 */
import { eq } from 'drizzle-orm';
import { mailboxes, storageOperations, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';

interface Deps {
  readonly principalsAccountId: () => Promise<string | null>;
  readonly setAccess: (args: { accountId: string; principalId: string; mailboxType: 'mailbox' | 'send_only'; suspended: boolean }) => Promise<void>;
  readonly warn: (msg: string) => void;
}

async function realDeps(): Promise<Deps> {
  const { getCachedPrincipalsAccountId } = await import('../stalwart-jmap/client.js');
  const { applyAccountAccessState } = await import('../stalwart-jmap/sieve.js');
  return {
    principalsAccountId: async () => (await getCachedPrincipalsAccountId()) ?? null,
    setAccess: (a) => applyAccountAccessState(a),
    warn: (msg) => console.warn(`[tenant-archive] ${msg}`),
  };
}

/**
 * Run `capture` with the tenant's mailboxes able to log in, then take login
 * away again — whether the capture worked or not. A tenant with no mailbox on
 * the mail server runs `capture` as it is. Refuses (`MAIL_SERVER_UNREACHABLE`)
 * when there are mailboxes and the mail server cannot be asked: the bundle
 * would be taken without their mail.
 */
export async function withMailCaptureLogin<T>(
  db: Database,
  tenantId: string,
  capture: () => Promise<T>,
  deps?: Deps,
): Promise<T> {
  const d = deps ?? await realDeps();
  const rows = await db
    .select({ principalId: mailboxes.stalwartPrincipalId, mailboxType: mailboxes.mailboxType })
    .from(mailboxes)
    .where(eq(mailboxes.tenantId, tenantId));
  const provisioned = rows.flatMap((r) => (r.principalId
    ? [{ principalId: r.principalId, mailboxType: r.mailboxType === 'send_only' ? 'send_only' as const : 'mailbox' as const }]
    : []));
  if (provisioned.length === 0) return capture();

  const accountId = await d.principalsAccountId();
  if (!accountId) {
    throw new ApiError(
      'MAIL_SERVER_UNREACHABLE',
      `The mail server could not be reached to read this tenant's ${provisioned.length} mailbox(es); the archive was not taken`,
      503,
    );
  }
  const opened: typeof provisioned = [];
  try {
    for (const m of provisioned) {
      await d.setAccess({ accountId, principalId: m.principalId, mailboxType: m.mailboxType, suspended: false });
      opened.push(m);
    }
    return await capture();
  } finally {
    for (const m of opened) {
      try {
        await d.setAccess({ accountId, principalId: m.principalId, mailboxType: m.mailboxType, suspended: true });
      } catch (err) {
        // The archive removes these accounts next when it goes on; when it does
        // not, the next suspend push (mail-rules reconcile) closes it again.
        d.warn(`could not take login away again from principal ${m.principalId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/**
 * The tenants an archive is under way for. The mail-rules sweep
 * (mailboxes/mail-rules-reconcile.ts, every 15 minutes on any replica) leaves
 * their mailboxes alone: during the capture their logins are open while their
 * rows still say disabled, and the sweep closing one mid-capture would fail the
 * archive's bundle. Once the operation ends the sweep converges them again —
 * also a window a dead process left open.
 */
export async function tenantsBeingArchived(db: Database): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .innerJoin(storageOperations, eq(storageOperations.id, tenants.activeStorageOpId))
    .where(eq(storageOperations.opType, 'archive'));
  return new Set(rows.map((r) => r.id));
}
