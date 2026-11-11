/**
 * Mail DNS records against a real Postgres AND a real PowerDNS: enabling
 * email next to an old provider's records, the check, and "Re-create mail
 * records". Every assertion on DNS reads the zone back from the server.
 *
 * Needs `PDNS_API_URL` and a database. scripts/ci-integration-tests.sh starts
 * a throwaway `powerdns/pdns-auth-49` for it, so in CI this suite runs, never skips.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { dnsRecords, domains, emailDomains } from '../../db/schema.js';
import { createDnsServer, createProviderGroup } from '../dns-servers/service.js';
import { PowerDnsProvider } from '../dns-servers/providers/powerdns.js';
import { getMailServerHostname } from '../webmail-settings/service.js';
import { dmarcDomainSummaries } from '../mail-events/dmarc-summary.js';
import { provisionEmailDns } from './dns-provisioning.js';
import { getMailDnsCheck, repairMailDns } from './mail-dns-repair.js';
import { txtText } from './mail-dns-check.js';

// The record path, with a switch that makes the platform's MX publish fail —
// to prove the repair then keeps the domain's old MX instead of leaving none.
const failMx = vi.hoisted(() => ({ on: false }));
vi.mock('../dns-records/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../dns-records/service.js')>();
  return {
    ...real,
    createDnsRecord: (...args: Parameters<typeof real.createDnsRecord>) => {
      if (failMx.on && args[3].record_type === 'MX') {
        return Promise.reject(new Error('connect ECONNREFUSED 10.0.0.53:8081'));
      }
      return real.createDnsRecord(...args);
    },
  };
});

const API_URL = process.env.PDNS_API_URL;
const API_KEY = process.env.PDNS_API_KEY ?? 'probekey';
const KEY = process.env.PLATFORM_ENCRYPTION_KEY ?? '0'.repeat(64);
const ZONE = 'mailfix.example.test';
const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable || !API_URL)('mail DNS check and repair (integration, real PowerDNS)', () => {
  const db = () => getTestDb();
  const pdns = new PowerDnsProvider({ api_url: API_URL ?? '', api_key: API_KEY, server_id: 'localhost', api_version: 'v4' } as never);
  let tenantId = '';
  let domainId = '';
  let host = '';

  /** The zone as the server holds it: type → name → text values. */
  async function zone(type: string, name = ZONE): Promise<string[]> {
    const fq = `${name}.`.toLowerCase();
    return (await pdns.listRecords(ZONE))
      .filter((r) => r.type === type && r.name.toLowerCase() === fq)
      .map((r) => (type === 'TXT' ? txtText(r.content) : r.content))
      .sort();
  }
  const put = (type: string, name: string, content: string, priority?: number) =>
    pdns.createRecord(ZONE, { type, name, content, ttl: 3600, priority });
  const enable = () => provisionEmailDns(db(), domainId, ZONE, '', '', KEY, host);

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => {
    await pdns.deleteZone(ZONE).catch(() => undefined);
    await closeTestDb();
  });
  beforeEach(async () => {
    failMx.on = false;
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE dns_servers, dns_provider_groups CASCADE'));
    await pdns.deleteZone(ZONE).catch(() => undefined);
    await pdns.createZone(ZONE, 'Native', ['ns1.platform.test.', 'ns2.platform.test.']);

    const group = await createProviderGroup(db(), { name: 'it-group', ns_hostnames: ['ns1.platform.test', 'ns2.platform.test'] } as never);
    await createDnsServer(db(), {
      display_name: 'it-pdns', provider_type: 'powerdns', role: 'primary', enabled: true, group_id: group.id,
      connection_config: { api_url: API_URL, api_key: API_KEY, server_id: 'localhost', api_version: 'v4' },
    }, KEY);
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    tenantId = (await seedTenant(db(), regionId, planId)).id;
    domainId = (await seedDomain(db(), tenantId, { domainName: ZONE, dnsMode: 'primary', dnsGroupId: group.id })).id;
    // Webmail off, as enabling email leaves it unless asked (the column defaults to on).
    await db().insert(emailDomains).values({ id: crypto.randomUUID(), domainId, tenantId, enabled: 1, webmailEnabled: 0 } as typeof emailDomains.$inferInsert);
    host = (await getMailServerHostname(db())).toLowerCase();
  });

  it("enabling email next to an old provider's records adds no second SPF or DMARC record", async () => {
    await put('MX', ZONE, 'mx.old-provider.test', 10);
    await put('TXT', ZONE, 'v=spf1 include:_spf.old-provider.test ~all');
    await put('TXT', `_dmarc.${ZONE}`, 'v=DMARC1; p=none; rua=mailto:r@old-provider.test');

    await enable();

    expect(await zone('TXT')).toEqual(['v=spf1 include:_spf.old-provider.test ~all']);
    expect(await zone('TXT', `_dmarc.${ZONE}`)).toEqual(['v=DMARC1; p=none; rua=mailto:r@old-provider.test']);
    expect(await zone('MX')).toEqual([`10 ${host}.`, '10 mx.old-provider.test.'].sort());
    // The domain's own DMARC record has a row, so its policy can be changed from the panel.
    const [summary] = await dmarcDomainSummaries(db(), { tenantId, includeUnreported: true });
    expect(summary).toMatchObject({ policyDomain: ZONE, reportCount: 0, managedPolicy: 'none', managedRecordCount: 1 });

    const check = await getMailDnsCheck(db(), tenantId, domainId);
    expect(check.checked).toBe(true);
    expect(check.issues.map((i) => [i.kind, i.removable])).toEqual([
      ['spf_without_platform', false],
      ['dmarc_reports_elsewhere', false],
      ['foreign_mx', true],
    ]);
    expect(check.repair.remove).toEqual([{ type: 'MX', name: ZONE, value: '10 mx.old-provider.test.', optional: true }]);

    const result = await repairMailDns(db(), tenantId, domainId);
    expect(result).toMatchObject({ added: 0, removed: 1, failures: [] });
    expect(await zone('MX')).toEqual([`10 ${host}.`]);
    // The tenant's own SPF and DMARC stay; only the warnings remain.
    expect(await zone('TXT')).toEqual(['v=spf1 include:_spf.old-provider.test ~all']);
    expect(result.check.issues.map((i) => i.kind)).toEqual(['spf_without_platform', 'dmarc_reports_elsewhere']);
  });

  it('merges a second SPF and DMARC record into one, keeping every sender and the stricter policy', async () => {
    await enable(); // the platform's records, with their rows
    await put('TXT', ZONE, 'v=spf1 include:_spf.old-provider.test ~all');
    await put('TXT', `_dmarc.${ZONE}`, 'v=DMARC1; p=reject; rua=mailto:r@old-provider.test');
    expect(await zone('TXT')).toHaveLength(2);

    const before = await getMailDnsCheck(db(), tenantId, domainId);
    expect(before.issues.filter((i) => i.severity === 'error').map((i) => i.kind).sort()).toEqual(['duplicate_dmarc', 'duplicate_spf']);

    const result = await repairMailDns(db(), tenantId, domainId);
    expect(result.failures).toEqual([]);
    expect(await zone('TXT')).toEqual(['v=spf1 mx include:_spf.old-provider.test ~all']);
    expect(await zone('TXT', `_dmarc.${ZONE}`)).toEqual([`v=DMARC1; p=reject; rua=mailto:dmarc@${ZONE},mailto:r@old-provider.test`]);
    expect(result.check.issues).toEqual([]);
    expect(result.check.records.find((r) => r.purpose === 'dmarc')?.status).toBe('ok');

    // One `_dmarc` row, so the policy buttons are offered again.
    const [summary] = await dmarcDomainSummaries(db(), { tenantId, includeUnreported: true });
    expect(summary).toMatchObject({ managedRecordCount: 1, managedPolicy: 'reject' });
    // Run again: nothing left to do.
    expect(await repairMailDns(db(), tenantId, domainId)).toMatchObject({ added: 0, removed: 0, failures: [] });
  });

  it('keeps another MX the tenant chose to keep', async () => {
    await enable();
    await put('MX', ZONE, 'backup-mx.old-provider.test', 50);
    const result = await repairMailDns(db(), tenantId, domainId, {
      keep: [{ type: 'MX', name: ZONE, value: '50 backup-mx.old-provider.test.' }],
    });
    expect(result).toMatchObject({ removed: 0, kept: 1, failures: [] });
    expect(await zone('MX')).toEqual([`10 ${host}.`, '50 backup-mx.old-provider.test.'].sort());
  });

  it('a platform MX that cannot be published leaves the old MX in place, never none', async () => {
    await put('MX', ZONE, 'mx.old-provider.test', 10);
    await enable();
    // The platform MX is gone from the zone and from the rows: the repair must create it.
    await pdns.deleteRecordValue(ZONE, { type: 'MX', name: ZONE, content: host, priority: 10 });
    await db().delete(dnsRecords).where(eq(dnsRecords.recordType, 'MX'));
    expect(await zone('MX')).toEqual(['10 mx.old-provider.test.']);

    failMx.on = true;
    const result = await repairMailDns(db(), tenantId, domainId);
    expect(result.failures.map((f) => [f.action, f.type])).toEqual([['add', 'MX'], ['remove', 'MX']]);
    expect(result.failures[1].message).toContain('Kept');
    // The raw socket error, which names an internal address, does not reach the tenant.
    expect(result.failures[0].message).not.toContain('10.0.0.53');
    expect(await zone('MX')).toEqual(['10 mx.old-provider.test.']);
  });

  it('re-creates records deleted by accident, from their rows', async () => {
    await enable();
    await pdns.deleteRecord(ZONE, `${ZONE}.|MX|`);
    await pdns.deleteRecord(ZONE, `_imaps._tcp.${ZONE}.|SRV|`);
    await pdns.deleteRecord(ZONE, `_dmarc.${ZONE}.|TXT|`);
    // …and the DMARC row too, as a delete in the DNS tab would.
    await db().delete(dnsRecords).where(eq(dnsRecords.recordName, `_dmarc.${ZONE}`));

    const before = await getMailDnsCheck(db(), tenantId, domainId);
    expect(before.records.filter((r) => r.status === 'missing').map((r) => r.type).sort()).toEqual(['MX', 'SRV', 'TXT']);
    expect(before.issues).toEqual([]);

    const result = await repairMailDns(db(), tenantId, domainId);
    expect(result).toMatchObject({ added: 3, removed: 0, failures: [] });
    expect(await zone('MX')).toEqual([`10 ${host}.`]);
    expect(await zone('SRV', `_imaps._tcp.${ZONE}`)).toEqual([`0 1 993 ${host}.`]);
    expect(await zone('TXT', `_dmarc.${ZONE}`)).toEqual([`v=DMARC1; p=quarantine; rua=mailto:dmarc@${ZONE}`]);
    expect(result.check.records.every((r) => r.status === 'ok')).toBe(true);
    // Run again: nothing left to do.
    expect(await repairMailDns(db(), tenantId, domainId)).toMatchObject({ added: 0, removed: 0, failures: [] });
  });

  it('checks the webmail CNAME at the target the webmail toggle publishes', async () => {
    await db().update(emailDomains).set({ webmailEnabled: 1 }).where(eq(emailDomains.domainId, domainId));
    await provisionEmailDns(db(), domainId, ZONE, '', '', KEY, host, { webmailEnabled: true, webmailHostname: 'webmail.platform.test' });
    expect(await zone('CNAME', `webmail.${ZONE}`)).toEqual(['webmail.platform.test.']);
  });

  it('does not touch a zone the platform does not host', async () => {
    await db().update(domains).set({ dnsMode: 'cname' }).where(eq(domains.id, domainId));
    const check = await getMailDnsCheck(db(), tenantId, domainId);
    expect(check).toMatchObject({ checked: false, reason: 'external_dns', issues: [] });
    await expect(repairMailDns(db(), tenantId, domainId)).rejects.toMatchObject({ code: 'DNS_NOT_AUTHORITATIVE', status: 409 });
  });

  it("is scoped to the tenant: another tenant's domain answers like a missing one", async () => {
    const other = (await seedTenant(db(), (await seedRegion(db())).id, (await seedPlan(db())).id)).id;
    await expect(getMailDnsCheck(db(), other, domainId)).rejects.toMatchObject({ code: 'EMAIL_DOMAIN_NOT_FOUND' });
    await expect(repairMailDns(db(), other, domainId)).rejects.toMatchObject({ code: 'EMAIL_DOMAIN_NOT_FOUND' });
  });
});
