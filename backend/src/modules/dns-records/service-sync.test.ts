import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Sync Records' import and remove actions. The DB fake answers each SELECT in
 * the order the code issues them, so a test can say what the table held at
 * each step — and assert that the import never DELETEs and that a remote
 * removal touches no local row.
 */
const provider = {
  listRecords: vi.fn(async () => [] as Array<{ id: string; type: string; name: string; content: string; ttl: number; priority?: number | null }>),
  createRecord: vi.fn(async () => undefined),
  deleteRecord: vi.fn(async () => undefined),
  deleteRecordValue: vi.fn(async () => undefined),
};
vi.mock('../dns-servers/service.js', () => ({
  getActiveServers: vi.fn(async () => []),
  getActiveServersForDomain: vi.fn(async () => [
    { id: 's1', displayName: 'ns1', providerType: 'powerdns', enabled: 1, role: 'primary' },
  ]),
  getProviderForServer: vi.fn(() => provider),
}));

import { importRemoteOnlyRecords, removeLocalDnsRecord, removeRemoteDnsRecord } from './service.js';

beforeEach(() => { vi.clearAllMocks(); });

const DOMAIN = { id: 'd1', tenantId: 't1', domainName: 'example.test', dnsMode: 'primary' };
const WEBMAIL = {
  id: 'r-webmail', domainId: 'd1', recordType: 'CNAME', recordName: 'webmail.example.test',
  recordValue: 'webmail.platform.test.', ttl: 3600, priority: null, weight: null, port: null, managedBy: 'mail',
};

function sequencedDb(selects: unknown[][]) {
  const queue = [...selects];
  const next = () => queue.shift() ?? [];
  const whereResult = () => {
    const rows = next();
    // `.where()` is awaited directly, or followed by `.returning()` on a delete.
    return Object.assign(Promise.resolve(rows), { returning: vi.fn(async () => rows) });
  };
  const inserted: unknown[] = [];
  const deleteReturning = vi.fn(async () => [{ id: 'r-webmail' }]);
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(whereResult) })) })),
    insert: vi.fn(() => ({ values: vi.fn(async (v: unknown) => { inserted.push(v); }) })),
    delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: deleteReturning })) })),
    update: vi.fn(),
    execute: vi.fn(async () => undefined),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db: db as unknown as Parameters<typeof importRemoteOnlyRecords>[0], raw: db, inserted, deleteReturning };
}

describe('importRemoteOnlyRecords', () => {
  it('keeps a local-only row (the failed webmail push) and adds what only the server has', async () => {
    provider.listRecords.mockResolvedValueOnce([
      { id: 'x', type: 'TXT', name: 'extra.example.test.', content: '"hello"', ttl: 300 },
    ]);
    const { db, raw, inserted } = sequencedDb([
      [DOMAIN], // ownership
      [DOMAIN], // domain row
      [WEBMAIL], // local rows, under the lock
      [WEBMAIL, { id: 'new' }], // the returned list
    ]);

    const rows = await importRemoteOnlyRecords(db, 't1', 'd1');

    // Nothing local is deleted or rewritten — the webmail row keeps its
    // value and its owner column untouched.
    expect(raw.delete).not.toHaveBeenCalled();
    expect(raw.update).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ recordType: 'TXT', recordName: 'extra.example.test.', recordValue: '"hello"', ttl: 300 });
    expect(rows).toHaveLength(2);
  });

  it('leaves a conflict alone: no second CNAME next to the local one', async () => {
    provider.listRecords.mockResolvedValueOnce([
      { id: 'x', type: 'CNAME', name: 'webmail.example.test.', content: 'old.platform.test.', ttl: 3600 },
    ]);
    const { db, inserted } = sequencedDb([[DOMAIN], [DOMAIN], [WEBMAIL], [WEBMAIL]]);

    await importRemoteOnlyRecords(db, 't1', 'd1');

    expect(inserted).toEqual([]);
  });
});

describe('removeRemoteDnsRecord', () => {
  it('withdraws exactly that value from the server and touches no local row', async () => {
    const { db, raw } = sequencedDb([
      [DOMAIN], // ownership
      [DOMAIN], // domain row
      [WEBMAIL], // local rows: none publishes the old target
      [DOMAIN], // syncRecordToProviders: dnsMode
    ]);

    await removeRemoteDnsRecord(db, 't1', 'd1', { type: 'CNAME', name: 'webmail', value: 'old.platform.test.' });

    expect(provider.deleteRecordValue).toHaveBeenCalledWith('example.test', expect.objectContaining({
      type: 'CNAME', name: 'webmail', content: 'old.platform.test.',
    }));
    expect(raw.delete).not.toHaveBeenCalled();
  });

  it('refuses a value a local row still publishes — that is a record delete, not a server-only one', async () => {
    const { db } = sequencedDb([[DOMAIN], [DOMAIN], [WEBMAIL]]);

    await expect(removeRemoteDnsRecord(db, 't1', 'd1', {
      type: 'CNAME', name: 'webmail', value: 'webmail.platform.test',
    })).rejects.toMatchObject({ code: 'DNS_RECORD_STILL_LOCAL', status: 409 });
    expect(provider.deleteRecordValue).not.toHaveBeenCalled();
  });

  it('reports a server that refuses the deletion', async () => {
    provider.deleteRecordValue.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    const { db } = sequencedDb([[DOMAIN], [DOMAIN], [], [DOMAIN]]);

    await expect(removeRemoteDnsRecord(db, 't1', 'd1', { type: 'A', name: 'old', value: '203.0.113.9' }))
      .rejects.toMatchObject({ code: 'DNS_PUBLISH_FAILED', status: 502 });
  });
});

describe('removeLocalDnsRecord', () => {
  it('deletes the row and never calls the DNS server', async () => {
    const { db, deleteReturning } = sequencedDb([[DOMAIN]]);

    await removeLocalDnsRecord(db, 't1', 'd1', 'r-webmail');

    expect(deleteReturning).toHaveBeenCalled();
    expect(provider.deleteRecordValue).not.toHaveBeenCalled();
    expect(provider.deleteRecord).not.toHaveBeenCalled();
  });

  it('a row that is not this domain\'s is a 404', async () => {
    const { db, deleteReturning } = sequencedDb([[DOMAIN]]);
    deleteReturning.mockResolvedValueOnce([]);

    await expect(removeLocalDnsRecord(db, 't1', 'd1', 'other')).rejects.toMatchObject({ code: 'DNS_RECORD_NOT_FOUND', status: 404 });
  });
});
