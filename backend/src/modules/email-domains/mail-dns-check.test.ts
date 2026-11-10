import { describe, it, expect } from 'vitest';
import { buildEmailDnsRecordsForDisplay, type DnsRecordSpec } from './dns-provisioning.js';
import { checkMailDns, mergeDmarc, mergeSpf, txtText, type StoredRecord, type ZoneRecord } from './mail-dns-check.js';

const DOMAIN = 'example.test';
const HOST = 'mail.platform.test';
const EXPECTED = buildEmailDnsRecordsForDisplay(DOMAIN, '', '', HOST);
const OUR_DMARC = `v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN}`;

/** The zone a server lists after enabling email: every platform record, in its spelling. */
function platformZone(): ZoneRecord[] {
  return [
    { type: 'SOA', name: `${DOMAIN}.`, content: 'ns1.platform.test. hostmaster.platform.test. 1 10800 3600 604800 3600' },
    { type: 'NS', name: `${DOMAIN}.`, content: 'ns1.platform.test.' },
    { type: 'MX', name: `${DOMAIN}.`, content: `10 ${HOST}.` },
    { type: 'TXT', name: `${DOMAIN}.`, content: '"v=spf1 mx ~all"' },
    { type: 'TXT', name: `_dmarc.${DOMAIN}.`, content: `"${OUR_DMARC}"` },
    { type: 'SRV', name: `_imaps._tcp.${DOMAIN}.`, content: `0 1 993 ${HOST}.` },
    { type: 'SRV', name: `_imap._tcp.${DOMAIN}.`, content: `10 1 143 ${HOST}.` },
    { type: 'SRV', name: `_pop3s._tcp.${DOMAIN}.`, content: `20 1 995 ${HOST}.` },
    { type: 'SRV', name: `_submissions._tcp.${DOMAIN}.`, content: `0 1 465 ${HOST}.` },
    { type: 'SRV', name: `_submission._tcp.${DOMAIN}.`, content: `10 1 587 ${HOST}.` },
    { type: 'A', name: `www.${DOMAIN}.`, content: '192.0.2.10' },
  ];
}

/** The rows enabling email stores, one per platform record. */
function platformRows(expected: readonly DnsRecordSpec[] = EXPECTED): StoredRecord[] {
  return expected.map((s, i) => ({
    id: `row-${i}`, recordType: s.recordType, recordName: s.recordName, recordValue: s.recordValue, priority: s.priority,
  }));
}

function check(zone: ZoneRecord[], stored: StoredRecord[] = platformRows(), expected: readonly DnsRecordSpec[] = EXPECTED) {
  return checkMailDns({ domainName: DOMAIN, mailHost: HOST, expected, zone, stored });
}

const statusOf = (r: ReturnType<typeof check>, purpose: string) =>
  r.records.filter((x) => x.spec.purpose === purpose).map((x) => x.status);

describe('txtText', () => {
  it('reads a quoted, split TXT value as the one text it is', () => {
    expect(txtText('"v=DKIM1; k=rsa; p=AAA" "BBB"')).toBe('v=DKIM1; k=rsa; p=AAABBB');
    expect(txtText('v=spf1 mx ~all')).toBe('v=spf1 mx ~all');
    expect(txtText('"say \\"hi\\""')).toBe('say "hi"');
  });
});

describe('checkMailDns — a zone with exactly the platform records', () => {
  it('reports every record ok, no issue, and nothing to change', () => {
    const r = check(platformZone());
    expect(r.records.every((x) => x.status === 'ok')).toBe(true);
    expect(r.records).toHaveLength(EXPECTED.length);
    expect(r.issues).toEqual([]);
    expect(r.plan).toEqual({ add: [], remove: [], adopt: [], dropStored: [] });
  });

  it('keeps the builder order, so the table reads as before', () => {
    expect(check(platformZone()).records.map((x) => x.spec)).toEqual(EXPECTED);
  });

  it('ignores the spelling: host case, a missing trailing dot, an unquoted TXT', () => {
    const zone = platformZone().map((z) => (z.type === 'MX' ? { ...z, content: `10 MAIL.Platform.TEST` } : z))
      .map((z) => (z.type === 'TXT' && z.name === `${DOMAIN}.` ? { ...z, content: 'v=spf1 mx ~all' } : z));
    expect(check(zone).issues).toEqual([]);
    expect(statusOf(check(zone), 'mx')).toEqual(['ok']);
  });
});

describe("checkMailDns — the old provider's records next to the platform's", () => {
  // What enabling email on a moved-in domain used to leave behind.
  const zone = (): ZoneRecord[] => [
    ...platformZone(),
    { type: 'MX', name: `${DOMAIN}.`, content: '10 mx.old-provider.test.' },
    { type: 'TXT', name: `${DOMAIN}.`, content: '"v=spf1 include:_spf.old-provider.test ~all"' },
    { type: 'TXT', name: `_dmarc.${DOMAIN}.`, content: '"v=DMARC1; p=none; rua=mailto:reports@old-provider.test"' },
  ];

  it('flags the second MX, SPF and DMARC record as errors the repair removes', () => {
    const r = check(zone());
    expect(r.issues.map((i) => [i.kind, i.severity, i.removable])).toEqual([
      ['duplicate_spf', 'error', true],
      ['duplicate_dmarc', 'error', true],
      ['foreign_mx', 'error', true],
    ]);
    expect(r.issues.find((i) => i.kind === 'foreign_mx')?.message).toContain('mx.old-provider.test');
    expect(r.issues.find((i) => i.kind === 'duplicate_spf')?.value).toBe('v=spf1 include:_spf.old-provider.test ~all');
  });

  it("merges the SPF and DMARC records into one each, so no sender or report address is lost", () => {
    const r = check(zone());
    expect(r.plan.add.map((a) => [a.group, a.spec.recordValue])).toEqual([
      ['spf', 'v=spf1 mx include:_spf.old-provider.test ~all'],
      ['dmarc', `v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN},mailto:reports@old-provider.test`],
    ]);
    // Both old records of each go once the merged one is in; the other MX may be kept.
    expect(r.plan.remove.map((x) => [x.group, x.type, x.value, x.optional])).toEqual([
      ['spf', 'TXT', 'v=spf1 mx ~all', false],
      ['spf', 'TXT', 'v=spf1 include:_spf.old-provider.test ~all', false],
      ['dmarc', 'TXT', OUR_DMARC, false],
      ['dmarc', 'TXT', 'v=DMARC1; p=none; rua=mailto:reports@old-provider.test', false],
      ['mx', 'MX', '10 mx.old-provider.test.', true],
    ]);
    // The platform's own records still publish them: their rows go with them.
    expect(r.plan.remove.find((x) => x.value === 'v=spf1 mx ~all')?.storedIds).toHaveLength(1);
    expect(r.plan.remove.find((x) => x.type === 'MX')?.storedIds).toEqual([]);
    expect(statusOf(r, 'spf')).toEqual(['ok']);
    expect(statusOf(r, 'dmarc')).toEqual(['ok']);
  });

  it('removes a stored duplicate through its rows', () => {
    const stored = [...platformRows(), { id: 'old-mx', recordType: 'MX', recordName: DOMAIN, recordValue: 'mx.old-provider.test', priority: 10 }];
    const mx = check(zone(), stored).plan.remove.find((x) => x.type === 'MX');
    expect(mx?.storedIds).toEqual(['old-mx']);
  });
});

describe('checkMailDns — DMARC published twice', () => {
  const both = (ours: string, theirs: string): ZoneRecord[] => [
    ...platformZone().filter((z) => !z.name.startsWith('_dmarc.')),
    { type: 'TXT', name: `_dmarc.${DOMAIN}.`, content: `"${ours}"` },
    { type: 'TXT', name: `_dmarc.${DOMAIN}.`, content: `"${theirs}"` },
  ];

  it('never loosens: the stricter policy of the other record is kept', () => {
    const r = check(both(OUR_DMARC, 'v=DMARC1; p=reject; rua=mailto:reports@old-provider.test'));
    expect(r.plan.remove).toHaveLength(2);
    expect(r.plan.add.map((a) => a.spec.recordValue)).toEqual([
      `v=DMARC1; p=reject; rua=mailto:dmarc@${DOMAIN},mailto:reports@old-provider.test`,
    ]);
  });

  it("the platform's default does not tighten what the domain published", () => {
    const r = check(both('v=DMARC1; p=none', 'v=DMARC1; p=none; rua=mailto:x@old-provider.test; sp=reject'));
    expect(r.plan.add.map((a) => a.spec.recordValue)).toEqual([
      `v=DMARC1; p=none; rua=mailto:dmarc@${DOMAIN},mailto:x@old-provider.test; sp=reject`,
    ]);
    expect(statusOf(r, 'dmarc')).toEqual(['missing']);
  });
});

describe('mergeSpf / mergeDmarc', () => {
  it('keeps every mechanism once, mx first, one all at the end', () => {
    expect(mergeSpf(['v=spf1 include:_spf.google.test -all', 'v=spf1 +mx ip4:192.0.2.1 include:_spf.google.test ~all'], 'v=spf1 mx ~all'))
      .toBe('v=spf1 mx include:_spf.google.test ip4:192.0.2.1 ~all');
  });

  it('turns a redirect into an include and drops exp=', () => {
    expect(mergeSpf(['v=spf1 redirect=_spf.old.test', 'v=spf1 a exp=explain.old.test -all'], 'v=spf1 mx ~all'))
      .toBe('v=spf1 mx include:_spf.old.test a ~all');
  });

  it('unions the report addresses, the platform first, and keeps the other tags', () => {
    expect(mergeDmarc(['v=DMARC1; p=none; rua=mailto:A@old.test; ruf=mailto:f@old.test; pct=50', 'v=DMARC1; p=quarantine; rua=mailto:a@old.test'], OUR_DMARC))
      .toBe(`v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN},mailto:A@old.test; ruf=mailto:f@old.test; pct=50`);
  });
});

describe("checkMailDns — the tenant's own SPF or DMARC record", () => {
  const withSpf = (spf: string): ZoneRecord[] =>
    platformZone().map((z) => (z.type === 'TXT' && z.name === `${DOMAIN}.` ? { ...z, content: `"${spf}"` } : z));

  it('a single SPF that includes mx stands in for the platform one, without a warning', () => {
    const r = check(withSpf('v=spf1 mx include:_spf.newsletter.test ~all'));
    expect(statusOf(r, 'spf')).toEqual(['replaced']);
    expect(r.issues).toEqual([]);
    expect(r.plan.add).toEqual([]);
  });

  it('a single SPF without mx is kept, with a warning the repair does not act on', () => {
    const r = check(withSpf('v=spf1 include:_spf.old-provider.test -all'));
    expect(statusOf(r, 'spf')).toEqual(['replaced']);
    expect(r.issues.map((i) => [i.kind, i.severity, i.removable])).toEqual([['spf_without_platform', 'warning', false]]);
    expect(r.issues[0].message).toContain('Add `mx`');
    expect(r.plan.add).toEqual([]);
    expect(r.plan.remove).toEqual([]);
  });

  it("a single DMARC record reporting elsewhere is kept, and stored so the policy buttons can act on it", () => {
    const theirs = 'v=DMARC1; p=reject; rua=mailto:reports@old-provider.test';
    const zone = platformZone().map((z) => (z.name === `_dmarc.${DOMAIN}.` ? { ...z, content: `"${theirs}"` } : z));
    const stored = platformRows().filter((r) => !r.recordName?.startsWith('_dmarc.'));
    const r = check(zone, stored);
    expect(statusOf(r, 'dmarc')).toEqual(['replaced']);
    expect(r.issues.map((i) => i.kind)).toEqual(['dmarc_reports_elsewhere']);
    expect(r.issues[0].message).toContain('reports@old-provider.test');
    expect(r.plan.adopt).toEqual([{ type: 'TXT', name: `_dmarc.${DOMAIN}`, value: theirs, priority: null }]);
    expect(r.plan.add).toEqual([]);
  });
});

describe('checkMailDns — records deleted by accident', () => {
  it('re-publishes a deleted MX and SRV from their rows', () => {
    const zone = platformZone().filter((z) => z.type !== 'MX' && !z.name.startsWith('_imaps.'));
    const r = check(zone);
    expect(statusOf(r, 'mx')).toEqual(['missing']);
    expect(r.plan.add.map((a) => [a.group, a.spec.recordType, a.spec.recordName, a.storedIds.length > 0])).toEqual([
      ['mx', 'MX', DOMAIN, true],
      [`srv:_imaps._tcp.${DOMAIN}`, 'SRV', `_imaps._tcp.${DOMAIN}`, true],
    ]);
    expect(r.issues).toEqual([]);
  });

  it('creates a record whose row is gone too', () => {
    const zone = platformZone().filter((z) => !z.name.startsWith('_dmarc.'));
    const stored = platformRows().filter((r) => !r.recordName?.startsWith('_dmarc.'));
    const add = check(zone, stored).plan.add;
    expect(add.map((a) => [a.spec.purpose, a.spec.recordValue, a.storedIds])).toEqual([['dmarc', OUR_DMARC, []]]);
  });

  it('re-publishes a DKIM record from its row', () => {
    const dkim: DnsRecordSpec = { recordType: 'TXT', recordName: `dkim-1._domainkey.${DOMAIN}`, recordValue: 'v=DKIM1; k=rsa; p=AAAA', ttl: 3600, priority: null, purpose: 'dkim' };
    const expected = [...EXPECTED, dkim];
    const r = check(platformZone(), platformRows(expected), expected);
    expect(statusOf(r, 'dkim')).toEqual(['missing']);
    expect(r.plan.add.map((a) => a.spec.purpose)).toEqual(['dkim']);

    const published = check([...platformZone(), { type: 'TXT', name: `dkim-1._domainkey.${DOMAIN}.`, content: '"v=DKIM1; k=rsa; p=AA" "AA"' }], platformRows(expected), expected);
    expect(statusOf(published, 'dkim')).toEqual(['ok']);
  });
});

describe("checkMailDns — the platform's own names with an old value", () => {
  it('replaces a DKIM record of a rotated-away key instead of adding a second one', () => {
    const dkim: DnsRecordSpec = { recordType: 'TXT', recordName: `dkim-1._domainkey.${DOMAIN}`, recordValue: 'v=DKIM1; k=rsa; p=NEW', ttl: 3600, priority: null, purpose: 'dkim' };
    const expected = [...EXPECTED, dkim];
    const zone = [...platformZone(), { type: 'TXT', name: `dkim-1._domainkey.${DOMAIN}.`, content: '"v=DKIM1; k=rsa; p=OLD"' }];
    const r = check(zone, platformRows(expected), expected);
    expect(r.issues.map((i) => [i.kind, i.removable])).toEqual([['outdated_platform_record', true]]);
    expect(r.plan.add.map((a) => a.group)).toEqual([`dkim:dkim-1._domainkey.${DOMAIN}`]);
    expect(r.plan.remove.map((x) => [x.group, x.value, x.optional])).toEqual([[`dkim:dkim-1._domainkey.${DOMAIN}`, 'v=DKIM1; k=rsa; p=OLD', false]]);
  });

  it('repoints a webmail CNAME at an earlier target', () => {
    const expected = buildEmailDnsRecordsForDisplay(DOMAIN, '', '', HOST, { webmailEnabled: true, webmailHostname: 'webmail.platform.test' });
    const zone = [...platformZone(), { type: 'CNAME', name: `webmail.${DOMAIN}.`, content: `${HOST}.` }];
    const r = check(zone, platformRows(expected), expected);
    expect(statusOf(r, 'webmail')).toEqual(['missing']);
    expect(r.plan.add.map((a) => [a.group, a.spec.recordValue])).toEqual([['webmail', 'webmail.platform.test.']]);
    expect(r.plan.remove.map((x) => [x.group, x.type, x.value])).toEqual([['webmail', 'CNAME', `${HOST}.`]]);
  });
});

describe('checkMailDns — MX and SRV at another target', () => {
  it('a platform MX at another priority is still the platform MX', () => {
    const zone = platformZone().map((z) => (z.type === 'MX' ? { ...z, content: `20 ${HOST}.` } : z));
    const r = check(zone);
    expect(statusOf(r, 'mx')).toEqual(['ok']);
    expect(r.plan.add).toEqual([]);
  });

  it('only a foreign MX: the platform MX is added and the foreign one removed', () => {
    const zone = [...platformZone().filter((z) => z.type !== 'MX'), { type: 'MX', name: `${DOMAIN}.`, content: '5 mx.old-provider.test.' }];
    const r = check(zone);
    expect(r.plan.add.map((a) => [a.group, a.spec.purpose])).toEqual([['mx', 'mx']]);
    // Same group: the repair removes it only once the platform MX is in.
    expect(r.plan.remove.map((x) => [x.group, x.value, x.optional])).toEqual([['mx', '5 mx.old-provider.test.', true]]);
  });

  it('an SRV at another host is a warning the repair removes', () => {
    const zone = [...platformZone(), { type: 'SRV', name: `_submission._tcp.${DOMAIN}.`, content: '0 1 587 smtp.old-provider.test.' }];
    const r = check(zone);
    expect(r.issues.map((i) => [i.kind, i.severity, i.removable])).toEqual([['foreign_srv', 'warning', true]]);
  });

  it('an SRV target of "." (service not offered) is the tenant\'s choice, not a conflict', () => {
    const zone = [...platformZone().filter((z) => !z.name.startsWith('_pop3s.')), { type: 'SRV', name: `_pop3s._tcp.${DOMAIN}.`, content: '0 0 0 .' }];
    const r = check(zone);
    expect(r.issues).toEqual([]);
    expect(r.plan.add).toEqual([]);
  });

  it('leaves unrelated records alone: an old DKIM selector, another TXT, a subdomain MX', () => {
    const zone = [
      ...platformZone(),
      { type: 'TXT', name: `google._domainkey.${DOMAIN}.`, content: '"v=DKIM1; p=OLD"' },
      { type: 'TXT', name: `${DOMAIN}.`, content: '"google-site-verification=abc"' },
      { type: 'MX', name: `shop.${DOMAIN}.`, content: '10 mx.elsewhere.test.' },
    ];
    expect(check(zone).issues).toEqual([]);
    expect(check(zone).plan.remove).toEqual([]);
  });
});

describe('checkMailDns — stored rows the zone does not hold', () => {
  it('drops a stored second DMARC row, which only the panel counts', () => {
    const stored = [...platformRows(), { id: 'stale', recordType: 'TXT', recordName: '_dmarc', recordValue: '"v=DMARC1; p=none"' }];
    const r = check(platformZone(), stored);
    expect(r.plan.dropStored).toEqual([{ id: 'stale', type: 'TXT', name: `_dmarc.${DOMAIN}`, value: 'v=DMARC1; p=none' }]);
    expect(r.issues).toEqual([]);
  });

  it('does not drop a row it publishes again', () => {
    const zone = platformZone().filter((z) => !z.name.startsWith('_dmarc.'));
    const r = check(zone);
    expect(r.plan.add.map((a) => a.storedIds.length)).toEqual([1]);
    expect(r.plan.dropStored).toEqual([]);
  });

  it('stores a platform record the zone has and no row does', () => {
    const stored = platformRows().filter((r) => r.recordType !== 'MX');
    expect(check(platformZone(), stored).plan.adopt).toEqual([{ type: 'MX', name: DOMAIN, value: HOST, priority: 10 }]);
  });
});
