/**
 * Outbound DMARC aggregate reporting: off unless an operator names a sender.
 *
 * Why this exists
 * ---------------
 * Stalwart's built-in default is `aggregateSendFrequency: daily` with
 * `aggregateFromAddress: 'noreply-dmarc@' + system('domain')`. Read live on
 * 2026-09-16, the `x:DmarcReportSettings` singleton was EMPTY — and empty does
 * not mean off, it means those defaults apply. So a fresh install sends
 * aggregate reports from a hostname-derived address on a domain the operator
 * does not control and which has no mailbox: 78 reports went out in 6 hours,
 * and a DSN for any of them hits `550 5.1.2` because nothing accepts mail
 * there.
 *
 * The fix is not to guess a better default sender — the platform cannot know
 * one at bootstrap. It is to send nothing until an operator picks a real local
 * `postmaster@`, which the platform maintains on every email-enabled domain
 * and which therefore definitely accepts the DSNs.
 *
 * Why the setting is the switch
 * -----------------------------
 * There is no separate enable flag. Empty (or the literal DISABLE sentinel)
 * means disabled; an address means enabled. Two settings could disagree with
 * each other, and a control that disagrees with reality is what the
 * 2026-09-16 notification epic spent its day removing.
 *
 * Why it is reconciled rather than set once
 * -----------------------------------------
 * The singleton starts empty, so a Stalwart restore or re-init silently
 * reverts to hostname-derived sending. Pushing the desired state on the
 * existing 5-minute mail self-heal tick means the bug cannot come back
 * quietly. The same reasoning as the report-intake and throttle reconcilers
 * next door.
 */
import { and, eq } from 'drizzle-orm';
import { mailboxes, emailDomains, domains, tenants, platformSettings } from '../../db/schema.js';
import { POSTMASTER_LOCAL_PART } from './report-intake-reconciler.js';
import {
  dmarcReportSettingsGet,
  dmarcReportSettingsUpdate,
  type StalwartExpression,
  type StalwartDmarcReportSettingsRow,
} from '../stalwart-jmap/client.js';
import { commitSettingsGroup } from '../stalwart-jmap/settings-group.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

export type { OutboundReconcileLogger };

/** platform_settings key holding the chosen sender, or the DISABLE sentinel. */
export const DMARC_REPORT_SENDER_KEY = 'dmarc_report_sender';

/**
 * The value that means "do not send". Stored explicitly rather than as an
 * empty string so an operator choosing it is distinguishable from a setting
 * nobody has touched — both disable, but only one is a decision.
 */
export const DMARC_REPORT_SENDER_DISABLED = 'disabled';

/** How often reports go out once a sender is configured. */
const SEND_FREQUENCY = 'daily';

const expr = (value: string): StalwartExpression => ({ match: {}, else: `'${value}'` });

/**
 * A raw (unquoted) Stalwart expression, for the non-string fields of the group
 * — `aggregateContactInfo` is a boolean and `aggregateMaxReportSize` a number.
 * Quoting them would store the literal string `'false'`.
 */
const rawExpr = (value: string): StalwartExpression => ({ match: {}, else: value });

/** Stalwart's own keyword for "do not send these at all". */
const DISABLE = 'disable';

/**
 * EVERY field of `x:DmarcReportSettings`, so the commit patch is never partial.
 *
 * Measured on a FRESH, bootstrapped Stalwart v0.16.20 (2026-09-18, throwaway
 * cluster, using this client's exact call shape):
 *
 *     complete patch x4, identical   -> accepted every time, NEVER stored
 *     1-field primer, then complete  -> primer stores nothing, COMPLETE LANDS
 *     warm group, single complete    -> lands immediately, both directions
 *
 * Two rules, and both are needed:
 *
 *  1. The first `/set` against a never-written singleton PRIMES it and stores
 *     nothing. The next one persists — and it must state every field, since a
 *     partial commit leaves the group unwritten.
 *  2. Stalwart DEDUPES an identical repeat, so re-sending the same patch is not
 *     "the next write". That is exactly why production never converged: the
 *     reconciler sent the same patch every 5 minutes for weeks, each one
 *     deduped, the group never materialised, and Stalwart's built-in defaults
 *     stayed live — 47 aggregate reports a day — while the log said DISABLED.
 *
 * The singleton also cannot be created or destroyed (`destroy` returns
 * "Singletons cannot be created or destroyed"), so an environment whose group
 * already exists — DEV, staging — CANNOT reproduce any of this. That is how
 * "the field COUNT matters" (#612) and "an ADDRESS field materialises the
 * group" (#621) were each validated against a warm environment and shipped
 * broken. Reproducing it needs a cluster bootstrapped from empty.
 */
export const DMARC_SETTINGS_FIELDS = [
  'aggregateSendFrequency',
  'aggregateFromAddress',
  'aggregateFromName',
  'aggregateOrgName',
  'aggregateDkimSignDomain',
  'aggregateSubject',
  'aggregateContactInfo',
  'aggregateMaxReportSize',
  'failureSendFrequency',
  'failureFromAddress',
  'failureFromName',
  'failureDkimSignDomain',
  'failureSubject',
] as const;

/**
 * Stalwart's own defaults for the fields the platform has no opinion about.
 * They are written verbatim so the patch is COMPLETE without changing any
 * behaviour the operator can observe.
 */
const PRESENTATION_DEFAULTS = {
  aggregateFromName: expr('Report Subsystem'),
  aggregateSubject: expr('DMARC Aggregate Report'),
  aggregateContactInfo: rawExpr('false'),
  aggregateMaxReportSize: rawExpr('5242880'),
  failureFromName: expr('Report Subsystem'),
  failureSubject: expr('DMARC Authentication Failure Report'),
} as const;

/**
 * Build the COMPLETE settings group.
 *
 * `sender` is the envelope/From address for report mail and `domain` the
 * organisation + DKIM-signing domain. The failure half is pinned to the same
 * identity rather than left at Stalwart's `'noreply-dmarc@' + system('domain')`
 * default: gating one half and leaving the other pointing at an address nobody
 * owns is the bug, not the fix. It stays `disable` in both directions.
 */
function buildSettingsPatch(params: {
  aggregateFrequency: string;
  sender: string;
  domain: string;
}): Record<string, unknown> {
  const { aggregateFrequency, sender, domain } = params;
  return {
    ...PRESENTATION_DEFAULTS,
    aggregateSendFrequency: expr(aggregateFrequency),
    aggregateFromAddress: expr(sender),
    aggregateOrgName: expr(domain),
    aggregateDkimSignDomain: expr(domain),
    // Failure (forensic, `ruf=`) reports stay OFF even when aggregate
    // reporting is on: a failure report forwards headers of somebody's
    // individual message to whoever asked for it, and turning that on is not
    // implied by "send DMARC reports".
    failureSendFrequency: expr(DISABLE),
    failureFromAddress: expr(sender),
    failureDkimSignDomain: expr(domain),
  };
}

export interface EligibleReportSender {
  readonly address: string;
  readonly domainName: string;
  /**
   * `tenants.name` is NOT NULL, so this is a plain string. It was briefly typed
   * nullable "just in case" — which made the dropdown's `tenantName
   * .toLowerCase()` search a latent TypeError against a state the column
   * cannot hold, and disagreed with the api-contract that declares it
   * required.
   */
  readonly tenantName: string;
  readonly isSystemTenant: boolean;
}

/**
 * Every address an operator may choose: `postmaster@` on an email-enabled
 * domain of an ACTIVE tenant, including the SYSTEM tenant when its domain has
 * email enabled.
 *
 * Only `postmaster@` — no other mailbox is offered. It is the one address the
 * platform creates and maintains on every enabled domain, so it is the only
 * one guaranteed to still accept DSNs tomorrow. Offering an arbitrary mailbox
 * would let an operator pick something a tenant can delete.
 *
 * Suspended and archived tenants are excluded: their outbound mail is blocked
 * at the queue, so choosing one would configure a sender that cannot send.
 */
export async function eligibleReportSenders(db: Database): Promise<EligibleReportSender[]> {
  const rows = await db
    .select({
      address: mailboxes.fullAddress,
      domainName: domains.domainName,
      tenantName: tenants.name,
      isSystem: tenants.isSystem,
    })
    .from(mailboxes)
    .innerJoin(emailDomains, eq(mailboxes.emailDomainId, emailDomains.id))
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .innerJoin(tenants, eq(mailboxes.tenantId, tenants.id))
    .where(and(
      eq(mailboxes.localPart, 'postmaster'),
      eq(mailboxes.platformManaged, true),
      eq(emailDomains.enabled, 1),
      eq(tenants.status, 'active'),
    ));

  return rows
    .map((r) => ({
      address: r.address,
      domainName: r.domainName,
      tenantName: r.tenantName,
      isSystemTenant: r.isSystem === true,
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

export type DmarcSenderState = 'disabled' | 'enabled' | 'in-sync' | 'skipped';

export interface DmarcReportSenderResult {
  readonly state: DmarcSenderState;
  /** The address now configured in Stalwart, or null when reporting is off. */
  readonly sender: string | null;
  /** Set when a configured address was rejected and reporting fell back to off. */
  readonly reason?: string;
}

/**
 * Push the desired outbound-reporting state into Stalwart.
 *
 * A configured address is re-validated against the eligible list on EVERY
 * tick, not just when it is saved. A tenant can be suspended, or their domain
 * disabled, long after an operator chose their `postmaster@` — and continuing
 * to send reports from an address that no longer works is the failure this
 * whole change exists to prevent. When that happens reporting falls back to
 * disabled and says so.
 */
export async function ensureDmarcReportSender(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<DmarcReportSenderResult> {
  let configured: string | null = null;
  try {
    // Read straight from platform_settings: the helpers in webmail-settings
    // are private to that module, and this reconciler should not depend on it
    // just to read one key.
    const [row] = await db
      .select({ value: platformSettings.value })
      .from(platformSettings)
      .where(eq(platformSettings.key, DMARC_REPORT_SENDER_KEY));
    configured = row?.value?.trim() || null;
  } catch (err) {
    logger.warn({ err }, 'dmarc report sender: could not read the setting — leaving Stalwart untouched');
    return { state: 'skipped', sender: null, reason: 'setting unreadable' };
  }

  let desired: string | null = null;
  let reason: string | undefined;

  if (configured && configured !== DMARC_REPORT_SENDER_DISABLED) {
    const eligible = await eligibleReportSenders(db);
    if (eligible.some((e) => e.address === configured)) {
      desired = configured;
    } else {
      // Not an error the operator caused now — the world moved. A tenant was
      // deleted, suspended, or their domain had email disabled, and the
      // address they chose no longer exists.
      reason = `configured sender ${configured} is no longer an active postmaster address`;
      logger.error({ configured }, `dmarc report sender: ${reason} — reporting disabled`);

      // Reset the STORED setting too, not just the Stalwart side. Leaving the
      // dead address in platform_settings would show the operator a sender
      // that is configured-looking but inert — reporting silently off while
      // the panel claims an address. Operator requirement 2026-09-16.
      try {
        await db
          .insert(platformSettings)
          .values({ key: DMARC_REPORT_SENDER_KEY, value: DMARC_REPORT_SENDER_DISABLED })
          .onConflictDoUpdate({
            target: platformSettings.key,
            set: { value: DMARC_REPORT_SENDER_DISABLED },
          });
        logger.info(
          { previous: configured },
          'dmarc report sender: setting reset to disabled because the chosen mailbox is gone',
        );
      } catch (err) {
        // The Stalwart write below still disables sending, so the worst case
        // is a stale value in the panel until the next tick.
        logger.warn({ err }, 'dmarc report sender: could not reset the stored setting');
      }
    }
  }

  // Both patches state EVERY field this platform has an opinion about, in both
  // directions. Two reasons, and the first was found on DEV:
  //
  //  1. A patch of SCHEDULE fields alone against a settings group Stalwart has
  //     never written is ACCEPTED (`updated: {singleton: null}`, nothing in
  //     `notUpdated`) and stores NOTHING. An empty group means the built-in
  //     defaults are live — `daily` from `noreply-dmarc@` + the server's own
  //     hostname domain — so the disable logged success while leaving the exact
  //     bug this module exists to prevent in place.
  //
  //     What materialises the group is an ADDRESS field, not a second field.
  //     Measured on staging 2026-09-17, same connection, read back after each:
  //
  //       {aggregateSendFrequency, failureSendFrequency}   -> accepted, read NULL
  //       {aggregateSendFrequency, aggregateFromAddress}   -> accepted, and now
  //                                                           ALL THREE appear,
  //                                                           including the
  //                                                           failure value the
  //                                                           first patch set
  //
  //     So both directions carry the address fields. The first fix for this
  //     assumed the field COUNT mattered and shipped a two-schedule-field
  //     patch; it passed on DEV only because an earlier diagnostic probe had
  //     already created that group with an address in it. Verifying in an
  //     environment your own probing prepared proves nothing about a fresh
  //     install.
  //
  //  2. Failure (forensic / `ruf=`) reports are the same subsystem with the
  //     same defaults — `failureSendFrequency: [1, 1d]` from
  //     `'noreply-dmarc@' + system('domain')`. Gating only the aggregate half
  //     would have left the other half sending from an address nobody owns.
  //     They stay OFF even when aggregate reporting is on: a failure report
  //     forwards headers of somebody's individual message to whoever asked for
  //     it, and turning that on is not implied by "send DMARC reports".
  // The disable patch needs an address to materialise the group, and the only
  // address the platform always owns is postmaster@ on its own mail hostname.
  // Without it a disable patch is accepted and stores nothing, so refusing
  // here is better than reporting a disable that did not happen.
  let hostname: string | null = null;
  try {
    const { getExplicitMailHostname } = await import('../mail-admin/stalwart-domain-reconciler.js');
    hostname = (await getExplicitMailHostname(db))?.trim().replace(/\.+$/, '').toLowerCase() ?? null;
  } catch (err) {
    logger.warn({ err }, 'dmarc report sender: could not resolve the mail hostname');
  }
  if (!desired && !hostname) {
    logger.error(
      'dmarc report sender: no mail hostname — cannot write a disable that persists, leaving Stalwart '
      + 'untouched rather than logging a disable that stored nothing',
    );
    return { state: 'skipped', sender: null, reason: 'no mail hostname for the disable patch' };
  }

  // Explicit branches rather than a ternary: the guard above proves `hostname`
  // is non-null on the disable path, and TypeScript can only carry that
  // narrowing through an `if`.
  let patch: Record<string, unknown>;
  if (desired) {
    // Org name and DKIM signing follow the sender's own domain, so a report is
    // signed by the domain it claims to come from.
    patch = buildSettingsPatch({
      aggregateFrequency: SEND_FREQUENCY,
      sender: desired,
      domain: desired.slice(desired.indexOf('@') + 1),
    });
  } else {
    const host = hostname as string;
    // The address is `postmaster@<mail hostname>`, which since 2026-09-17 is a
    // real deliverable address forwarding to the admin roster — so in the
    // worst case, where a future change lets sending happen while this says
    // `disable`, reports come from somewhere a person reads instead of a black
    // hole. Nothing sends while the schedule is `disable`.
    patch = buildSettingsPatch({
      aggregateFrequency: DISABLE,
      sender: `${POSTMASTER_LOCAL_PART}@${host}`,
      domain: host,
    });
  }

  // Skip the write when Stalwart already agrees. The singleton being EMPTY is
  // not agreement — empty means the built-in defaults are live, which is the
  // state this function exists to overwrite.
  // Hoisted: the write below needs to know whether the group was COLD.
  let cold = false;
  try {
    const current = await dmarcReportSettingsGet(opts);
    cold = current === null || current === undefined;
    const currentFreq = current?.aggregateSendFrequency?.else;
    const currentFrom = current?.aggregateFromAddress?.else;
    const wantFreq = (patch.aggregateSendFrequency as StalwartExpression).else;
    // When disabling, the patch deliberately leaves `aggregateFromAddress`
    // alone — `disable` already stops every send, and clearing the address
    // would lose the operator's last choice. So the sender must NOT be part of
    // the comparison in that direction: it still holds the old address, and
    // demanding it match would make this never look in-sync and rewrite the
    // same patch (plus a log line) on every 5-minute tick, forever.
    // The failure half is part of the comparison in BOTH directions: it is
    // always meant to be off, so leaving it out would let a live
    // `failureSendFrequency` sit there looking in-sync.
    const currentFailure = current?.failureSendFrequency?.else;
    const wantFailure = (patch.failureSendFrequency as StalwartExpression).else;
    const agrees = currentFailure === wantFailure && (desired
      ? currentFreq === wantFreq
        && currentFrom === (patch.aggregateFromAddress as StalwartExpression).else
      : currentFreq === wantFreq);
    if (current && agrees) {
      return { state: 'in-sync', sender: desired, reason };
    }
  } catch (err) {
    logger.warn({ err }, 'dmarc report sender: could not read current Stalwart settings — writing anyway');
  }

  try {
    // Prime-when-cold, commit the complete group, then read it back. The rule
    // and the measurements behind it live in stalwart-jmap/settings-group.ts;
    // the primer is one field against a thirteen-field commit so Stalwart
    // cannot dedupe the two.
    const wantAggregate = (patch.aggregateSendFrequency as StalwartExpression).else;
    const wantFailureFreq = (patch.failureSendFrequency as StalwartExpression).else;
    const outcome = await commitSettingsGroup<StalwartDmarcReportSettingsRow>({
      read: () => dmarcReportSettingsGet(opts),
      write: (p) => dmarcReportSettingsUpdate({ patch: p, ...opts }),
      patch,
      primer: { aggregateSendFrequency: patch.aggregateSendFrequency },
      verify: (row) => row.aggregateSendFrequency?.else === wantAggregate
        && row.failureSendFrequency?.else === wantFailureFreq,
      current: cold ? null : undefined,
    });

    if (outcome.state === 'rejected') {
      logger.error({ reason: outcome.reason }, 'dmarc report sender: Stalwart rejected the update');
      return { state: 'skipped', sender: null, reason: 'stalwart rejected the update' };
    }
    if (outcome.state === 'not-stored') {
      logger.error(
        {
          wrote: { aggregate: wantAggregate, failure: wantFailureFreq },
          readBack: outcome.after
            ? {
              aggregate: outcome.after.aggregateSendFrequency?.else,
              failure: outcome.after.failureSendFrequency?.else,
            }
            : 'EMPTY — the settings group does not exist, so Stalwart\'s built-in defaults are LIVE',
          fields: Object.keys(patch).length,
          wasCold: outcome.wasCold,
        },
        'dmarc report sender: Stalwart ACCEPTED the update and did not store it — outbound reporting '
        + 'is NOT in the intended state. Reports may still be going out.',
      );
      return {
        state: 'skipped',
        sender: null,
        reason: 'stalwart accepted the update but did not store it',
      };
    }

    logger.info(
      { sender: desired, frequency: desired ? SEND_FREQUENCY : 'disable' },
      desired
        ? 'dmarc report sender: outbound aggregate reporting enabled'
        : 'dmarc report sender: outbound aggregate reporting DISABLED (no sender configured)',
    );
    return { state: desired ? 'enabled' : 'disabled', sender: desired, reason };
  } catch (err) {
    // Never let this break the rest of the mail self-heal tick.
    logger.error({ err }, 'dmarc report sender: update failed (retries next tick)');
    return { state: 'skipped', sender: null, reason: 'update threw' };
  }
}
