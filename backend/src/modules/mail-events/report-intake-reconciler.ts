/**
 * FBL report-intake provisioning (R4 PR 3).
 *
 * Two invariants, re-asserted by the 5-min mail self-heal:
 *
 *   1. A real `fbl@<apex>` mailbox exists under the SYSTEM tenant's
 *      apex email domain. Stalwart does NOT bypass RCPT validation for
 *      report addresses (live-proven: 550 without an account), so the
 *      registered FBL address must be a real principal. The mailbox is
 *      a normal platform mailbox (ADR-049 hidden auto-generated
 *      primary credential — nobody logs into it; intercepted reports
 *      are parsed before delivery and the copies that do land are
 *      bounded by the mailbox quota).
 *
 *   2. Stalwart's ReportSettings inboundReportAddresses covers
 *      `postmaster@*` AND `fbl@*`, followed by a ReloadSettings action
 *      (report-analysis config is boot-loaded like the MTA config).
 *
 * Skips quietly when the apex has no email domain yet — enabling mail
 * on the apex is an operator step (docs/operations/MAIL_FBL.md).
 */

import { eq, and } from 'drizzle-orm';
import { tenants, domains, emailDomains, mailboxes } from '../../db/schema.js';
import {
  reportSettingsGet,
  reportSettingsUpdate,
  actionReloadSettings,
} from '../stalwart-jmap/client.js';
import type { Database } from '../../db/index.js';
import type { OutboundReconcileLogger } from '../email-outbound/service.js';

export const FBL_LOCAL_PART = 'fbl';
/**
 * R5. DMARC `rua=` addresses point here. It must be a REAL principal for the
 * same reason `fbl@` is: Stalwart does not bypass RCPT validation for report
 * addresses, so an unregistered address answers `550 5.1.2 Mailbox does not
 * exist` and the report is never parsed. Re-confirmed on a live server
 * 2026-09-13 — `postmaster@<apex>`, which is in the pattern list but has no
 * account, is refused at RCPT.
 */
export const DMARC_LOCAL_PART = 'dmarc';

const REQUIRED_INTAKE_PATTERNS = [
  'postmaster@*',
  `${FBL_LOCAL_PART}@*`,
  `${DMARC_LOCAL_PART}@*`,
] as const;

export interface ReportIntakeResult {
  readonly mailbox: 'exists' | 'created' | 'skipped' | 'failed';
  readonly settings: 'in-sync' | 'updated' | 'skipped';
  readonly fblAddress: string | null;
  /** R5: where DMARC `rua=` records point. */
  readonly dmarcAddress: string | null;
}

async function findApexEmailDomain(db: Database): Promise<{
  tenantId: string;
  emailDomainId: string;
  domainName: string;
} | null> {
  const [row] = await db
    .select({
      tenantId: tenants.id,
      emailDomainId: emailDomains.id,
      domainName: domains.domainName,
    })
    .from(tenants)
    .innerJoin(domains, eq(domains.tenantId, tenants.id))
    .innerJoin(emailDomains, and(
      eq(emailDomains.domainId, domains.id),
      eq(emailDomains.enabled, 1),
    ))
    .where(eq(tenants.isSystem, true))
    .limit(1);
  return row ?? null;
}

export async function ensureReportIntake(
  db: Database,
  logger: OutboundReconcileLogger,
  opts: { baseUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ReportIntakeResult> {
  // ── 1. report-intake mailboxes (fbl@ and dmarc@) ──
  //
  // Both must be REAL principals: Stalwart refuses an unregistered report
  // address at RCPT (`550 5.1.2 Mailbox does not exist`) and never parses the
  // report. Registering the pattern in ReportSettings is necessary but NOT
  // sufficient — `postmaster@*` is in that list, has no account, and is
  // refused. Re-confirmed on a live server 2026-09-13.
  let mailboxState: ReportIntakeResult['mailbox'] = 'skipped';
  let fblAddress: string | null = null;
  let dmarcAddress: string | null = null;

  const apex = await findApexEmailDomain(db);
  if (!apex) {
    logger.warn({}, 'report intake: SYSTEM tenant has no enabled apex email domain — report mailboxes skipped (see docs/operations/MAIL_FBL.md)');
  } else {
    const intakes: ReadonlyArray<{ localPart: string; displayName: string }> = [
      { localPart: FBL_LOCAL_PART, displayName: 'FBL / abuse report intake' },
      { localPart: DMARC_LOCAL_PART, displayName: 'DMARC aggregate report intake' },
    ];
    fblAddress = `${FBL_LOCAL_PART}@${apex.domainName.toLowerCase()}`;
    dmarcAddress = `${DMARC_LOCAL_PART}@${apex.domainName.toLowerCase()}`;

    const states: ReportIntakeResult['mailbox'][] = [];
    const ensure = async (
      target: { tenantId: string; emailDomainId: string; domainName: string },
      localPart: string,
      displayName: string,
      quotaMb: number,
    ): Promise<void> => {
      const [existing] = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(
          eq(mailboxes.emailDomainId, target.emailDomainId),
          eq(mailboxes.localPart, localPart),
        ))
        .limit(1);

      if (existing) {
        states.push('exists');
        return;
      }
      try {
        const { createMailbox } = await import('../mailboxes/service.js');
        await createMailbox(db, target.tenantId, target.emailDomainId, {
          local_part: localPart,
          display_name: displayName,
          quota_mb: quotaMb,
          mailbox_type: 'mailbox',
        });
        states.push('created');
        logger.info(
          { address: `${localPart}@${target.domainName.toLowerCase()}` },
          'report intake: created report mailbox',
        );
      } catch (err) {
        states.push('failed');
        logger.error(
          { err, localPart, domain: target.domainName },
          'report intake: report mailbox creation failed (will retry)',
        );
      }
    };

    for (const intake of intakes) {
      await ensure(apex, intake.localPart, intake.displayName, 1024);
    }

    // R5. `dmarc@` must additionally exist on EVERY enabled email domain,
    // because the DMARC record each domain publishes carries a same-domain
    // `rua=mailto:dmarc@<that domain>`. Without the mailbox the address is
    // refused at RCPT and the reports are discarded — which is exactly the bug
    // this replaces (the old record pointed at `dmarc-reports@<domain>`, an
    // address nothing ever created).
    //
    // A smaller quota than the apex intake on purpose: Stalwart parses and
    // stores the report before delivery, so what lands here is a residual copy,
    // and this multiplies by the number of hosted domains.
    const reportDomains = await db
      .select({
        tenantId: emailDomains.tenantId,
        emailDomainId: emailDomains.id,
        domainName: domains.domainName,
      })
      .from(emailDomains)
      .innerJoin(domains, eq(emailDomains.domainId, domains.id))
      .where(eq(emailDomains.enabled, 1));

    for (const d of reportDomains) {
      if (d.emailDomainId === apex.emailDomainId) continue; // already done above
      await ensure(d, DMARC_LOCAL_PART, 'DMARC aggregate report intake', 256);
    }
    // Worst state wins. Reporting 'exists' because ONE of two mailboxes was
    // already there would hide a failure on the other — and the failure mode
    // is silent by nature: reports simply never arrive.
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
        logger.info({ patterns: REQUIRED_INTAKE_PATTERNS }, 'report intake: ReportSettings updated + reloaded');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'report intake: Stalwart JMAP unreachable for ReportSettings, skipped');
  }

  return { mailbox: mailboxState, settings: settingsState, fblAddress, dmarcAddress };
}
