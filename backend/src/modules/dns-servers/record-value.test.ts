import { describe, it, expect, vi } from 'vitest';
import { removeRecordValue } from './record-value.js';
import { MockDnsProvider } from './providers/mock.js';
import type { DnsProviderAdapter } from './providers/types.js';

const ZONE = 'example.test';

/** The in-memory provider addresses records by its own ids and has no
 *  `deleteRecordValue` — the shape of Cloudflare, Hetzner and ClouDNS. */
async function idAddressedZone() {
  const provider = new MockDnsProvider();
  await provider.createZone(ZONE, 'Native');
  await provider.createRecord(ZONE, { type: 'A', name: '@', content: '203.0.113.1' });
  await provider.createRecord(ZONE, { type: 'A', name: '@', content: '203.0.113.2' });
  return provider;
}

describe('removeRecordValue — id-addressed providers', () => {
  it('looks up the id of exactly this value and deletes only that record', async () => {
    const provider = await idAddressedZone();

    await removeRecordValue(provider, ZONE, { type: 'A', name: ZONE, content: '203.0.113.1' });

    expect((await provider.listRecords(ZONE)).map((r) => r.content)).toEqual(['203.0.113.2']);
  });

  it('matches an MX whose provider stores the priority separately', async () => {
    const provider = new MockDnsProvider();
    await provider.createZone(ZONE, 'Native');
    await provider.createRecord(ZONE, { type: 'MX', name: '@', content: 'mx1.example.test.', priority: 10 });
    await provider.createRecord(ZONE, { type: 'MX', name: '@', content: 'mx2.example.test.', priority: 20 });

    await removeRecordValue(provider, ZONE, { type: 'MX', name: '@', content: 'MX1.example.test', priority: 10 });

    expect((await provider.listRecords(ZONE)).map((r) => r.content)).toEqual(['mx2.example.test.']);
  });

  it('is a no-op when the value is not published', async () => {
    const provider = await idAddressedZone();
    const del = vi.spyOn(provider, 'deleteRecord');

    await removeRecordValue(provider, ZONE, { type: 'A', name: '@', content: '203.0.113.99' });

    expect(del).not.toHaveBeenCalled();
    expect(await provider.listRecords(ZONE)).toHaveLength(2);
  });
});

describe('removeRecordValue — routing', () => {
  it('hands the value to a provider that can remove one value itself', async () => {
    const deleteRecordValue = vi.fn(async () => undefined);
    const deleteRecord = vi.fn();
    const provider = { deleteRecordValue, deleteRecord } as unknown as DnsProviderAdapter;

    await removeRecordValue(provider, ZONE, { type: 'A', name: '@', content: '203.0.113.1' });

    expect(deleteRecordValue).toHaveBeenCalledWith(ZONE, { type: 'A', name: '@', content: '203.0.113.1' });
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it('skips a value that could never have been written (legacy MX row without a priority)', async () => {
    const deleteRecordValue = vi.fn();
    const provider = { deleteRecordValue } as unknown as DnsProviderAdapter;

    await removeRecordValue(provider, ZONE, { type: 'MX', name: '@', content: 'mx.example.test' });

    expect(deleteRecordValue).not.toHaveBeenCalled();
  });
});
