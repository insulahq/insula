import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every upstream write the route-DNS paths make goes through these mocks, so a
// test can list exactly which values were withdrawn and which were written.
const deletes: string[] = [];
const provisions: string[] = [];
let staleRows: Array<{ id: string; recordType: string; recordName: string | null; recordValue: string | null }> = [];
let sharedValues = new Set<string>();

let refusedValue: string | null = null;

vi.mock('../dns-records/service.js', () => ({
  syncRecordToProviders: vi.fn(async (_db, _zone, action, record) => {
    if (action === 'delete') deletes.push(`${record.type} ${record.name} ${record.content}`);
    if (action === 'delete' && record.content === refusedValue) {
      return { status: 'failed', errors: [{ server: 'ns1', message: 'PowerDNS API error: 500' }] };
    }
    return { status: 'published', servers: 1 };
  }),
  provisionManagedRecord: vi.fn(async (_db, _owner, _domain, record) => {
    provisions.push(`${record.type} ${record.name} ${record.content}`);
    return { status: 'published', servers: 1 };
  }),
  deleteManagedRecords: vi.fn(async () => staleRows),
  rowsPublishingSameValue: vi.fn(async (_db, _zone, _row, value) => (sharedValues.has(value.recordValue) ? ['manual-row'] : [])),
  describeSyncFailure: vi.fn((o: { errors: Array<{ message: string }> }) => o.errors[0].message),
}));

import { autoDeleteRouteDns, refreshRouteDnsForDomain } from './service.js';
import { domains, dnsRecords, ingressRoutes, platformSettings } from '../../db/schema.js';

/** Every bound parameter in a drizzle condition — how the fake reads which
 *  setting key a `getSetting` call asked for. */
function paramsOf(node: unknown, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) out.push(obj.value);
  for (const chunk of (obj.queryChunks as unknown[] | undefined) ?? []) paramsOf(chunk, out);
  return out;
}

const DOMAIN = { id: 'd1', domainName: 'example.test', dnsMode: 'primary' };

function fakeDb(fixture: { settings: Record<string, string>; records?: unknown[]; routes?: Array<{ hostname: string }> }) {
  const deletedRows = vi.fn();
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async (cond: unknown) => {
          if (table === platformSettings) {
            const key = paramsOf(cond).find((v): v is string => typeof v === 'string' && v in fixture.settings);
            return key ? [{ key, value: fixture.settings[key] }] : [];
          }
          if (table === domains) return [DOMAIN];
          if (table === dnsRecords) return fixture.records ?? [];
          if (table === ingressRoutes) return fixture.routes ?? [];
          return [];
        },
      }),
    }),
    delete: () => ({ where: deletedRows }),
  };
  return { db: db as never, deletedRows };
}

beforeEach(() => {
  deletes.length = 0;
  provisions.length = 0;
  staleRows = [];
  sharedValues = new Set();
  refusedValue = null;
});

describe('autoDeleteRouteDns', () => {
  it('withdraws the current ingress addresses AND the addresses the rows still hold — value by value', async () => {
    const { db, deletedRows } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      records: [
        { id: 'r1', recordType: 'A', recordName: 'shop', recordValue: '203.0.113.1' },
        // The address a since-removed ingress node had when the route was created.
        { id: 'r2', recordType: 'A', recordName: 'shop', recordValue: '198.51.100.7' },
        { id: 'r3', recordType: 'TXT', recordName: 'shop', recordValue: 'v=spf1 -all' },
      ],
    });

    await autoDeleteRouteDns(db, 'd1', 'shop.example.test');

    expect(deletes.sort()).toEqual(['A shop 198.51.100.7', 'A shop 203.0.113.1']);
    expect(deletedRows).toHaveBeenCalledTimes(2); // the two A rows, never the TXT
  });
});

describe('refreshRouteDnsForDomain', () => {
  it('re-provisions the current set and withdraws only addresses that are gone and unshared', async () => {
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1,203.0.113.2' },
      routes: [{ hostname: 'example.test' }],
    });
    staleRows = [
      { id: 's1', recordType: 'A', recordName: '@', recordValue: '203.0.113.1' }, // still current
      { id: 's2', recordType: 'A', recordName: '@', recordValue: '198.51.100.7' }, // node gone
      { id: 's3', recordType: 'A', recordName: '@', recordValue: '198.51.100.8' }, // gone, but a hand-made row holds it
    ];
    sharedValues = new Set(['198.51.100.8']);

    const result = await refreshRouteDnsForDomain(db, 'd1');

    expect(deletes).toEqual(['A @ 198.51.100.7']);
    expect(provisions).toEqual(['A @ 203.0.113.1', 'A @ 203.0.113.2']);
    expect(result).toMatchObject({ hostnames: 1, removed: 3, failures: [] });
  });

  it('reports a stale address the server would not withdraw instead of counting it gone', async () => {
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      routes: [{ hostname: 'example.test' }],
    });
    staleRows = [{ id: 's1', recordType: 'A', recordName: '@', recordValue: '198.51.100.7' }];
    refusedValue = '198.51.100.7';

    const result = await refreshRouteDnsForDomain(db, 'd1');

    expect(result.failures).toEqual([
      { hostname: 'example.test', detail: 'A 198.51.100.7 is still published: PowerDNS API error: 500' },
    ]);
  });

  it("refreshes a route's www companion too — the name that usually serves the site", async () => {
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1,203.0.113.2' },
      routes: [{ hostname: 'example.test', wwwRedirect: 'add-www' } as never],
    });

    const result = await refreshRouteDnsForDomain(db, 'd1');

    expect(provisions).toEqual([
      'A @ 203.0.113.1', 'A @ 203.0.113.2',
      'A www 203.0.113.1', 'A www 203.0.113.2',
    ]);
    expect(result).toMatchObject({ hostnames: 2, failures: [] });
  });
});
