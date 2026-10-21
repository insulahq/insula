import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Restore publishes the zones the archive removed, from the rows it kept:
 * the zone with its group's nameservers, then every stored record — except
 * what a fresh zone already carries.
 */

const { provider, servers, group } = vi.hoisted(() => ({
  provider: {
    createZone: vi.fn(async () => undefined),
    createSlaveZone: vi.fn(async () => undefined),
    replaceNsRecords: vi.fn(async () => undefined),
    createRecord: vi.fn(async () => undefined),
  },
  servers: { current: [{ id: 's1', displayName: 'ns-primary', providerType: 'powerdns', enabled: 1, role: 'primary', zoneDefaultKind: 'Native' }] as unknown[] },
  group: { nsHostnames: ['ns1.example.test', 'ns2.example.test'] },
}));
vi.mock('../dns-servers/service.js', () => ({
  getActiveServersForDomain: vi.fn(async () => servers.current),
  getProviderForServer: vi.fn(() => provider),
  getProviderGroupById: vi.fn(async () => group),
}));
vi.mock('../dns-servers/authority.js', () => ({
  canManageDnsZone: vi.fn(({ dnsMode }: { dnsMode: string }) => dnsMode === 'primary'),
}));

const { republishTenantZones, zoneOwnsRecord } = await import('./restore-dns.js');
const { domains: domainsTable, emailDomains: emailDomainsTable } = await import('../../db/schema.js');

function db(domains: unknown[], records: unknown[], mailDomains: unknown[] = []) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === domainsTable ? domains : table === emailDomainsTable ? mailDomains : records),
      }),
    }),
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe('zoneOwnsRecord', () => {
  it('SOA and the apex NS come with the zone; everything else is pushed', () => {
    expect(zoneOwnsRecord({ recordType: 'SOA', recordName: '@' }, 'example.test')).toBe(true);
    expect(zoneOwnsRecord({ recordType: 'NS', recordName: '@' }, 'example.test')).toBe(true);
    expect(zoneOwnsRecord({ recordType: 'NS', recordName: 'example.test.' }, 'example.test')).toBe(true);
    expect(zoneOwnsRecord({ recordType: 'NS', recordName: 'sub' }, 'example.test')).toBe(false);
    expect(zoneOwnsRecord({ recordType: 'MX', recordName: '@' }, 'example.test')).toBe(false);
  });
});

describe('republishTenantZones', () => {
  it('a primary zone with its group\'s nameservers, then its records', async () => {
    const r = await republishTenantZones(
      db([{ id: 'd1', domainName: 'example.test', dnsMode: 'primary', dnsGroupId: 'g1', masterIp: null }], [
        { recordType: 'SOA', recordName: '@', recordValue: 'x', ttl: 3600, priority: null },
        { recordType: 'NS', recordName: '@', recordValue: 'ns1.example.test', ttl: 3600, priority: null },
        { recordType: 'A', recordName: 'www', recordValue: '192.0.2.10', ttl: 3600, priority: null },
        { recordType: 'MX', recordName: '@', recordValue: 'mail.example.test', ttl: 3600, priority: 10 },
      ]),
      't1',
      'key',
    );
    expect(provider.createZone).toHaveBeenCalledWith('example.test', 'Native', ['ns1.example.test', 'ns2.example.test']);
    expect(provider.replaceNsRecords).toHaveBeenCalledWith('example.test', ['ns1.example.test', 'ns2.example.test']);
    expect(provider.createRecord.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { type: 'A', name: 'www', content: '192.0.2.10', ttl: 3600, priority: undefined },
      { type: 'MX', name: '@', content: 'mail.example.test', ttl: 3600, priority: 10 },
    ]);
    expect(r).toMatchObject({ zones: 1, records: 2, failures: [] });
  });

  it('leaves out the mail records of a mail domain the restore rebuilds: it writes them afresh, with the new DKIM key', async () => {
    const mailRecords = [
      { recordType: 'MX', recordName: 'example.test', recordValue: 'mail.example.test', ttl: 3600, priority: 10 },
      { recordType: 'TXT', recordName: 'example.test', recordValue: 'v=spf1 mx ~all', ttl: 3600, priority: null },
      { recordType: 'TXT', recordName: '_dmarc.example.test', recordValue: 'v=DMARC1; p=none', ttl: 3600, priority: null },
      { recordType: 'TXT', recordName: 'sel._domainkey.example.test', recordValue: 'v=DKIM1; k=rsa; p=OLD', ttl: 3600, priority: null },
      { recordType: 'SRV', recordName: '_pop3s._tcp.example.test', recordValue: '20 1 995 mail.example.test', ttl: 3600, priority: 20 },
      { recordType: 'CNAME', recordName: 'webmail.example.test', recordValue: 'webmail.example.test.', ttl: 3600, priority: null },
    ];
    const site = { recordType: 'A', recordName: 'www', recordValue: '192.0.2.10', ttl: 3600, priority: null };
    const r = await republishTenantZones(
      db(
        [{ id: 'd1', domainName: 'example.test', dnsMode: 'primary', dnsGroupId: 'g1', masterIp: null }],
        [site, ...mailRecords],
        [{ domainId: 'd1', stalwartDomainId: null, webmailEnabled: 1 }],
      ),
      't1',
      'key',
    );
    expect(provider.createRecord.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      { type: 'A', name: 'www', content: '192.0.2.10', ttl: 3600, priority: undefined },
    ]);
    expect(r.records).toBe(1);
  });

  it('a domain whose mail is not rebuilt keeps its MX (a hand-made one, or a mail domain still on the server)', async () => {
    await republishTenantZones(
      db(
        [{ id: 'd1', domainName: 'example.test', dnsMode: 'primary', dnsGroupId: 'g1', masterIp: null }],
        [{ recordType: 'MX', recordName: '@', recordValue: 'mx.elsewhere.test', ttl: 3600, priority: 10 }],
        [{ domainId: 'd1', stalwartDomainId: 'still-there', webmailEnabled: 0 }],
      ),
      't1',
      'key',
    );
    expect(provider.createRecord).toHaveBeenCalledTimes(1);
  });

  it('a secondary zone points at its master again', async () => {
    await republishTenantZones(db([{ id: 'd1', domainName: 'example.test', dnsMode: 'secondary', dnsGroupId: null, masterIp: '192.0.2.53' }], []), 't1', 'key');
    expect(provider.createSlaveZone).toHaveBeenCalledWith('example.test', '192.0.2.53');
    expect(provider.createZone).not.toHaveBeenCalled();
  });

  it('a zone kept elsewhere (cname mode) had nothing removed and gets nothing', async () => {
    await republishTenantZones(db([{ id: 'd1', domainName: 'example.test', dnsMode: 'cname', dnsGroupId: null, masterIp: null }], []), 't1', 'key');
    expect(provider.createZone).not.toHaveBeenCalled();
  });

  it('a zone the archive could not remove still gets its records, and the restore goes on', async () => {
    provider.createZone.mockRejectedValueOnce(new Error('zone exists'));
    const r = await republishTenantZones(
      db([{ id: 'd1', domainName: 'example.test', dnsMode: 'primary', dnsGroupId: 'g1', masterIp: null }], [
        { recordType: 'A', recordName: 'www', recordValue: '192.0.2.10', ttl: 3600, priority: null },
      ]),
      't1',
      'key',
    );
    expect(provider.createRecord).toHaveBeenCalledTimes(1);
    expect(r.failures).toEqual([expect.stringContaining('zone not created (zone exists)')]);
  });
});
