import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { buildDkimKeyList, withPublishedDkim, dkimTxtName, readPublishedDkimRecords } from './keys.js';
import type { Database } from '../../db/index.js';
import type { DnsRecordSpec } from '../email-domains/dns-provisioning.js';
import type { StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';

const DOMAIN = 'example.test';
const SID = 'stalwart-domain-7';

function row(over: Partial<StalwartDkimSignatureRow> & Record<string, unknown>): StalwartDkimSignatureRow {
  return { id: 'sig', '@type': 'Dkim1RsaSha256', domainId: SID, selector: 'dkim-1', stage: 'active', ...over };
}

describe('buildDkimKeyList', () => {
  it('lists only this domain\'s keys, newest selector first', () => {
    const keys = buildDkimKeyList({
      rows: [
        row({ id: 'a', selector: 'dkim-1' }),
        row({ id: 'b', selector: 'dkim-2' }),
        row({ id: 'c', selector: 'dkim-1', domainId: 'another-domain' }),
      ],
      stalwartDomainId: SID,
      domainName: DOMAIN,
      activeSelector: 'dkim-2',
      published: [],
    });
    expect(keys.map((k) => [k.selector, k.current])).toEqual([['dkim-2', true], ['dkim-1', false]]);
  });

  it('never passes on a field it did not pick — the row can carry the private key', () => {
    const [key] = buildDkimKeyList({
      rows: [row({ privateKey: { '@type': 'Text', secret: 'SECRET-KEY-MATERIAL' } } as never)],
      stalwartDomainId: SID,
      domainName: DOMAIN,
      activeSelector: 'dkim-1',
      published: [],
    });
    expect(Object.keys(key).sort()).toEqual(
      ['algorithm', 'current', 'selector', 'stage', 'txtRecordName', 'txtRecordValue'],
    );
    expect(JSON.stringify(key)).not.toContain('SECRET-KEY-MATERIAL');
  });

  it('pairs each key with the TXT value published under its selector, null when none is', () => {
    const keys = buildDkimKeyList({
      rows: [row({ selector: 'dkim-1' }), row({ id: 'x', selector: 'v1-ed25519-20260101', '@type': 'Dkim1Ed25519Sha256', stage: undefined })],
      stalwartDomainId: SID,
      domainName: DOMAIN,
      activeSelector: 'dkim-1',
      published: [{ name: dkimTxtName('dkim-1', DOMAIN), value: 'v=DKIM1; k=rsa; p=AAA', ttl: 3600 }],
    });
    expect(keys).toEqual([
      { selector: 'dkim-1', algorithm: 'rsa', stage: 'active', current: true, txtRecordName: 'dkim-1._domainkey.example.test', txtRecordValue: 'v=DKIM1; k=rsa; p=AAA' },
      { selector: 'v1-ed25519-20260101', algorithm: 'ed25519', stage: null, current: false, txtRecordName: 'v1-ed25519-20260101._domainkey.example.test', txtRecordValue: null },
    ]);
  });

  it('a domain with no rows on the mail server has no keys', () => {
    expect(buildDkimKeyList({ rows: [row({ domainId: 'other' })], stalwartDomainId: SID, domainName: DOMAIN, activeSelector: 'dkim-1', published: [] })).toEqual([]);
  });
});

describe('withPublishedDkim', () => {
  const spec = (purpose: DnsRecordSpec['purpose'], name: string): DnsRecordSpec => ({
    recordType: purpose === 'mx' ? 'MX' : 'TXT', recordName: name, recordValue: 'v', ttl: 3600, priority: null, purpose,
  });
  const published = [
    { name: 'dkim-1._domainkey.example.test', value: 'v=DKIM1; p=A', ttl: 3600 },
    { name: 'dkim-2._domainkey.example.test', value: 'v=DKIM1; p=B', ttl: 300 },
  ];

  it('slots DKIM in right after SPF', () => {
    const out = withPublishedDkim([spec('mx', DOMAIN), spec('spf', DOMAIN), spec('dmarc', `_dmarc.${DOMAIN}`)], published);
    expect(out.map((r) => r.purpose)).toEqual(['mx', 'spf', 'dkim', 'dkim', 'dmarc']);
    expect(out[2]).toEqual({ recordType: 'TXT', recordName: 'dkim-1._domainkey.example.test', recordValue: 'v=DKIM1; p=A', ttl: 3600, priority: null, purpose: 'dkim' });
    expect(out[3].ttl).toBe(300);
  });

  it('appends when there is no SPF record, and leaves the list alone when nothing is published', () => {
    expect(withPublishedDkim([spec('mx', DOMAIN)], published).map((r) => r.purpose)).toEqual(['mx', 'dkim', 'dkim']);
    const base = [spec('mx', DOMAIN), spec('spf', DOMAIN)];
    expect(withPublishedDkim(base, [])).toEqual(base);
  });
});

describe('readPublishedDkimRecords', () => {
  function fakeDb(rows: unknown[]) {
    const seen: { where: unknown } = { where: null };
    const db = { select: () => ({ from: () => ({ where: async (w: unknown) => { seen.where = w; return rows; } }) }) };
    return { db: db as unknown as Database, seen };
  }

  it('asks for exactly this domain\'s dkim-1 / dkim-2 TXT rows', async () => {
    const { db, seen } = fakeDb([]);
    await readPublishedDkimRecords(db, 'domain-4', DOMAIN);
    const q = new PgDialect().sqlToQuery(seen.where as SQL);
    expect(q.sql).toMatch(/"dns_records"\."domain_id" = \$1 and "dns_records"\."record_type" = \$2 and "dns_records"\."record_name" in \(\$3, \$4\)/);
    expect(q.params).toEqual(['domain-4', 'TXT', 'dkim-1._domainkey.example.test', 'dkim-2._domainkey.example.test']);
  });

  it('drops rows with no value and returns dkim-1 before dkim-2', async () => {
    const { db } = fakeDb([
      { name: 'dkim-2._domainkey.example.test', value: 'v=DKIM1; p=B', ttl: 3600 },
      { name: 'dkim-1._domainkey.example.test', value: null, ttl: 3600 },
      { name: 'dkim-1._domainkey.example.test', value: 'v=DKIM1; p=A', ttl: 300 },
    ]);
    expect(await readPublishedDkimRecords(db, 'domain-4', DOMAIN)).toEqual([
      { name: 'dkim-1._domainkey.example.test', value: 'v=DKIM1; p=A', ttl: 300 },
      { name: 'dkim-2._domainkey.example.test', value: 'v=DKIM1; p=B', ttl: 3600 },
    ]);
  });
});
