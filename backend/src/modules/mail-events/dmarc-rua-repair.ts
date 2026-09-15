/**
 * Repair published DMARC `rua=` addresses that point at a mailbox that was
 * never created (ROADMAP R5).
 *
 * ## Why a converger and not just a generator fix
 *
 * The platform used to publish
 * `v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@<domain>`, and nothing in
 * the platform has ever created `dmarc-reports@`. Stalwart does not bypass RCPT
 * validation for report addresses, so every aggregate report every receiver
 * sent was refused with `550 5.1.2 Mailbox does not exist` and discarded.
 *
 * Fixing `buildEmailDnsRecords` fixes the record for domains provisioned
 * *afterwards*. The `_dmarc` record is written once, at email-domain enable
 * time, and nothing reconciles it afterwards — mail DNS has no background
 * converger at all. So without this, **every domain already enabled keeps the
 * broken address forever** — which is the entire installed base, and the
 * feature delivers nothing to any of them.
 *
 * (An earlier version of this comment claimed `stalwart-jmap/dns-sync.ts`
 * "deliberately leaves `_dmarc` alone". That was wrong twice over: `_dmarc` was
 * on that module's owned-AND-DELETABLE list, and the module was never wired, so
 * it never ran. It has since been deleted — reconciling mail DNS from
 * Stalwart's zone file would delete a tenant's own apex MX or SPF include.)
 *
 * Verified on DEV 2026-09-13: after the generator fix deployed, the published
 * record still read `rua=mailto:dmarc-reports@…`.
 *
 * ## Scope — deliberately narrow
 *
 * Only rewrites a record whose `rua=` names the exact address the platform used
 * to publish for that same domain. An operator who has pointed `rua=` somewhere
 * of their own (a third-party DMARC aggregator, a shared reporting mailbox) is
 * left alone: rewriting that would be the platform overriding a deliberate
 * choice, and it is the kind of change nobody notices until reports stop
 * arriving where they expected them.
 *
 * Everything else in the record — `p=`, `sp=`, `pct=`, `ruf=`, any tag the
 * operator added — is preserved byte-for-byte. Only the one broken address is
 * substituted.
 */

import { and, eq, like } from 'drizzle-orm';
import { dnsRecords, domains, emailDomains, mailboxes } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';
import { DMARC_LOCAL_PART } from './report-intake-reconciler.js';

/** The address the platform used to publish, and which never existed. */
export const BROKEN_RUA_LOCAL_PART = 'dmarc-reports';

/**
 * Rewrite the one broken address, or return null when there is nothing to do.
 *
 * Pure and exported so the substitution rules are testable without a database:
 * the risk here is not "does it write" but "does it rewrite something it should
 * not have touched".
 */
export function repairRuaValue(recordValue: string, domainName: string): string | null {
  if (!/^\s*v=DMARC1\b/i.test(recordValue)) return null;
  const broken = `${BROKEN_RUA_LOCAL_PART}@${domainName.toLowerCase()}`;
  const fixed = `${DMARC_LOCAL_PART}@${domainName.toLowerCase()}`;
  // Case-insensitive on the address (DNS values are operator-typed) but
  // anchored to `mailto:` so a domain that merely MENTIONS the string
  // elsewhere in the record is not rewritten.
  const re = new RegExp(`mailto:${broken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
  if (!re.test(recordValue)) return null;
  const next = recordValue.replace(re, `mailto:${fixed}`);
  return next === recordValue ? null : next;
}

export interface DmarcRuaRepairResult {
  readonly examined: number;
  readonly repaired: number;
  readonly failed: number;
  /** Waiting on report-intake to create dmarc@<domain>. Not an error. */
  readonly skippedNoMailbox: number;
}

/**
 * Converge every enabled email domain's `_dmarc` record.
 *
 * DB row and provider are updated together: the row is only rewritten once the
 * provider push has succeeded, so a failed push leaves both on the old value
 * and the next tick retries. The alternative — rewrite the row, push later —
 * makes the admin panel show an address the world cannot see, which is a worse
 * failure than the one being fixed because it looks correct.
 *
 * `syncRecordToProviders` has no update verb, so a repair is delete-then-create.
 * A delete that succeeds followed by a create that fails leaves the domain with
 * NO DMARC record, so the create result is checked and the failure is logged
 * loudly rather than counted as a repair.
 */
export async function repairDmarcRuaRecords(
  db: Database,
  logger: OutboundReconcileLogger,
  encryptionKey: string,
): Promise<DmarcRuaRepairResult> {
  const rows = await db
    .select({
      recordId: dnsRecords.id,
      domainId: dnsRecords.domainId,
      domainName: domains.domainName,
      recordName: dnsRecords.recordName,
      recordValue: dnsRecords.recordValue,
      ttl: dnsRecords.ttl,
      // NULL when report-intake has not (yet) created dmarc@<domain>.
      intakeMailboxId: mailboxes.id,
    })
    .from(dnsRecords)
    .innerJoin(domains, eq(dnsRecords.domainId, domains.id))
    .innerJoin(emailDomains, and(
      eq(emailDomains.domainId, domains.id),
      eq(emailDomains.enabled, 1),
    ))
    .leftJoin(mailboxes, and(
      eq(mailboxes.emailDomainId, emailDomains.id),
      eq(mailboxes.localPart, DMARC_LOCAL_PART),
    ))
    .where(and(
      eq(dnsRecords.recordType, 'TXT'),
      // Narrow in SQL so the common case (nothing to repair) is one indexed
      // scan rather than a full table read plus a regex per row.
      like(dnsRecords.recordValue, `%mailto:${BROKEN_RUA_LOCAL_PART}@%`),
    ));

  let repaired = 0;
  let failed = 0;
  let skippedNoMailbox = 0;

  for (const row of rows) {
    if (!row.recordValue || !row.recordName || !row.domainName) continue;

    // Never publish an address that does not exist yet.
    //
    // This converger and report-intake both run fire-and-forget on the same
    // 5-min tick, so their order is not guaranteed; and if mailbox creation
    // fails persistently for a domain, repairing anyway would swap one
    // permanently-bouncing address for another. The domain keeps the old
    // (also broken) record until its intake mailbox exists — no worse than
    // now, and it converges on the next tick.
    if (!row.intakeMailboxId) {
      skippedNoMailbox += 1;
      continue;
    }

    const next = repairRuaValue(row.recordValue, row.domainName);
    if (next === null) continue;

    const { syncRecordToProviders } = await import('../email-domains/dns-provisioning.js');
    const base = {
      type: 'TXT',
      name: row.recordName,
      ttl: row.ttl,
      priority: null,
      id: row.recordId,
    };

    try {
      const del = await syncRecordToProviders(
        db, row.domainId, row.domainName, 'delete',
        { ...base, content: row.recordValue }, encryptionKey,
      );
      if (del.status === 'failed') {
        failed += 1;
        logger.warn({ domain: row.domainName, detail: del.message }, 'dmarc-rua repair: could not remove the old record');
        continue;
      }
      const add = await syncRecordToProviders(
        db, row.domainId, row.domainName, 'create',
        { ...base, content: next }, encryptionKey,
      );
      if (add.status === 'failed') {
        // The old record is already gone. Say so explicitly — this is the one
        // state where the domain is worse off than before the repair started.
        failed += 1;
        logger.error(
          { domain: row.domainName, detail: add.message, intended: next },
          'dmarc-rua repair: the old DMARC record was removed but the corrected one could not be published — the domain currently has NO DMARC record',
        );
        continue;
      }

      await db.update(dnsRecords).set({ recordValue: next }).where(eq(dnsRecords.id, row.recordId));
      repaired += 1;
      logger.info({ domain: row.domainName }, 'dmarc-rua repair: repointed rua= at the real intake mailbox');
    } catch (err) {
      failed += 1;
      logger.warn({ err, domain: row.domainName }, 'dmarc-rua repair: threw (will retry next tick)');
    }
  }

  if (repaired > 0 || failed > 0 || skippedNoMailbox > 0) {
    logger.info(
      { examined: rows.length, repaired, failed, skippedNoMailbox },
      'dmarc-rua repair: pass complete',
    );
  }
  return { examined: rows.length, repaired, failed, skippedNoMailbox };
}
