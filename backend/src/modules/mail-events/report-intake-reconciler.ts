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

const REQUIRED_INTAKE_PATTERNS = ['postmaster@*', `${FBL_LOCAL_PART}@*`] as const;

export interface ReportIntakeResult {
  readonly mailbox: 'exists' | 'created' | 'skipped' | 'failed';
  readonly settings: 'in-sync' | 'updated' | 'skipped';
  readonly fblAddress: string | null;
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
  // ── 1. fbl@<apex> mailbox ──
  let mailboxState: ReportIntakeResult['mailbox'] = 'skipped';
  let fblAddress: string | null = null;

  const apex = await findApexEmailDomain(db);
  if (!apex) {
    logger.warn({}, 'report intake: SYSTEM tenant has no enabled apex email domain — fbl@ mailbox skipped (see docs/operations/MAIL_FBL.md)');
  } else {
    fblAddress = `${FBL_LOCAL_PART}@${apex.domainName.toLowerCase()}`;
    const [existing] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(and(
        eq(mailboxes.emailDomainId, apex.emailDomainId),
        eq(mailboxes.localPart, FBL_LOCAL_PART),
      ))
      .limit(1);

    if (existing) {
      mailboxState = 'exists';
    } else {
      try {
        const { createMailbox } = await import('../mailboxes/service.js');
        await createMailbox(db, apex.tenantId, apex.emailDomainId, {
          local_part: FBL_LOCAL_PART,
          display_name: 'FBL / abuse report intake',
          quota_mb: 1024,
          mailbox_type: 'mailbox',
        });
        mailboxState = 'created';
        logger.info({ fblAddress }, 'report intake: created fbl@ mailbox');
      } catch (err) {
        mailboxState = 'failed';
        logger.error({ err }, 'report intake: fbl@ mailbox creation failed (will retry)');
      }
    }
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

  return { mailbox: mailboxState, settings: settingsState, fblAddress };
}
