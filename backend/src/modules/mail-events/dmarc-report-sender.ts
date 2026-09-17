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
import {
  dmarcReportSettingsGet,
  dmarcReportSettingsUpdate,
  type StalwartExpression,
} from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

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

  const patch: Record<string, unknown> = desired
    ? {
      aggregateSendFrequency: expr(SEND_FREQUENCY),
      aggregateFromAddress: expr(desired),
      // Org name and DKIM signing follow the sender's own domain, so a report
      // is signed by the domain it claims to come from.
      aggregateOrgName: expr(desired.slice(desired.indexOf('@') + 1)),
      aggregateDkimSignDomain: expr(desired.slice(desired.indexOf('@') + 1)),
    }
    : { aggregateSendFrequency: expr('disable') };

  // Skip the write when Stalwart already agrees. The singleton being EMPTY is
  // not agreement — empty means the built-in defaults are live, which is the
  // state this function exists to overwrite.
  try {
    const current = await dmarcReportSettingsGet(opts);
    const currentFreq = current?.aggregateSendFrequency?.else;
    const currentFrom = current?.aggregateFromAddress?.else;
    const wantFreq = (patch.aggregateSendFrequency as StalwartExpression).else;
    const wantFrom = desired ? (patch.aggregateFromAddress as StalwartExpression).else : undefined;
    if (current && currentFreq === wantFreq && currentFrom === wantFrom) {
      return { state: 'in-sync', sender: desired, reason };
    }
  } catch (err) {
    logger.warn({ err }, 'dmarc report sender: could not read current Stalwart settings — writing anyway');
  }

  try {
    const res = await dmarcReportSettingsUpdate({ patch, ...opts });
    if (res.notUpdated && Object.keys(res.notUpdated).length > 0) {
      logger.error({ notUpdated: res.notUpdated }, 'dmarc report sender: Stalwart rejected the update');
      return { state: 'skipped', sender: null, reason: 'stalwart rejected the update' };
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
