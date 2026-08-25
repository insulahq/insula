/**
 * Reconcile for per-mailbox aliases (boot + periodic sweep).
 *
 * The platform DB is authoritative. For EVERY provisioned mailbox the
 * account's whole `aliases` map is compared against the DB rows and
 * replaced when drifted — which also REMOVES out-of-band aliases created
 * behind the platform's back (an alias with no DB row is an invisible
 * live address, exactly the drift class this sweep exists to kill).
 *
 * Send-as identities converge with the rows: enabled alias → identity
 * present; disabled/removed alias → identity gone. Identities are
 * resolved by address, so restores/rebuilt stores self-heal.
 */
import { inArray } from 'drizzle-orm';
import { mailboxAliases, mailboxes, emailDomains } from '../../db/schema.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { getCachedPrincipalsAccountId, rawStalwartCall } from '../stalwart-jmap/client.js';
import {
  setAccountAliases,
  sameAliasSet,
  reconcileIdentitiesForAccount,
  type DesiredAccountAlias,
  type StalwartAccountAliasEntry,
} from '../stalwart-jmap/account-aliases.js';
import type { Database } from '../../db/index.js';

const log = mailLogger().child({ module: 'mailbox-aliases-reconcile' });

const JMAP_STALWART = 'urn:stalwart:jmap';

interface AccountAliasListResponse {
  readonly list?: readonly {
    id: string;
    aliases?: Record<string, { enabled?: boolean; name?: string; domainId?: string }>;
  }[];
}

export interface MailboxAliasReconcileStats {
  mailboxesChecked: number;
  mapsPushed: number;
  outOfBandRemoved: number;
  identitiesEnsured: number;
  identitiesDestroyed: number;
  skippedUnprovisioned: number;
  failed: number;
}

export async function reconcileAllMailboxAliases(db: Database): Promise<MailboxAliasReconcileStats> {
  const stats: MailboxAliasReconcileStats = {
    mailboxesChecked: 0,
    mapsPushed: 0,
    outOfBandRemoved: 0,
    identitiesEnsured: 0,
    identitiesDestroyed: 0,
    skippedUnprovisioned: 0,
    failed: 0,
  };

  const aliasRows = await db.select().from(mailboxAliases);
  const boxes = await db
    .select({
      id: mailboxes.id,
      stalwartPrincipalId: mailboxes.stalwartPrincipalId,
      emailDomainId: mailboxes.emailDomainId,
      fullAddress: mailboxes.fullAddress,
    })
    .from(mailboxes);

  const accountId = await getCachedPrincipalsAccountId();
  if (!accountId) {
    log.info({ aliasRows: aliasRows.length }, 'mailbox-alias reconcile skipped (Stalwart unreachable)');
    return stats;
  }

  const domainIds = [...new Set(boxes.map((b) => b.emailDomainId))];
  const domainRows = domainIds.length > 0
    ? await db
        .select({ id: emailDomains.id, stalwartDomainId: emailDomains.stalwartDomainId })
        .from(emailDomains)
        .where(inArray(emailDomains.id, domainIds))
    : [];
  const stalwartDomainByEmailDomainId = new Map(
    domainRows.filter((d) => d.stalwartDomainId).map((d) => [d.id, d.stalwartDomainId as string]),
  );

  // One bulk fetch of every account's alias map.
  let accounts: AccountAliasListResponse;
  try {
    accounts = await rawStalwartCall<AccountAliasListResponse>({
      using: [JMAP_STALWART],
      method: 'x:Account/get',
      args: { accountId, ids: null, properties: ['id', 'aliases'] },
    });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) },
      'mailbox-alias reconcile: x:Account/get failed');
    return stats;
  }
  const aliasMapByPrincipal = new Map<string, readonly StalwartAccountAliasEntry[]>(
    (accounts.list ?? []).map((a) => [
      a.id,
      Object.values(a.aliases ?? {})
        .filter((e) => typeof e.name === 'string' && typeof e.domainId === 'string')
        .map((e) => ({
          enabled: e.enabled !== false,
          name: (e.name as string).toLowerCase(),
          domainId: e.domainId as string,
        })),
    ]),
  );

  const rowsByMailbox = new Map<string, typeof aliasRows>();
  for (const row of aliasRows) {
    const bucket = rowsByMailbox.get(row.mailboxId) ?? [];
    bucket.push(row);
    rowsByMailbox.set(row.mailboxId, bucket);
  }

  for (const box of boxes) {
    const rows = rowsByMailbox.get(box.id) ?? [];
    const stalwartDomainId = stalwartDomainByEmailDomainId.get(box.emailDomainId);
    if (!box.stalwartPrincipalId || !stalwartDomainId) {
      if (rows.length > 0) {
        stats.skippedUnprovisioned += 1;
        log.warn({ mailboxId: box.id, fullAddress: box.fullAddress, aliasCount: rows.length },
          'mailbox-alias reconcile: mailbox/domain not provisioned — aliases deferred');
      }
      continue;
    }
    stats.mailboxesChecked += 1;

    const desired: DesiredAccountAlias[] = rows.map((r) => ({
      localPart: r.localPart,
      stalwartDomainId,
      enabled: r.enabled === 1,
    }));
    const current = aliasMapByPrincipal.get(box.stalwartPrincipalId) ?? [];

    try {
      if (!sameAliasSet(desired, current)) {
        const known = new Set(rows.map((r) => r.localPart.toLowerCase()));
        const removed = current.filter((c) => !known.has(c.name));
        if (removed.length > 0) {
          stats.outOfBandRemoved += removed.length;
          log.warn({ mailboxId: box.id, fullAddress: box.fullAddress, removed: removed.map((r) => r.name) },
            'mailbox-alias reconcile: removing out-of-band Stalwart aliases (no mailbox_aliases row — DB is authoritative)');
        }
        await setAccountAliases({
          accountId,
          principalId: box.stalwartPrincipalId,
          aliases: desired,
        });
        stats.mapsPushed += 1;
      }

      // Identity convergence — only for mailboxes that carry alias rows
      // (one Identity/get per such mailbox; alias-less mailboxes only
      // have their primary identity, nothing to converge).
      if (rows.length > 0) {
        const applied = await reconcileIdentitiesForAccount({
          principalId: box.stalwartPrincipalId,
          wantAddresses: rows.filter((r) => r.enabled === 1).map((r) => r.fullAddress),
          dropAddresses: rows.filter((r) => r.enabled !== 1).map((r) => r.fullAddress),
        });
        stats.identitiesEnsured += applied.created;
        stats.identitiesDestroyed += applied.destroyed;
      }
    } catch (err) {
      stats.failed += 1;
      log.warn({ mailboxId: box.id, fullAddress: box.fullAddress, err: err instanceof Error ? err.message : String(err) },
        'mailbox-alias reconcile failed for mailbox (retried next sweep)');
    }
  }

  log.info({ ...stats }, 'mailbox-alias reconcile complete');
  return stats;
}
