/**
 * migrateDomainDns — moving a domain to another DNS provider group. Found on DEV:
 * the target zone was created with no nameservers, the provider refused, the
 * empty catch swallowed it, and every record push then hit a missing zone —
 * "all record pushes failed" on every move.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const target = {
  createZone: vi.fn(async () => ({})),
  replaceNsRecords: vi.fn(async () => undefined),
  createRecord: vi.fn(async () => ({})),
  deleteZone: vi.fn(async () => undefined),
};
const dnsServers = vi.hoisted(() => ({
  getActiveServersForDomain: vi.fn(),
  getProviderForServer: vi.fn(),
  getDefaultGroup: vi.fn(),
  getPrimaryServersForGroup: vi.fn(),
  getActiveServers: vi.fn(async () => []),
  getProviderGroupById: vi.fn(),
}));
vi.mock('../dns-servers/service.js', () => dnsServers);
vi.mock('../dns-records/service.js', () => ({ importRemoteOnlyRecords: vi.fn(async () => []) }));

import { migrateDomainDns } from './service.js';
import type { Database } from '../../db/index.js';

const DOMAIN = { id: 'd1', tenantId: 't1', domainName: 'example.test', dnsGroupId: 'g-old', dnsMode: 'primary' };
const RECORDS = [
  { recordType: 'A', recordName: 'www', recordValue: '203.0.113.1', ttl: 300, priority: null, weight: null, port: null },
  { recordType: 'SRV', recordName: '_imaps._tcp', recordValue: 'mail.example.test', ttl: 3600, priority: 0, weight: 1, port: 993 },
];

function db(): Database {
  // getDomainById → domain; the records read → RECORDS; later reads → domain.
  const answers = [[DOMAIN], RECORDS, RECORDS, [DOMAIN]];
  const where = () => Promise.resolve(answers.shift() ?? [DOMAIN]);
  return {
    select: () => ({ from: () => ({ where }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as unknown as Database;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  dnsServers.getPrimaryServersForGroup.mockImplementation(async (_db: unknown, gid: string) =>
    [{ id: `s-${gid}`, displayName: gid, zoneDefaultKind: 'Native' }]);
  dnsServers.getProviderForServer.mockReturnValue(target);
});

describe('migrateDomainDns', () => {
  it('creates the target zone WITH the target group\'s nameservers', async () => {
    dnsServers.getProviderGroupById.mockResolvedValue({ id: 'g-new', name: 'new', nsHostnames: ['ns1.new.test', 'ns2.new.test'] });
    await migrateDomainDns(db(), 't1', 'd1', 'g-new');
    expect(target.createZone).toHaveBeenCalledWith('example.test', 'Native', ['ns1.new.test', 'ns2.new.test']);
  });

  it('pushes SRV records with their weight and port', async () => {
    dnsServers.getProviderGroupById.mockResolvedValue({ id: 'g-new', name: 'new', nsHostnames: ['ns1.new.test'] });
    await migrateDomainDns(db(), 't1', 'd1', 'g-new');
    expect(target.createRecord).toHaveBeenCalledWith('example.test', expect.objectContaining({
      type: 'SRV', priority: 0, weight: 1, port: 993,
    }));
  });

  it('a target group with no nameservers is refused before anything moves', async () => {
    dnsServers.getProviderGroupById.mockResolvedValue({ id: 'g-new', name: 'new', nsHostnames: [] });
    await expect(migrateDomainDns(db(), 't1', 'd1', 'g-new')).rejects.toMatchObject({ code: 'TARGET_GROUP_NO_NAMESERVERS', status: 400 });
    expect(target.createZone).not.toHaveBeenCalled();
    expect(target.createRecord).not.toHaveBeenCalled();
    expect(target.deleteZone).not.toHaveBeenCalled();
  });
});
