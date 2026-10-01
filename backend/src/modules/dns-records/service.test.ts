import { describe, it, expect, vi, beforeEach } from 'vitest';

// One primary PowerDNS-style server whose provider records every call, so a
// test can assert exactly which values were withdrawn upstream.
const provider = {
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

import { listDnsRecords, createDnsRecord, updateDnsRecord, deleteDnsRecord } from './service.js';
import { ApiError } from '../../shared/errors.js';

beforeEach(() => { vi.clearAllMocks(); });

function createMockDb(selectResult: unknown[] = []) {
  const whereFn = vi.fn().mockResolvedValue(selectResult);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
  } as unknown as Parameters<typeof listDnsRecords>[0];
}

const DOMAIN = { id: 'd1', tenantId: 'c1', domainName: 'example.com' };
const RECORD = { id: 'r1', domainId: 'd1', recordType: 'A', recordName: '@', recordValue: '1.2.3.4', ttl: 3600, priority: null, weight: null, port: null, updatedAt: new Date() };

describe('listDnsRecords', () => {
  it('should return records for a valid domain', async () => {
    const db = createMockDb([DOMAIN]);
    const result = await listDnsRecords(db, 'c1', 'd1');
    expect(result).toBeDefined();
  });

  it('should throw DOMAIN_NOT_FOUND for invalid domain', async () => {
    const db = createMockDb([]);
    await expect(listDnsRecords(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'DOMAIN_NOT_FOUND',
      status: 404,
    });
  });
});

describe('createDnsRecord', () => {
  it('should create and return a DNS record', async () => {
    // Call sequence (ADR-040 reserved-subdomain check added between
    // verifyDomainOwnership and the final select):
    //   1. verifyDomainOwnership                       → [DOMAIN]
    //   2. assertNotReservedHostname → parent domain   → [DOMAIN]
    //   3. getReservedPlatformHostnames → system_settings → []
    //   4. getReservedPlatformHostnames → platform_settings → []
    //   5. (insert happens here — not a select)
    //   6. final read of created record                → [RECORD]
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1 || callCount === 2) return Promise.resolve([DOMAIN]);
      if (callCount === 3 || callCount === 4) return Promise.resolve([]);
      return Promise.resolve([RECORD]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });

    const db = { select: selectFn, insert: insertFn } as unknown as Parameters<typeof createDnsRecord>[0];

    const result = await createDnsRecord(db, 'c1', 'd1', {
      record_type: 'A',
      record_value: '1.2.3.4',
      ttl: 3600,
    });
    expect(result).toEqual(RECORD);
    expect(insertFn).toHaveBeenCalled();
  });

  it('should throw for invalid domain', async () => {
    const db = createMockDb([]);
    await expect(createDnsRecord(db, 'c1', 'missing', {
      record_type: 'A',
      record_value: '1.2.3.4',
    })).rejects.toMatchObject({ code: 'DOMAIN_NOT_FOUND' });
  });
});

describe('updateDnsRecord', () => {
  it('should throw DNS_RECORD_NOT_FOUND for missing record', async () => {
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([DOMAIN]);
      return Promise.resolve([]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof updateDnsRecord>[0];

    await expect(updateDnsRecord(db, 'c1', 'd1', 'missing', { ttl: 7200 })).rejects.toMatchObject({
      code: 'DNS_RECORD_NOT_FOUND',
      status: 404,
    });
  });

  /**
   * Selects in order: ownership, the row, the row after the write, the
   * domain, rows sharing the OLD value, rows sharing the NEW value, then the
   * sync layer's authority lookup.
   */
  function dbForEdit(oldValueSiblings: unknown[]) {
    const updated = { ...RECORD, recordValue: '5.6.7.8' };
    const results: unknown[][] = [[DOMAIN], [RECORD], [updated], [DOMAIN], oldValueSiblings, [updated], [{ dnsMode: 'primary' }]];
    const whereFn = vi.fn().mockImplementation(() => Promise.resolve(results.shift() ?? []));
    return {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: whereFn }) }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Parameters<typeof updateDnsRecord>[0];
  }

  it('publishes the new value and withdraws the old one', async () => {
    await updateDnsRecord(dbForEdit([]), 'c1', 'd1', 'r1', { record_value: '5.6.7.8' });

    expect(provider.createRecord).toHaveBeenCalledWith('example.com', expect.objectContaining({ type: 'A', content: '5.6.7.8' }));
    expect(provider.deleteRecordValue).toHaveBeenCalledWith('example.com', expect.objectContaining({ type: 'A', content: '1.2.3.4' }));
    expect(provider.deleteRecord).not.toHaveBeenCalled();
  });

  it('keeps the old value published when another row still holds it', async () => {
    const twin = { ...RECORD, id: 'r2', recordName: null };

    await updateDnsRecord(dbForEdit([twin]), 'c1', 'd1', 'r1', { record_value: '5.6.7.8' });

    expect(provider.createRecord).toHaveBeenCalled();
    expect(provider.deleteRecordValue).not.toHaveBeenCalled();
  });
});

describe('deleteDnsRecord', () => {
  /**
   * The selects deleteDnsRecord makes, in order: ownership check, the row,
   * the domain, the domain's rows of that type (who else publishes the
   * value?), then the sync layer's authority lookup.
   */
  function dbFor(siblings: unknown[]) {
    const results: unknown[][] = [[DOMAIN], [RECORD], [DOMAIN], siblings, [{ dnsMode: 'primary' }]];
    const whereFn = vi.fn().mockImplementation(() => Promise.resolve(results.shift() ?? []));
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: whereFn }) }),
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteDnsRecord>[0];
    return { db, deleteFn };
  }

  it("withdraws only this row's value upstream — never the whole name", async () => {
    const { db, deleteFn } = dbFor([RECORD]);

    await deleteDnsRecord(db, 'c1', 'd1', 'r1');

    expect(provider.deleteRecordValue).toHaveBeenCalledWith('example.com', expect.objectContaining({
      type: 'A', name: '@', content: '1.2.3.4',
    }));
    expect(provider.deleteRecord).not.toHaveBeenCalled();
    expect(deleteFn).toHaveBeenCalled();
  });

  it('leaves the value published when another row (any apex spelling) still holds it', async () => {
    const twin = { ...RECORD, id: 'r2', recordName: 'example.com' };
    const { db, deleteFn } = dbFor([RECORD, twin]);

    await deleteDnsRecord(db, 'c1', 'd1', 'r1');

    expect(provider.deleteRecordValue).not.toHaveBeenCalled();
    expect(provider.deleteRecord).not.toHaveBeenCalled();
    expect(deleteFn).toHaveBeenCalled();
  });

  it('keeps the row when the server refuses the deletion', async () => {
    provider.deleteRecordValue.mockRejectedValueOnce(new Error('PowerDNS API error: 500 — down'));
    const { db, deleteFn } = dbFor([RECORD]);

    await expect(deleteDnsRecord(db, 'c1', 'd1', 'r1')).rejects.toMatchObject({ code: 'DNS_PUBLISH_FAILED' });
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it('should throw DNS_RECORD_NOT_FOUND for missing record', async () => {
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([DOMAIN]);
      return Promise.resolve([]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof deleteDnsRecord>[0];

    await expect(deleteDnsRecord(db, 'c1', 'd1', 'missing')).rejects.toMatchObject({
      code: 'DNS_RECORD_NOT_FOUND',
    });
  });
});
