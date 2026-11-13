/**
 * The count behind RELAY, against a real Postgres: messages per source that
 * carried the domain's DKIM signature from the platform's selectors, read
 * from the stored reports. Records and DKIM results arrive keyed "0", "1", …
 * (Stalwart's shape) or as arrays; both count.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { emailDmarcReports, emailDomains } from '../../db/schema.js';
import { signedMessagesBySource } from './dmarc-source-facts.js';

const dbAvailable = await isDbAvailable();
const DOMAIN = 'shop.example.com';

const rec = (sourceIp: string, count: number, dkim: Array<{ domain: string; selector: string; result: string }>,
  opts: { headerFrom?: string; envelopeTo?: string; spf?: string } = {}) => ({
  count, sourceIp, headerFrom: opts.headerFrom ?? DOMAIN, envelopeTo: opts.envelopeTo,
  evaluatedDkim: dkim.some((d) => d.result === 'pass') ? 'pass' : 'fail', evaluatedSpf: opts.spf ?? 'fail',
  dkimResults: Object.fromEntries(dkim.map((d, i) => [String(i), { ...d, humanResult: null }])),
});
const OURS = { domain: DOMAIN, selector: 'dkim-1', result: 'pass' };
const BROKEN = { domain: DOMAIN, selector: 'dkim-1', result: 'fail' };
/** Map → plain object of [signed, evidenced]. */
const flat = (m: Map<string, { signed: number; evidenced: number }>) =>
  Object.fromEntries([...m].map(([ip, c]) => [ip, [c.signed, c.evidenced]]));

describe.skipIf(!dbAvailable)('DMARC relay counts (integration)', () => {
  const db = () => getTestDb();
  let tenantId = '';
  let otherTenantId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE email_dmarc_reports CASCADE'));
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    tenantId = (await seedTenant(db(), regionId, planId)).id;
    otherTenantId = (await seedTenant(db(), regionId, planId)).id;
  });

  async function report(records: unknown, opts: { tenant?: string; daysAgo?: number } = {}) {
    await db().insert(emailDmarcReports).values({
      id: crypto.randomUUID(), stalwartReportId: crypto.randomUUID(), tenantId: opts.tenant ?? tenantId,
      policyDomain: DOMAIN, totalMessages: 0, passMessages: 0,
      receivedAt: new Date(Date.now() - (opts.daysAgo ?? 1) * 86_400_000),
      raw: { id: 'x', report: { policyDomain: DOMAIN, records } },
    } as typeof emailDmarcReports.$inferInsert);
  }

  const since = () => new Date(Date.now() - 30 * 86_400_000);

  it('counts our selectors, pass or fail, and nothing else', async () => {
    await report({
      0: rec('192.0.2.10', 5, [OURS]),
      // Our signature, broken — with no evidence of where it came from.
      1: rec('198.51.100.7', 5, [BROKEN]),
      // The tenant's Microsoft 365, signing with its own selector: not ours.
      2: rec('203.0.113.5', 9, [{ domain: DOMAIN, selector: 'selector1', result: 'pass' }]),
      // Somebody else's signature for their own domain.
      3: rec('203.0.113.6', 4, [{ domain: 'other.example.org', selector: 'dkim-1', result: 'pass' }]),
      // A subdomain From signed with that subdomain, after a rotation.
      4: rec('198.51.100.8', 2, [{ domain: `news.${DOMAIN}`, selector: 'DKIM-2', result: 'pass' }], { headerFrom: `news.${DOMAIN}` }),
    });
    // The array spelling, from a reporter that sends one; here our signature verified.
    await report([rec('198.51.100.7', 3, [{ domain: DOMAIN, selector: 'dkim-2', result: 'pass' }])]);

    const counts = await signedMessagesBySource(db(), DOMAIN, { since: since(), tenantId });
    expect(flat(counts)).toEqual({ '192.0.2.10': [5, 5], '198.51.100.7': [8, 3], '198.51.100.8': [2, 2] });
  });

  // The inline scanner in front of a Microsoft 365 mailbox: Microsoft reports
  // each message once from our server (passing) and once from the scanner
  // (failing where it added a banner) — same recipient domain, same count.
  it('a broken signature counts as relayed when the same report holds our own copy', async () => {
    await report({
      0: rec('192.0.2.10', 5, [OURS], { envelopeTo: 'customer.example.org', spf: 'pass' }),
      1: rec('198.51.100.7', 5, [BROKEN], { envelopeTo: 'customer.example.org' }),
      // A forged header to a recipient domain we did not mail, or a different count: no evidence.
      2: rec('203.0.113.66', 5, [BROKEN], { envelopeTo: 'partner.example.org' }),
      3: rec('203.0.113.67', 4, [BROKEN], { envelopeTo: 'customer.example.org' }),
    });
    // Our copy in ANOTHER report is not evidence for this one.
    await report({ 0: rec('203.0.113.66', 5, [OURS], { envelopeTo: 'partner.example.org', spf: 'pass' }) });
    const counts = await signedMessagesBySource(db(), DOMAIN, { since: since(), tenantId });
    expect(flat(counts)).toEqual({
      '192.0.2.10': [5, 5], '198.51.100.7': [5, 5], '203.0.113.66': [10, 5], '203.0.113.67': [4, 0],
    });
  });

  it('counts a domain\'s active selector when it is not one of the A/B pair', async () => {
    const domain = await seedDomain(db(), tenantId, { domainName: DOMAIN });
    await db().insert(emailDomains).values({
      id: crypto.randomUUID(), domainId: domain.id, tenantId, enabled: 1, dkimActiveSelector: 'stalwart-20260101',
    } as typeof emailDomains.$inferInsert);
    await report({ 0: rec('198.51.100.9', 7, [{ domain: DOMAIN, selector: 'stalwart-20260101', result: 'pass' }]) });
    const counts = await signedMessagesBySource(db(), DOMAIN, { since: since(), tenantId });
    expect(counts.get('198.51.100.9')).toEqual({ signed: 7, evidenced: 7 });
  });

  it('keeps to the tenant and the window, and survives odd records', async () => {
    await report({ 0: rec('198.51.100.7', 5, [{ domain: DOMAIN, selector: 'dkim-1', result: 'fail' }]) }, { tenant: otherTenantId });
    await report({ 0: rec('198.51.100.7', 6, [{ domain: DOMAIN, selector: 'dkim-1', result: 'fail' }]) }, { daysAgo: 45 });
    await report({
      0: { sourceIp: '198.51.100.7', count: 'lots', dkimResults: { 0: { domain: DOMAIN, selector: 'dkim-1', result: 'pass' } } },
      1: { sourceIp: '198.51.100.7', count: 2, dkimResults: null },
      2: rec('198.51.100.7', 1, [{ domain: DOMAIN, selector: 'dkim-1', result: 'pass' }]),
    });
    await report(null);

    expect(flat(await signedMessagesBySource(db(), DOMAIN, { since: since(), tenantId })))
      .toEqual({ '198.51.100.7': [1, 1] });
    expect(flat(await signedMessagesBySource(db(), DOMAIN, { since: since(), tenantId: otherTenantId })))
      .toEqual({ '198.51.100.7': [5, 0] });
    // The admin view, unscoped, sees both tenants' reports in the window.
    expect(flat(await signedMessagesBySource(db(), DOMAIN, { since: since() })))
      .toEqual({ '198.51.100.7': [6, 1] });
  });
});
