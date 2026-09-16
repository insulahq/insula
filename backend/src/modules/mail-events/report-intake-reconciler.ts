/**
 * DMARC report-intake provisioning.
 *
 * Re-asserted by the 5-min mail self-heal:
 *
 *   1. A real `dmarc@<domain>` mailbox exists on EVERY enabled email domain.
 *      Each domain publishes `rua=mailto:dmarc@<that domain>`, and Stalwart
 *      does NOT bypass RCPT validation for report addresses (live-proven:
 *      `550 5.1.2 Mailbox does not exist` without an account), so the
 *      published address must be a real principal or every aggregate report
 *      is refused and discarded.
 *
 *   2. Stalwart's ReportSettings `inboundReportAddresses` covers
 *      `postmaster@*` and `dmarc@*`, followed by a ReloadSettings action
 *      (report-analysis config is boot-loaded like the MTA config).
 *
 * The mailboxes are normal platform mailboxes (ADR-049 hidden auto-generated
 * primary credential — nobody logs in). Stalwart parses and stores the report
 * before delivery, so what lands in the mailbox is a residual copy, bounded by
 * the mailbox quota.
 *
 * ## FBL was retired 2026-09-15
 *
 * `fbl@<apex>` intake and ARF complaint ingestion are gone. Measured on
 * production: **zero** complaints ingested in the feature's entire life, and no
 * `fbl@` mailbox had ever been created — the intake was anchored to the SYSTEM
 * apex, which in the real deployment has no email domain at all, so the
 * provisioner logged "skipped" on every tick since install. On top of that, FBL
 * requires manual per-provider enrolment (Microsoft JMRP/SNDS, Yahoo CFL) with
 * production IPs. Operator decision: retire rather than carry a feature that
 * cannot reach its own intake address. This reconciler actively PRUNES `fbl@*`
 * from Stalwart so the retirement does not leave dead config behind.
 *
 * ## Why this no longer depends on the apex
 *
 * The per-domain `dmarc@` loop used to sit inside an `if (apex) … else` branch
 * that existed only to place the apex FBL mailbox. With no apex email domain —
 * production's actual state — the whole branch was skipped and NOT ONE of the
 * hosted domains got its DMARC mailbox. An unrelated precondition silently
 * disabled a per-tenant-domain feature that never depended on it.
 */

import { eq, and, gte } from 'drizzle-orm';
import { domains, emailDomains, mailboxes } from '../../db/schema.js';
import {
  reportSettingsGet,
  reportSettingsUpdate,
  actionReloadSettings,
} from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

/**
 * DMARC `rua=` addresses point here. It must be a REAL principal: Stalwart does
 * not bypass RCPT validation for report addresses, so an unregistered address
 * answers `550 5.1.2 Mailbox does not exist` and the report is never parsed.
 * Re-confirmed on a live server 2026-09-13 — `postmaster@<apex>`, which is in
 * the pattern list but has no account, is refused at RCPT.
 */
export const DMARC_LOCAL_PART = 'dmarc';

/**
 * `postmaster@` must be a REAL principal for the same reason `dmarc@` is, and
 * it had been listed in REQUIRED_INTAKE_PATTERNS since this file was written
 * while nothing ever created the account. Measured on DEV 2026-09-16:
 *
 *     550 5.5.0 Mailbox not found          <- RCPT TO postmaster@<apex>
 *     385 messages queued to that address, retrying every 24h
 *
 * It is the envelope sender on platform-generated mail, so every DSN and
 * bounce routed back to it is undeliverable — and those pile up until they
 * expire, at which point the expiry generates another DSN to the same dead
 * address. RFC 5321 §4.5.1 requires every mail-receiving domain to accept it.
 */
export const POSTMASTER_LOCAL_PART = 'postmaster';

/** Patterns Stalwart must treat as report intake. */
const REQUIRED_INTAKE_PATTERNS = [
  'postmaster@*',
  `${DMARC_LOCAL_PART}@*`,
] as const;

/**
 * Patterns to REMOVE. Leaving `fbl@*` registered after retiring FBL would keep
 * Stalwart diverting mail to a parser whose output nothing consumes.
 */
const RETIRED_INTAKE_PATTERNS = ['fbl@*'] as const;

/**
 * Both intake mailboxes are transit buffers, not archives: the DMARC poller
 * persists each report and destroys the object it consumed, and a DSN is only
 * useful until someone has read it. Nothing on the platform reads either
 * mailbox after ingest, so any storage they hold is pure growth.
 *
 * 50 MB each, and reaped below once they fill — an operator decision
 * (2026-09-16) after production accumulated 385 undeliverable DSNs. The
 * previous 256/512 MB were sized as if these were real mailboxes.
 */
const INTAKE_MAILBOX_QUOTA_MB = 50;
const DMARC_MAILBOX_QUOTA_MB = INTAKE_MAILBOX_QUOTA_MB;
const POSTMASTER_MAILBOX_QUOTA_MB = INTAKE_MAILBOX_QUOTA_MB;

/**
 * Reap at 80% rather than at 100%: at 100% Stalwart is already rejecting, so
 * the reports and DSNs that would have told us something are the ones lost.
 */
const INTAKE_REAP_AT_MB = Math.floor(INTAKE_MAILBOX_QUOTA_MB * 0.8);

export interface ReportIntakeResult {
  readonly mailbox: 'exists' | 'created' | 'skipped' | 'failed';
  readonly settings: 'in-sync' | 'updated' | 'skipped';
  /** Every domain that now has a working `dmarc@` intake. */
  readonly dmarcAddresses: readonly string[];
  /** Intake mailboxes emptied this pass by delete-and-recreate. */
  readonly reaped: number;
  /** Intake mailboxes whose size cap was corrected to the current value. */
  readonly resized: number;
}


/**
 * `dmarc@<domain>` as an ALIAS of the postmaster intake, not a second mailbox.
 *
 * Also converges installs that already have a `dmarc@` MAILBOX: it is deleted
 * and replaced by the alias, but ONLY when it is platform-managed and holds
 * nothing (measured: every one of them holds 0 MB, because report-analysis
 * intercepts before storage). A tenant's own hand-made `dmarc@` is never
 * touched.
 *
 * `rua=` targets keep working throughout — the address is unchanged, only what
 * sits behind it. The address is pushed onto `dmarcAddresses` whenever it
 * resolves, so the DNS repair downstream still sees a valid target.
 *
 * Worst case on failure is one tick (5 min) where `dmarc@` has neither mailbox
 * nor alias and reports get a 550. Acceptable for an address that receives
 * machine-generated reports which retry for days, and the next tick recreates
 * it — but it is why the delete is gated on "empty and platform-managed"
 * rather than attempted optimistically.
 */
async function ensureDmarcAlias(
  db: Database,
  logger: OutboundReconcileLogger,
  target: { tenantId: string; emailDomainId: string; domainName: string },
  postmasterMailboxId: string,
  dmarcAddresses: string[],
): Promise<void> {
  const address = `${DMARC_LOCAL_PART}@${target.domainName.toLowerCase()}`;
  try {
    const [legacy] = await db
      .select({
        id: mailboxes.id,
        usedMb: mailboxes.usedMb,
        platformManaged: mailboxes.platformManaged,
      })
      .from(mailboxes)
      .where(and(
        eq(mailboxes.emailDomainId, target.emailDomainId),
        eq(mailboxes.localPart, DMARC_LOCAL_PART),
      ))
      .limit(1);

    if (legacy) {
      if (!legacy.platformManaged) {
        // Theirs. Leave it entirely alone and still report the address as a
        // working rua= target, because it is one.
        dmarcAddresses.push(address);
        return;
      }
      if (legacy.usedMb > 0) {
        // Should not happen (report-analysis intercepts before storage), so if
        // it does, something upstream changed and deleting would lose mail.
        logger.warn(
          { address, usedMb: legacy.usedMb },
          'report intake: dmarc@ mailbox holds mail — left as a mailbox rather than converged to an alias',
        );
        dmarcAddresses.push(address);
        return;
      }
      const { deleteMailbox } = await import('../mailboxes/service.js');
      await deleteMailbox(db, target.tenantId, legacy.id);
      logger.info({ address }, 'report intake: removed the second intake mailbox, converging dmarc@ to an alias');
    }

    const { listMailboxAliases, createMailboxAlias } = await import('../mailbox-aliases/service.js');
    const aliases = await listMailboxAliases(db, target.tenantId, { mailboxId: postmasterMailboxId });
    const has = aliases.some((a) => a.localPart === DMARC_LOCAL_PART);
    if (!has) {
      await createMailboxAlias(db, target.tenantId, postmasterMailboxId, { local_part: DMARC_LOCAL_PART });
      logger.info({ address }, 'report intake: created the dmarc@ alias');
    }
    dmarcAddresses.push(address);
  } catch (err) {
    // Never let the alias step break the intake mailbox that already exists.
    logger.error({ err, address }, 'report intake: dmarc@ alias ensure failed (retries next tick)');
  }
}

export async function ensureReportIntake(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ReportIntakeResult> {
  // ── 1. ONE intake mailbox per enabled email domain, with dmarc@ as an alias ──
  //
  // There used to be two mailboxes. Operator question 2026-09-16: why? The
  // honest answer was that nothing justified it —
  //
  //   * `postmaster@*` and `dmarc@*` are BOTH registered in
  //     REQUIRED_INTAKE_PATTERNS, so Stalwart already treats them identically;
  //     the old docblock claim that pointing `rua=` at postmaster@ would "mix
  //     report parsing with bounces" was already false of the shipped config.
  //   * Neither mailbox stores anything. Measured across 19 of them on a live
  //     cluster: 0 MB used, 7 GB of quota reserved between them. Stalwart's
  //     report-analysis intercepts and parses before storage, so both are RCPT
  //     landing pads — they exist so SMTP does not answer 550.
  //   * `postmaster@` is mandatory (RFC 5321 §4.5.1) and can never be dropped.
  //     `dmarc@` is a name this platform chose.
  //
  // So: one mailbox (`postmaster@`), and `dmarc@` as an ALIAS on it. Chosen
  // over rewriting every published `rua=` to postmaster@ because an alias
  // needs no DNS migration and no propagation window — 10 live `_dmarc`
  // records keep working untouched, RCPT still succeeds for both addresses,
  // and the report pipeline is unchanged. Halves the per-domain footprint with
  // nothing in flight.
  let mailboxState: ReportIntakeResult['mailbox'] = 'skipped';
  const dmarcAddresses: string[] = [];
  const states: ReportIntakeResult['mailbox'][] = [];

  const INTAKES: ReadonlyArray<{
    readonly localPart: string;
    readonly displayName: string;
    readonly quotaMb: number;
    /** Only dmarc@ is reported back as a `rua=` target. */
    readonly isRuaTarget: boolean;
  }> = [
    {
      localPart: POSTMASTER_LOCAL_PART,
      displayName: 'Postmaster / report + DSN intake',
      quotaMb: POSTMASTER_MAILBOX_QUOTA_MB,
      isRuaTarget: false,
    },
  ];

  const reportDomains = await db
    .select({
      tenantId: emailDomains.tenantId,
      emailDomainId: emailDomains.id,
      domainName: domains.domainName,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .where(eq(emailDomains.enabled, 1));

  // ── 1a. reap full intake mailboxes ──
  //
  // Delete-and-recreate rather than per-message expunge: the JMAP client has
  // no Email/query or Email/set, and these mailboxes hold nothing anyone reads
  // after ingest, so the cheap primitive is the right one. Ordering is what
  // makes it safe — the create loop below runs in the SAME pass and puts the
  // address back before this function returns, so there is no tick-long window
  // where mail to `dmarc@`/`postmaster@` has nowhere to land.
  //
  // Only `platform_managed` rows are touched. A tenant who hand-made their own
  // postmaster@ owns it, and it is neither reaped nor resized.
  let reaped = 0;
  let resized = 0;
  const full = await db
    .select({
      id: mailboxes.id,
      tenantId: mailboxes.tenantId,
      fullAddress: mailboxes.fullAddress,
      usedMb: mailboxes.usedMb,
    })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.platformManaged, true),
      gte(mailboxes.usedMb, INTAKE_REAP_AT_MB),
    ));
  for (const box of full) {
    try {
      const { deleteMailbox } = await import('../mailboxes/service.js');
      await deleteMailbox(db, box.tenantId, box.id);
      reaped += 1;
      logger.info(
        { address: box.fullAddress, usedMb: box.usedMb, reapAtMb: INTAKE_REAP_AT_MB },
        'report intake: reaped full intake mailbox (recreated in this same pass)',
      );
    } catch (err) {
      logger.error(
        { err, address: box.fullAddress },
        'report intake: reap of full intake mailbox failed (retries next tick)',
      );
    }
  }

  for (const target of reportDomains) {
    for (const intake of INTAKES) {
      const address = `${intake.localPart}@${target.domainName.toLowerCase()}`;
      const [existing] = await db
        .select({
          id: mailboxes.id,
          stalwartPrincipalId: mailboxes.stalwartPrincipalId,
          quotaMb: mailboxes.quotaMb,
          platformManaged: mailboxes.platformManaged,
        })
        .from(mailboxes)
        .where(and(
          eq(mailboxes.emailDomainId, target.emailDomainId),
          eq(mailboxes.localPart, intake.localPart),
        ))
        .limit(1);

      if (existing) {
        // A row is not a mailbox. `fbl@` on DEV carried a row AND a principal
        // id for a principal Stalwart had lost, and this guard reported
        // "exists" while every report bounced. principals-sync owns detection
        // and the drift UI owns remediation; this reconciler deliberately does
        // not second-guess them, because deleting and recreating a mailbox on
        // the strength of one failed lookup would destroy a real mailbox the
        // moment Stalwart is briefly unreachable.
        // Converge the size cap. The 19 rows that predate the 50 MB decision
        // carry 256/512 MB, and a constant nothing re-asserts is a constant
        // that only applies to installs made after it changed.
        if (existing.platformManaged && existing.quotaMb !== intake.quotaMb) {
          try {
            const { updateMailbox } = await import('../mailboxes/service.js');
            await updateMailbox(db, target.tenantId, existing.id, { quota_mb: intake.quotaMb });
            resized += 1;
            logger.info(
              { address, from: existing.quotaMb, to: intake.quotaMb },
              'report intake: corrected intake mailbox size cap',
            );
          } catch (err) {
            logger.warn({ err, address }, 'report intake: size-cap correction failed (retries next tick)');
          }
        }
        states.push('exists');
        await ensureDmarcAlias(db, logger, target, existing.id, dmarcAddresses);
        continue;
      }

      try {
        const { createMailbox } = await import('../mailboxes/service.js');
        // `platformManaged` keeps this OFF the tenant path: no plan-cap
        // rejection, no tenant-facing "remove a mailbox or upgrade your plan"
        // notification for a mailbox the platform is creating for its own
        // DMARC/DSN intake, and no consumption of the tenant's paid quota.
        // Without it this call was rejected on every 5-minute tick for every
        // capped tenant and emailed them about it each time.
        const createdMailbox = await createMailbox(db, target.tenantId, target.emailDomainId, {
          local_part: intake.localPart,
          display_name: intake.displayName,
          quota_mb: intake.quotaMb,
          mailbox_type: 'mailbox',
        }, { platformManaged: true });
        states.push('created');
        logger.info({ address }, 'report intake: created intake mailbox');
        // `createMailbox` returns the row, so the alias step uses that id
        // rather than re-reading it — one query fewer, and no chance of
        // reading back a row a concurrent pass has changed.
        if (createdMailbox?.id) {
          await ensureDmarcAlias(db, logger, target, createdMailbox.id, dmarcAddresses);
        }
      } catch (err) {
        states.push('failed');
        logger.error(
          { err, domain: target.domainName, localPart: intake.localPart },
          'report intake: intake mailbox creation failed (will retry)',
        );
      }
    }
  }

  // Worst state wins. Reporting 'exists' because one of N domains was already
  // there would hide a failure on another — and the failure mode is silent by
  // nature: reports simply never arrive.
  if (states.length > 0) {
    mailboxState = states.includes('failed')
      ? 'failed'
      : states.includes('created')
        ? 'created'
        : 'exists';
  }

  // ── 2. ReportSettings intake patterns ──
  let settingsState: ReportIntakeResult['settings'] = 'skipped';
  try {
    const current = await reportSettingsGet(opts);
    const addresses: Record<string, boolean> = { ...(current?.inboundReportAddresses ?? {}) };
    let changed = false;
    for (const pattern of REQUIRED_INTAKE_PATTERNS) {
      if (!addresses[pattern]) {
        addresses[pattern] = true;
        changed = true;
      }
    }
    for (const pattern of RETIRED_INTAKE_PATTERNS) {
      if (pattern in addresses) {
        delete addresses[pattern];
        changed = true;
      }
    }

    if (!changed) {
      settingsState = 'in-sync';
    } else {
      const res = await reportSettingsUpdate({ patch: { inboundReportAddresses: addresses }, ...opts });
      if (res.notUpdated && Object.keys(res.notUpdated).length > 0) {
        logger.error({ failures: res.notUpdated }, 'report intake: ReportSettings update failed');
      } else {
        // Report-analysis config is boot-loaded; the reload action
        // re-reads it live (same mechanism as the MTA throttles).
        await actionReloadSettings(opts);
        settingsState = 'updated';
        logger.info(
          { patterns: REQUIRED_INTAKE_PATTERNS, removed: RETIRED_INTAKE_PATTERNS },
          'report intake: ReportSettings updated + reloaded',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'report intake: Stalwart JMAP unreachable for ReportSettings, skipped');
  }

  return { mailbox: mailboxState, settings: settingsState, dmarcAddresses, reaped, resized };
}
