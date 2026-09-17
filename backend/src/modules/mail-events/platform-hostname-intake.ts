/**
 * `postmaster@` and `abuse@` on the platform's OWN mail hostname.
 *
 * Measured on production 2026-09-17 with a two-control SMTP probe:
 *
 *     postmaster@<a hosted domain>  -> 250 2.1.5 OK                    (control)
 *     no-such-mailbox@<same domain> -> 550 5.1.2 Mailbox does not exist (control)
 *     postmaster@mail.<apex>        -> 550 5.1.2 Mailbox does not exist
 *
 * `mail.<apex>` is the domain in every EHLO, in the TLS certificate, and
 * historically in the envelope of platform-generated report mail — so it is
 * the address a remote postmaster, an abuse desk, or a delisting process
 * actually tries. RFC 2142 requires both names of any mail-receiving domain,
 * and the platform answered neither.
 *
 * Implemented as Stalwart MailingLists rather than mailboxes:
 *
 *   * There is no mailbox to reap, no quota to size, and nothing to grow
 *     unbounded — the two addresses that exist here see almost no traffic, and
 *     what does arrive matters immediately.
 *   * It reaches a human. A hidden mailbox nobody opens satisfies SMTP and
 *     nothing else; the point of `abuse@` is that somebody reads it.
 *   * `mailbox_aliases` and `email_aliases` rows are both keyed by
 *     `email_domain_id`, so representing these in the platform DB would mean
 *     making the mail hostname a tenant-visible email domain. It is a reserved
 *     platform hostname precisely so that cannot happen.
 *
 * The platform apex is deliberately NOT covered. It answers
 * `550 5.1.2 Relay not allowed` — Stalwart does not host it at all — so
 * nothing can be accepted there until the apex is registered as a mail domain,
 * which is a separate decision the operator declined (it means MX, DKIM and a
 * general-purpose inbox). The hostname is the identity strangers see.
 */

import { eq, and, inArray } from 'drizzle-orm';
import { mailboxAliases, mailboxes, users } from '../../db/schema.js';
import { getCachedPrincipalsAccountId } from '../stalwart-jmap/client.js';
import { getExplicitMailHostname } from '../mail-admin/stalwart-domain-reconciler.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

/** The two RFC 2142 obligations, in the order an operator would name them. */
export const PLATFORM_HOSTNAME_INTAKES = ['postmaster', 'abuse'] as const;

/** Admin roles whose mailboxes are worth waking for a postmaster report. */
const PAGED_ROLES = ['super_admin', 'admin'] as const;

export interface PlatformHostnameIntakeResult {
  readonly state: 'in-sync' | 'updated' | 'created' | 'skipped';
  /** Addresses that now accept mail. */
  readonly addresses: readonly string[];
  readonly reason?: string;
}

/**
 * Every platform address the lists are known by, for callers that need to tell
 * "the platform declared this" from "somebody made it out of band" — the
 * orphan-list drift check being the one that matters.
 */
export function platformHostnameAddresses(hostname: string): readonly string[] {
  const host = hostname.trim().replace(/\.+$/, '').toLowerCase();
  if (!host) return [];
  return PLATFORM_HOSTNAME_INTAKES.map((local) => `${local}@${host}`);
}

/** Resolve the Stalwart domain id for a hostname, or null when it hosts none. */
async function stalwartDomainIdFor(
  hostname: string,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv },
): Promise<string | null> {
  const { domainQuery, domainGet } = await import('../stalwart-jmap/client.js');
  const q = await domainQuery({ ...opts } as never);
  const ids = (q.ids ?? []).filter((x): x is string => typeof x === 'string');
  if (ids.length === 0) return null;
  const res = await domainGet({ ids, properties: ['id', 'name'], ...opts } as never);
  const list = (res as { list?: ReadonlyArray<{ id?: unknown; name?: unknown }> }).list ?? [];
  for (const row of list) {
    if (typeof row.name === 'string' && typeof row.id === 'string'
      && row.name.toLowerCase() === hostname) {
      return row.id;
    }
  }
  return null;
}

/** The operator addresses a postmaster/abuse report should land in. */
async function adminDestinations(db: Database): Promise<readonly string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(
      eq(users.panel, 'admin'),
      eq(users.status, 'active'),
      inArray(users.roleName, PAGED_ROLES as unknown as string[]),
    ));
  const seen = new Set<string>();
  for (const r of rows) {
    const e = r.email?.trim().toLowerCase();
    if (e) seen.add(e);
  }
  return Array.from(seen).sort();
}

/** Does the platform DB already answer this address with a mailbox or alias? */
async function alreadyAnswered(db: Database, address: string): Promise<boolean> {
  const [box] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.fullAddress, address))
    .limit(1);
  if (box) return true;
  const [alias] = await db
    .select({ id: mailboxAliases.id })
    .from(mailboxAliases)
    .where(eq(mailboxAliases.fullAddress, address))
    .limit(1);
  return Boolean(alias);
}

/**
 * Converge the hostname intake. Never throws: it runs inside the 5-minute mail
 * self-heal tick, where one failing reconciler must not stop the others.
 *
 * Runs on every tick AND at boot, which is what makes a fresh bootstrap
 * converge with no extra step: the mail hostname's Stalwart domain is created
 * during install, and the first tick after it appears builds the lists.
 */
export async function ensurePlatformHostnameIntake(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PlatformHostnameIntakeResult> {
  try {
    const hostname = (await getExplicitMailHostname(db))?.trim().replace(/\.+$/, '').toLowerCase();
    if (!hostname) {
      return { state: 'skipped', addresses: [], reason: 'no mail hostname resolved' };
    }

    const accountId = await getCachedPrincipalsAccountId();
    if (!accountId) {
      return { state: 'skipped', addresses: [], reason: 'stalwart principals account unavailable' };
    }

    const stalwartDomainId = await stalwartDomainIdFor(hostname, opts);
    if (!stalwartDomainId) {
      // Normal on a cluster mid-install: bootstrap registers the hostname
      // domain, and the next tick finds it. Not an error.
      logger.info(
        { hostname },
        'platform hostname intake: mail hostname is not a Stalwart domain yet — retrying next tick',
      );
      return { state: 'skipped', addresses: [], reason: 'hostname not a stalwart domain' };
    }

    const destinations = await adminDestinations(db);
    if (destinations.length === 0) {
      // A MailingList with no recipients ACCEPTS mail and drops it. That is
      // strictly worse than the 550 we are fixing: the sender is told the
      // report was delivered and nobody ever sees it. Refuse to build one.
      logger.warn(
        { hostname },
        'platform hostname intake: no active admin recipient — refusing to create a list that would '
        + 'accept mail and discard it',
      );
      return { state: 'skipped', addresses: [], reason: 'no admin recipients' };
    }

    const { listMailingLists, createMailingList, updateMailingListRecipients } =
      await import('../stalwart-jmap/mailing-lists.js');
    const existing = await listMailingLists({ accountId, ...opts });
    const byAddress = new Map(existing.map((l) => [l.emailAddress.toLowerCase(), l]));

    const addresses: string[] = [];
    let created = 0;
    let updated = 0;

    for (const localPart of PLATFORM_HOSTNAME_INTAKES) {
      const address = `${localPart}@${hostname}`;
      if (await alreadyAnswered(db, address)) {
        // Somebody hosts this hostname as a real email domain with a real
        // mailbox. Leave it: the address answers, which is the goal, and
        // shadowing it with a forwarder would silently redirect their mail.
        logger.info({ address }, 'platform hostname intake: address already answered by a platform mailbox');
        addresses.push(address);
        continue;
      }

      const list = byAddress.get(address);
      if (!list) {
        await createMailingList({
          accountId,
          localPart,
          stalwartDomainId,
          destinations,
          description: 'Platform-managed RFC 2142 intake — reconciled by platform-api',
          ...opts,
        });
        created += 1;
        addresses.push(address);
        logger.info({ address, destinations: destinations.length }, 'platform hostname intake: created');
        continue;
      }

      // Recipients follow the admin roster. An admin who left must stop
      // receiving; one who joined must start — and the roster is the only
      // place that is recorded.
      const current = Object.keys(list.recipients ?? {}).map((r) => r.toLowerCase()).sort();
      const same = current.length === destinations.length
        && current.every((r, i) => r === destinations[i]);
      if (!same) {
        await updateMailingListRecipients({ accountId, listId: list.id, destinations, ...opts });
        updated += 1;
        logger.info(
          { address, from: current.length, to: destinations.length },
          'platform hostname intake: recipients re-synced to the admin roster',
        );
      }
      addresses.push(address);
    }

    return {
      state: created > 0 ? 'created' : updated > 0 ? 'updated' : 'in-sync',
      addresses,
    };
  } catch (err) {
    logger.error({ err }, 'platform hostname intake: ensure failed (retries next tick)');
    return { state: 'skipped', addresses: [], reason: 'error' };
  }
}
