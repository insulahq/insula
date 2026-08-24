/**
 * Boot-time reconcile for email aliases + domain catch-alls.
 *
 * The platform DB is authoritative. Server-side state can drift when an
 * alias was created while its domain was unprovisioned, a push hit a
 * transient Stalwart error after the DB write, or the mail store was
 * rebuilt. One idempotent sweep per platform-api boot converges:
 *   - every ENABLED alias has a MailingList with the DB's destinations
 *     (created and back-filled if missing, recipients updated if drifted);
 *   - every DISABLED alias has NO list;
 *   - every enabled email domain's Stalwart catchAllAddress equals the
 *     DB value (including null = cleared).
 * Orphan lists (no matching alias row) are LOGGED, never auto-deleted —
 * mirroring principals-sync's surface-only stance on orphans.
 */
import { eq } from 'drizzle-orm';
import { emailAliases, emailDomains } from '../../db/schema.js';
import { mailLogger } from '../../shared/mail-logger.js';
import { getCachedPrincipalsAccountId } from '../stalwart-jmap/client.js';
import {
  createMailingList,
  updateMailingListRecipients,
  destroyMailingList,
  listMailingLists,
  setDomainCatchAll,
} from '../stalwart-jmap/mailing-lists.js';
import type { Database } from '../../db/index.js';

const log = mailLogger().child({ module: 'aliases-reconcile' });

function sameRecipients(a: readonly string[], b: Record<string, boolean>): boolean {
  const want = new Set(a.map((x) => x.toLowerCase()));
  const got = new Set(Object.keys(b).map((x) => x.toLowerCase()));
  if (want.size !== got.size) return false;
  for (const w of want) if (!got.has(w)) return false;
  return true;
}

export async function reconcileAllEmailAliases(db: Database): Promise<void> {
  const aliases = await db.select().from(emailAliases);
  const domainsRows = await db.select().from(emailDomains).where(eq(emailDomains.enabled, 1));
  if (aliases.length === 0 && domainsRows.length === 0) return;

  const accountId = await getCachedPrincipalsAccountId();
  if (!accountId) {
    log.info({ aliasCount: aliases.length }, 'alias reconcile skipped (Stalwart unreachable)');
    return;
  }

  let lists: Awaited<ReturnType<typeof listMailingLists>>;
  try {
    lists = await listMailingLists({ accountId });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'alias reconcile: MailingList/get failed');
    return;
  }
  const listByAddress = new Map(lists.map((l) => [l.emailAddress, l]));
  const domainById = new Map(domainsRows.map((d) => [d.id, d]));

  let applied = 0;
  let failed = 0;
  const ownedAddresses = new Set<string>();
  for (const alias of aliases) {
    const address = alias.sourceAddress.toLowerCase();
    ownedAddresses.add(address);
    const destinations = (alias.destinationAddresses as string[]) ?? [];
    const existing = listByAddress.get(address);
    try {
      if (alias.enabled !== 1) {
        if (existing) {
          await destroyMailingList({ accountId, listId: existing.id });
          applied += 1;
        }
        if (alias.stalwartListId) {
          await db.update(emailAliases).set({ stalwartListId: null }).where(eq(emailAliases.id, alias.id));
        }
        continue;
      }
      if (existing) {
        if (!sameRecipients(destinations, existing.recipients)) {
          await updateMailingListRecipients({ accountId, listId: existing.id, destinations });
          applied += 1;
        }
        if (alias.stalwartListId !== existing.id) {
          await db.update(emailAliases).set({ stalwartListId: existing.id }).where(eq(emailAliases.id, alias.id));
        }
        continue;
      }
      const emailDomain = domainById.get(alias.emailDomainId);
      if (!emailDomain?.stalwartDomainId) continue; // domain not provisioned yet
      const listId = await createMailingList({
        accountId,
        localPart: address.split('@')[0],
        stalwartDomainId: emailDomain.stalwartDomainId,
        destinations,
      });
      await db.update(emailAliases).set({ stalwartListId: listId }).where(eq(emailAliases.id, alias.id));
      applied += 1;
    } catch (err) {
      failed += 1;
      log.warn({ aliasId: alias.id, address, err: err instanceof Error ? err.message : String(err) },
        'alias reconcile failed for alias (retried next boot)');
    }
  }

  // Surface (never delete) lists nobody owns.
  for (const l of lists) {
    if (!ownedAddresses.has(l.emailAddress)) {
      log.warn({ listId: l.id, address: l.emailAddress },
        'orphan Stalwart MailingList (no email_aliases row) — left in place');
    }
  }

  // Domain catch-alls: DB value (including null) is authoritative.
  let catchAllsApplied = 0;
  for (const d of domainsRows) {
    if (!d.stalwartDomainId) continue;
    try {
      await setDomainCatchAll({
        accountId,
        stalwartDomainId: d.stalwartDomainId,
        catchAllAddress: d.catchAllAddress ?? null,
      });
      catchAllsApplied += 1;
    } catch (err) {
      failed += 1;
      log.warn({ emailDomainId: d.id, err: err instanceof Error ? err.message : String(err) },
        'catch-all reconcile failed for domain (retried next boot)');
    }
  }

  log.info({ aliases: aliases.length, applied, catchAllsApplied, failed }, 'email-alias reconcile complete');
}
