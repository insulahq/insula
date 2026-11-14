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
import { dnsRecords, emailDmarcReports, emailDmarcSources, emailDomains } from '../../db/schema.js';
import { provenRelayCopies, resetDmarcSourceFactCaches, signedMessagesBySource } from './dmarc-source-facts.js';
import { dmarcDomainSummaries } from './dmarc-summary.js';
import { applyDmarcPolicy } from './dmarc-apply.js';

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
    expect(counts.get('198.51.100.9')).toEqual({ signed: 7, evidenced: 7, evidencedFail: 0 });
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

  // The recommendation must not hold a domain at p=none for failures that are
  // a recipient's scanner re-delivering our own mail — the production case.
  describe('the recommendation leaves proven relay copies out', () => {
    type Rec = ReturnType<typeof rec>;
    /** A report and its source rows, consistent with each other as ingest writes them. */
    async function fullReport(records: Rec[], daysAgo: number) {
      const id = crypto.randomUUID();
      const receivedAt = new Date(Date.now() - daysAgo * 86_400_000);
      const passed = (r: Rec) => r.evaluatedDkim === 'pass' || r.evaluatedSpf === 'pass';
      const total = records.reduce((n, r) => n + r.count, 0);
      const pass = records.filter(passed).reduce((n, r) => n + r.count, 0);
      await db().insert(emailDmarcReports).values({
        id, stalwartReportId: crypto.randomUUID(), tenantId, policyDomain: DOMAIN, policyDisposition: 'none',
        totalMessages: total, passMessages: pass, failMessages: total - pass, receivedAt,
        raw: { id: 'x', report: { policyDomain: DOMAIN, records: Object.fromEntries(records.map((r, i) => [String(i), r])) } },
      } as typeof emailDmarcReports.$inferInsert);
      for (const r of records) {
        await db().insert(emailDmarcSources).values({
          id: crypto.randomUUID(), reportId: id, tenantId, policyDomain: DOMAIN, sourceIp: r.sourceIp,
          messageCount: r.count, evaluatedDkim: r.evaluatedDkim, evaluatedSpf: r.evaluatedSpf, disposition: 'none',
          headerFrom: DOMAIN, receivedAt,
        } as typeof emailDmarcSources.$inferInsert);
      }
    }
    const ours = rec('192.0.2.10', 20, [OURS], { envelopeTo: 'customer.example.org', spf: 'pass' });
    const scanner = rec('198.51.100.7', 20, [BROKEN], { envelopeTo: 'customer.example.org' });
    const deps = { clusterAddresses: async () => ['192.0.2.10'] };
    const lookup = () => (doms: readonly string[], since: Date, tenant?: string) => provenRelayCopies(db(), doms, { since, tenantId: tenant }, deps);

    beforeEach(async () => {
      resetDmarcSourceFactCaches();
      const domain = await seedDomain(db(), tenantId, { domainName: DOMAIN });
      await db().insert(dnsRecords).values({
        id: crypto.randomUUID(), domainId: domain.id, recordType: 'TXT', recordName: `_dmarc.${DOMAIN}`,
        recordValue: `v=DMARC1; p=none; rua=mailto:dmarc@${DOMAIN}`, ttl: 3600, priority: null,
      });
      for (let i = 0; i < 6; i++) await fullReport([ours, scanner], 20 - i * 4);
    });

    it('without it the scanner holds the domain at p=none; with it the domain is ready', async () => {
      const [raw] = await dmarcDomainSummaries(db(), { tenantId });
      expect(raw).toMatchObject({ totalMessages: 240, passMessages: 120, failingSources: 1, relayCopies: { messages: 0, sources: 0 } });
      expect(raw.recommendation.ready).toBe(false);

      const [judged] = await dmarcDomainSummaries(db(), { tenantId, relayCopies: lookup() });
      // The raw figures stay what the reports say…
      expect(judged).toMatchObject({ totalMessages: 240, passMessages: 120, failingSources: 1, relayCopies: { messages: 120, sources: 1 } });
      // …the recommendation judges the rest, and says what it left out.
      expect(judged.recommendation).toMatchObject({ ready: true, recommendedPolicy: 'quarantine' });
      expect(judged.recommendation.reason).toMatch(/100\.0% of 120 message\(s\)/);
      expect(judged.recommendation.reason).toMatch(/Not counted: 120 copies passed on by 1 relay/);

      // The server-side check judges the same way, so the step needs no acknowledgement.
      await expect(applyDmarcPolicy(db(), { domain: DOMAIN, policy: 'quarantine', tenantId }))
        .rejects.toMatchObject({ code: 'DMARC_TIGHTENING_NOT_READY' });
      await expect(applyDmarcPolicy(db(), { domain: DOMAIN, policy: 'quarantine', tenantId }, { relayCopies: lookup() }))
        .resolves.toMatchObject({ policy: 'quarantine' });
    });

    it('a failure without evidence still counts — a pasted signature header is not a relay', async () => {
      await fullReport([rec('203.0.113.66', 1, [BROKEN], { envelopeTo: 'partner.example.org' })], 1);
      const [judged] = await dmarcDomainSummaries(db(), { tenantId, relayCopies: lookup() });
      expect(judged.recommendation.ready).toBe(false);
      expect(judged.recommendation.reason).toMatch(/1 source\(s\) are still failing/);
    });

    it('a relay that also fails one message of its own stays a failing source', async () => {
      await fullReport([rec('198.51.100.7', 1, [], { envelopeTo: 'elsewhere.example.org' })], 1);
      const [judged] = await dmarcDomainSummaries(db(), { tenantId, relayCopies: lookup() });
      expect(judged.recommendation.ready).toBe(false);
    });

    it('our own server is never a relay, and an unreadable node list means nothing is left out', async () => {
      const both = (doms: readonly string[], since: Date) =>
        provenRelayCopies(db(), doms, { since, tenantId }, { clusterAddresses: async () => ['192.0.2.10', '198.51.100.7'] });
      expect((await dmarcDomainSummaries(db(), { tenantId, relayCopies: both }))[0].relayCopies).toEqual({ messages: 0, sources: 0 });
      resetDmarcSourceFactCaches();
      const broken = (doms: readonly string[], since: Date) =>
        provenRelayCopies(db(), doms, { since, tenantId }, { clusterAddresses: async () => { throw new Error('forbidden'); } });
      const [r] = await dmarcDomainSummaries(db(), { tenantId, relayCopies: broken });
      expect(r.relayCopies).toEqual({ messages: 0, sources: 0 });
      expect(r.recommendation.ready).toBe(false);
    });

    it('another tenant\'s reports for the same domain are neither counted nor left out', async () => {
      expect(await provenRelayCopies(db(), [DOMAIN], { since: since(), tenantId: otherTenantId }, deps)).toEqual(new Map());
    });
  });
});
