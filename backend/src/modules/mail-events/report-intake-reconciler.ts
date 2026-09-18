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
 * ## FBL was retired
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

import { eq, and, gte, lt, or, isNull, sql } from 'drizzle-orm';
import { domains, emailAliases, emailDomains, mailboxAliases, mailboxes } from '../../db/schema.js';
import {
  reportSettingsGet,
  reportSettingsUpdate,
  actionReloadSettings,
  type StalwartReportSettingsRow,
} from '../stalwart-jmap/client.js';
import { commitSettingsGroup } from '../stalwart-jmap/settings-group.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

/**
 * DMARC `rua=` addresses point here. It must be a REAL principal: Stalwart does
 * not bypass RCPT validation for report addresses, so an unregistered address
 * answers `550 5.1.2 Mailbox does not exist` and the report is never parsed.
 * Re-confirmed on a live server — `postmaster@<apex>`, which is in
 * the pattern list but has no account, is refused at RCPT.
 */
export const DMARC_LOCAL_PART = 'dmarc';

/**
 * `postmaster@` must be a REAL principal for the same reason `dmarc@` is, and
 * it had been listed in REQUIRED_INTAKE_PATTERNS since this file was written
 * while nothing ever created the account. Measured on DEV:
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

/**
 * `abuse@` — the other address RFC 2142 makes mandatory for a mail-receiving
 * domain, and the one a remote operator, a blocklist, or a mailbox provider's
 * abuse desk reaches for when mail from a tenant's domain misbehaves. It was
 * not created anywhere, so every one of those attempts got
 * `550 5.1.2 Mailbox does not exist` — the platform looked unreachable exactly
 * when somebody was trying to tell us about a problem.
 *
 * An ALIAS on the postmaster intake, not a mailbox: the two audiences overlap
 * completely (the operator reading one reads the other) and a second mailbox
 * would be a second thing to reap. Operator decision.
 */
export const ABUSE_LOCAL_PART = 'abuse';

/** Patterns Stalwart must treat as report intake. */
const REQUIRED_INTAKE_PATTERNS = [
  'postmaster@*',
  `${DMARC_LOCAL_PART}@*`,
  // `abuse@*` IS here, and was deliberately absent before abuse-report
  // ingestion existed. Both halves of that reversal matter:
  //
  //   Why it was excluded: a pattern in this list hands the mail to Stalwart's
  //   report-analysis, which parses an ARF report and consumes it rather than
  //   delivering it. With nothing on the platform consuming the resulting
  //   `incoming-report.abuse-report` event, registering `abuse@*` would have
  //   made every machine-readable complaint vanish while SMTP said 250 —
  //   strictly worse than the 550 it replaced, and invisible.
  //
  //   Why it is included now: `abuse-reports.ts` polls those objects, files
  //   them, notifies the admin roster and shows them in both panels. Consume
  //   first, intercept second — in that order, never the reverse.
  //
  // Leaving it out had its own cost, which is what this fixes: `abuse@` is the
  // address RFC 2142 designates and the one abuse desks and blocklist
  // operators actually send ARF to, so the complaints most worth having were
  // the ones never parsed.
  //
  // Non-report mail to an intake address is NOT swallowed — it is delivered
  // normally. Measured on production before this change: `postmaster@` already
  // matched `postmaster@*`, and a remote DSN (not a report) was still queued
  // and delivered to the admin roster. So prose to `abuse@` keeps reaching the
  // intake mailbox exactly as it does today.
  `${ABUSE_LOCAL_PART}@*`,
] as const;

/**
 * Patterns to REMOVE. Leaving `fbl@*` registered after retiring FBL would keep
 * Stalwart diverting mail to a parser whose output nothing consumes.
 */
const RETIRED_INTAKE_PATTERNS = ['fbl@*'] as const;

/**
 * Do NOT forward analysed reports to a human.
 *
 * `inboundReportForwarding` decides whether Stalwart, having parsed an
 * incoming report that matched one of the patterns above, ALSO delivers a copy
 * to the recipient. It shipped `true`, so every DMARC aggregate and TLS-RPT
 * report the platform already ingests was additionally dropped into a mailbox
 * — and on the mail hostname that mailbox is a list fanning out to the admin
 * roster. Operators got machine mail they cannot act on and that the platform
 * has already stored.
 *
 * Tenants read their own DMARC results at Tenant → Email → Authentication;
 * nothing on the platform reads the forwarded copy. Turning this off keeps the
 * ingestion and stops the copies.
 *
 * Scope, checked against Stalwart's docs before relying on it: the flag
 * applies ONLY to messages recognised as reports at the intake patterns. It
 * does not touch DSNs, bounces, or ordinary mail — so `postmaster@` and
 * `abuse@` keep receiving everything a human is actually meant to see, and
 * they keep ACCEPTING mail (a 550 here is what left 385 undeliverable DSNs
 * queued and retrying every 24h — see POSTMASTER_LOCAL_PART above).
 */
const REPORT_FORWARDING = false;

/**
 * The rest of the `x:ReportSettings` group, at Stalwart's own defaults.
 *
 * Stated verbatim because a commit against a never-written group only persists
 * when it names EVERY field — see stalwart-jmap/settings-group.ts. Read off a
 * live warm instance rather than guessed; writing them changes nothing an
 * operator can observe.
 */
const REPORT_SETTINGS_DEFAULTS = {
  outboundReportDomain: null,
  outboundReportSubmitter: { match: {}, else: "system('hostname')" },
  inboundReportMaxSize: 26214400,
} as const;

/**
 * Both intake mailboxes are transit buffers, not archives: the DMARC poller
 * persists each report and destroys the object it consumed, and a DSN is only
 * useful until someone has read it. Nothing on the platform reads either
 * mailbox after ingest, so any storage they hold is pure growth.
 *
 * 50 MB each, and reaped below once they fill — an operator decision
 * after production accumulated 385 undeliverable DSNs. The
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

/**
 * Empty an intake mailbox every 30 days regardless of size — operator decision
 * .
 *
 * The size trigger above never fires in practice: report-analysis intercepts
 * and parses before storage, so these mailboxes measure 0 MB. A retention rule
 * that cannot fire is not a retention rule. Anything that DOES land — a DSN
 * Stalwart chose not to consume, a report it could not parse — would otherwise
 * sit forever.
 */
const INTAKE_REAP_AFTER_DAYS = 30;

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
interface IntakeAliasSpec {
  readonly localPart: string;
  /** Only `dmarc@` is reported back as a published `rua=` target. */
  readonly isRuaTarget: boolean;
  /**
   * Whether a platform-managed EMPTY mailbox on this address may be deleted
   * and replaced by the alias.
   *
   * True for `dmarc@` only, because that convergence is a migration the
   * platform itself created and must undo. `abuse@` never had a
   * platform-managed mailbox, so there is nothing of ours to converge — and
   * deleting a mailbox on the strength of a name match is how you lose a
   * tenant's real abuse desk.
   */
  readonly convergeLegacyPlatformMailbox: boolean;
}

/**
 * The addresses that ride on the postmaster intake as aliases.
 *
 * Both are RFC 2142 obligations, neither needs its own mailbox, and both are
 * read by the same person. Adding one here is all it takes for every
 * email-enabled domain — existing and future — to answer it.
 */
const INTAKE_ALIASES: readonly IntakeAliasSpec[] = [
  { localPart: DMARC_LOCAL_PART, isRuaTarget: true, convergeLegacyPlatformMailbox: true },
  { localPart: ABUSE_LOCAL_PART, isRuaTarget: false, convergeLegacyPlatformMailbox: false },
];

/**
 * Is this address already answered by something — a mailbox, a mailing list,
 * or an alias on another mailbox?
 *
 * Checked BEFORE creating, rather than catching the 409 that
 * `createMailboxAlias` would throw, because "already answered" is the success
 * condition here, not an error. The goal is that SMTP does not say 550; who
 * owns the address is the tenant's business.
 */
async function addressIsAnswered(db: Database, fullAddress: string): Promise<boolean> {
  const [box] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.fullAddress, fullAddress))
    .limit(1);
  if (box) return true;
  const [list] = await db
    .select({ id: emailAliases.id })
    .from(emailAliases)
    .where(eq(emailAliases.sourceAddress, fullAddress))
    .limit(1);
  if (list) return true;
  const [alias] = await db
    .select({ id: mailboxAliases.id })
    .from(mailboxAliases)
    .where(eq(mailboxAliases.fullAddress, fullAddress))
    .limit(1);
  return Boolean(alias);
}

async function ensureIntakeAlias(
  db: Database,
  logger: OutboundReconcileLogger,
  target: { tenantId: string; emailDomainId: string; domainName: string },
  postmasterMailboxId: string,
  spec: IntakeAliasSpec,
  ruaAddresses: string[],
): Promise<void> {
  const address = `${spec.localPart}@${target.domainName.toLowerCase()}`;
  try {
    if (spec.convergeLegacyPlatformMailbox) {
      const [legacy] = await db
        .select({
          id: mailboxes.id,
          usedMb: mailboxes.usedMb,
          platformManaged: mailboxes.platformManaged,
        })
        .from(mailboxes)
        .where(and(
          eq(mailboxes.emailDomainId, target.emailDomainId),
          eq(mailboxes.localPart, spec.localPart),
        ))
        .limit(1);

      if (legacy) {
        if (!legacy.platformManaged) {
          // Theirs. Leave it entirely alone and still report the address as a
          // working rua= target, because it is one.
          if (spec.isRuaTarget) ruaAddresses.push(address);
          return;
        }
        if (legacy.usedMb > 0) {
          // Should not happen (report-analysis intercepts before storage), so
          // if it does, something upstream changed and deleting would lose mail.
          logger.warn(
            { address, usedMb: legacy.usedMb },
            'report intake: intake mailbox holds mail — left as a mailbox rather than converged to an alias',
          );
          if (spec.isRuaTarget) ruaAddresses.push(address);
          return;
        }
        const { deleteMailbox } = await import('../mailboxes/service.js');
        await deleteMailbox(db, target.tenantId, legacy.id);
        logger.info(
          { address },
          'report intake: removed the second intake mailbox, converging the address to an alias',
        );
      }
    }

    const { listMailboxAliases, createMailboxAlias } = await import('../mailbox-aliases/service.js');
    const aliases = await listMailboxAliases(db, target.tenantId, { mailboxId: postmasterMailboxId });
    if (!aliases.some((a) => a.localPart === spec.localPart)) {
      // Somebody else may already answer this address — the tenant's own
      // `abuse@` mailbox, a mailing list, an alias on a different mailbox. That
      // is a SUCCESS: the address does not 550, which is the whole point. Only
      // claim it when it is free.
      if (await addressIsAnswered(db, address)) {
        logger.info(
          { address },
          'report intake: address already answered by a tenant-owned mailbox/alias — left alone',
        );
        if (spec.isRuaTarget) ruaAddresses.push(address);
        return;
      }
      await createMailboxAlias(db, target.tenantId, postmasterMailboxId, { local_part: spec.localPart });
      logger.info({ address }, 'report intake: created the intake alias');
    }
    if (spec.isRuaTarget) ruaAddresses.push(address);
  } catch (err) {
    // Never let the alias step break the intake mailbox that already exists.
    logger.error({ err, address }, 'report intake: intake alias ensure failed (retries next tick)');
  }
}

export async function ensureReportIntake(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ReportIntakeResult> {
  // ── 1. ONE intake mailbox per enabled email domain, with dmarc@ as an alias ──
  //
  // There used to be two mailboxes. Operator question: why? The
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
  // Two triggers, one pass: FULL (the safety net) or DUE (the real schedule).
  // A NULL `last_reaped_at` counts as due, but migration 0127 baselines every
  // existing row to NOW() so a deploy does not reap all of them at once.
  const full = await db
    .select({
      id: mailboxes.id,
      tenantId: mailboxes.tenantId,
      fullAddress: mailboxes.fullAddress,
      usedMb: mailboxes.usedMb,
      lastReapedAt: mailboxes.lastReapedAt,
    })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.platformManaged, true),
      or(
        gte(mailboxes.usedMb, INTAKE_REAP_AT_MB),
        isNull(mailboxes.lastReapedAt),
        lt(mailboxes.lastReapedAt, sql`NOW() - INTERVAL '${sql.raw(String(INTAKE_REAP_AFTER_DAYS))} days'`),
      ),
    ));
  for (const box of full) {
    try {
      const { deleteMailbox } = await import('../mailboxes/service.js');
      await deleteMailbox(db, box.tenantId, box.id);
      reaped += 1;
      logger.info(
        {
          address: box.fullAddress,
          usedMb: box.usedMb,
          reapAtMb: INTAKE_REAP_AT_MB,
          trigger: box.usedMb >= INTAKE_REAP_AT_MB ? 'full' : `age>${INTAKE_REAP_AFTER_DAYS}d`,
          lastReapedAt: box.lastReapedAt?.toISOString() ?? null,
        },
        'report intake: emptied intake mailbox (recreated in this same pass)',
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
        for (const spec of INTAKE_ALIASES) {
          await ensureIntakeAlias(db, logger, target, existing.id, spec, dmarcAddresses);
        }
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
          for (const spec of INTAKE_ALIASES) {
            await ensureIntakeAlias(db, logger, target, createdMailbox.id, spec, dmarcAddresses);
          }
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

  // ── 2. ReportSettings: intake patterns + report forwarding ──
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
    if (current?.inboundReportForwarding !== REPORT_FORWARDING) changed = true;
    // A group that has never been written is NOT in sync: empty means
    // Stalwart's built-in defaults are live, which is the state to overwrite.
    if (!current) changed = true;

    if (!changed) {
      settingsState = 'in-sync';
    } else {
      const outcome = await commitSettingsGroup<StalwartReportSettingsRow>({
        read: () => reportSettingsGet(opts),
        write: (patch) => reportSettingsUpdate({ patch, ...opts }),
        patch: {
          ...REPORT_SETTINGS_DEFAULTS,
          inboundReportAddresses: addresses,
          inboundReportForwarding: REPORT_FORWARDING,
        },
        // One field against a five-field commit, so Stalwart cannot dedupe the
        // primer against the commit that follows it.
        primer: { inboundReportForwarding: REPORT_FORWARDING },
        verify: (row) => row.inboundReportForwarding === REPORT_FORWARDING
          && REQUIRED_INTAKE_PATTERNS.every((pattern) => row.inboundReportAddresses?.[pattern] === true)
          && RETIRED_INTAKE_PATTERNS.every((pattern) => !(pattern in (row.inboundReportAddresses ?? {}))),
        current,
      });

      if (outcome.state !== 'committed') {
        logger.error(
          { reason: outcome.reason, wasCold: outcome.wasCold },
          'report intake: ReportSettings did NOT land — Stalwart accepted the write and kept its own '
          + 'state, so report intake is not in the intended state',
        );
      } else {
        // Report-analysis config is boot-loaded; the reload action
        // re-reads it live (same mechanism as the MTA throttles).
        await actionReloadSettings(opts);
        settingsState = 'updated';
        logger.info(
          {
            patterns: REQUIRED_INTAKE_PATTERNS,
            removed: RETIRED_INTAKE_PATTERNS,
            forwarding: REPORT_FORWARDING,
            wasCold: outcome.wasCold,
          },
          'report intake: ReportSettings updated + reloaded',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'report intake: Stalwart JMAP unreachable for ReportSettings, skipped');
  }

  return { mailbox: mailboxState, settings: settingsState, dmarcAddresses, reaped, resized };
}
