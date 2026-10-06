/**
 * Acting on the DMARC recommendation, against a real Postgres: the managed
 * `_dmarc` record is rewritten only as the recommendation allows, loosening is
 * always possible, other tenants' domains are invisible, and the summary shows
 * the published policy before the reports catch up.
 *
 * The domain is in `cname` mode, so the platform is not authoritative and no
 * DNS server is contacted — the record row changes and `published` is false.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { dnsRecords, emailDmarcReports } from '../../db/schema.js';
import { applyDmarcPolicy } from './dmarc-apply.js';
import { dmarcDomainSummaries } from './dmarc-summary.js';

const dbAvailable = await isDbAvailable();
const DOMAIN = 'shop.example.com';

describe.skipIf(!dbAvailable)('apply DMARC policy (integration)', () => {
  const db = () => getTestDb();
  let tenantId = '';
  let otherTenantId = '';
  let recordId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE email_dmarc_reports, dns_records CASCADE'));
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    tenantId = (await seedTenant(db(), regionId, planId)).id;
    otherTenantId = (await seedTenant(db(), regionId, planId)).id;
    const domain = await seedDomain(db(), tenantId, { domainName: DOMAIN });
    recordId = crypto.randomUUID();
    await db().insert(dnsRecords).values({
      id: recordId, domainId: domain.id, recordType: 'TXT', recordName: `_dmarc.${DOMAIN}`,
      recordValue: `v=DMARC1; p=none; rua=mailto:dmarc@${DOMAIN}`, ttl: 3600, priority: null,
    });
  });

  /** `count` clean reports spread over `days`, all passing. */
  async function reports(count: number, days: number, messagesEach = 50) {
    for (let i = 0; i < count; i++) {
      await db().insert(emailDmarcReports).values({
        id: crypto.randomUUID(), stalwartReportId: `r-${i}`, tenantId, policyDomain: DOMAIN,
        policyDisposition: 'none', totalMessages: messagesEach, passMessages: messagesEach,
        receivedAt: new Date(Date.now() - (days * (count - 1 - i)) / Math.max(1, count - 1) * 86_400_000),
      } as typeof emailDmarcReports.$inferInsert);
    }
  }

  async function recordValue() {
    const [r] = await db().select().from(dnsRecords).where(eq(dnsRecords.id, recordId));
    return r.recordValue;
  }

  it('refuses to tighten without evidence, and says why', async () => {
    await expect(applyDmarcPolicy(db(), { domain: DOMAIN, policy: 'quarantine' }))
      .rejects.toMatchObject({ code: 'DMARC_TIGHTENING_NOT_READY' });
    expect(await recordValue()).toBe(`v=DMARC1; p=none; rua=mailto:dmarc@${DOMAIN}`);
  });

  it('applies exactly the recommended step, keeps every other tag, and shows it as published', async () => {
    await reports(6, 20);
    await expect(applyDmarcPolicy(db(), { domain: DOMAIN, policy: 'reject' }))
      .rejects.toMatchObject({ code: 'DMARC_TIGHTENING_NOT_READY' }); // no skipping a step
    const res = await applyDmarcPolicy(db(), { domain: DOMAIN, policy: 'quarantine', tenantId });
    expect(res).toMatchObject({ policy: 'quarantine', published: false, recordName: `_dmarc.${DOMAIN}` });
    expect(await recordValue()).toBe(`v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}`);

    // Reports still say p=none (they lag a day); the summary already knows.
    const [summary] = await dmarcDomainSummaries(db(), { tenantId });
    expect(summary.currentPolicy).toBe('none');
    expect(summary.managedPolicy).toBe('quarantine');
    // …so the same tightening cannot be offered twice, nor the next one yet.
    await expect(applyDmarcPolicy(db(), { domain: DOMAIN, policy: 'reject' }))
      .rejects.toMatchObject({ code: 'DMARC_TIGHTENING_NOT_READY' });
  });

  it('always allows loosening — the way back when legitimate mail is quarantined', async () => {
    await db().update(dnsRecords).set({ recordValue: `v=DMARC1; p=reject; rua=mailto:dmarc@${DOMAIN}` })
      .where(eq(dnsRecords.id, recordId));
    await applyDmarcPolicy(db(), { domain: DOMAIN, policy: 'none', tenantId });
    expect(await recordValue()).toBe(`v=DMARC1; p=none; rua=mailto:dmarc@${DOMAIN}`);
  });

  it('treats another tenant\'s domain like one without a managed record', async () => {
    await reports(6, 20);
    await expect(applyDmarcPolicy(db(), { domain: DOMAIN, policy: 'quarantine', tenantId: otherTenantId }))
      .rejects.toMatchObject({ code: 'DMARC_RECORD_NOT_MANAGED' });
    expect(await recordValue()).toBe(`v=DMARC1; p=none; rua=mailto:dmarc@${DOMAIN}`);
  });
});
