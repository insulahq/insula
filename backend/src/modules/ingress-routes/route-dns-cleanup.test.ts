import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every upstream write the route-DNS paths make goes through these mocks, so a
// test can list exactly which values were withdrawn and which were written.
const deletes: string[] = [];
const provisions: string[] = [];
let staleRows: Array<{ id: string; recordType: string; recordName: string | null; recordValue: string | null }> = [];
let sharedValues = new Set<string>();

let refusedValue: string | null = null;
let unreachable = false;
const TIMED_OUT = 'timed out connecting to ns1.example.test:8081 — the packets are being dropped rather than refused, which usually means a firewall or a missing route';

vi.mock('../dns-records/service.js', () => ({
  syncRecordToProviders: vi.fn(async (_db, _zone, action, record) => {
    if (action === 'delete') deletes.push(`${record.type} ${record.name} ${record.content}`);
    if (action === 'delete' && unreachable) {
      return { status: 'failed', errors: [{ server: 'ns1', message: TIMED_OUT }] };
    }
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

import { autoDeleteRouteDns, deleteRoute } from './service.js';
import { updateRedirectSettings } from './settings-service.js';
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

interface RouteFixture { id?: string; domainId?: string; hostname: string; path?: string; wwwRedirect?: string }

function fakeDb(fixture: { settings: Record<string, string>; records?: unknown[]; routes?: RouteFixture[] }) {
  const deletedRows = vi.fn();
  // Routes are stateful: deleteRoute removes its row before cleaning DNS up,
  // and the "is the name still served?" check must not see the deleted route.
  let routes = [...(fixture.routes ?? [])];
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
          if (table === ingressRoutes) {
            const params = paramsOf(cond);
            return routes.filter((r) => !r.id || params.includes(r.id) || params.includes(r.domainId));
          }
          return [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Partial<RouteFixture>) => ({
        where: async (cond: unknown) => {
          if (table !== ingressRoutes) return;
          const params = paramsOf(cond);
          routes = routes.map((r) => (params.includes(r.id) ? { ...r, ...values } : r));
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (cond: unknown) => {
        if (table === ingressRoutes) {
          const params = paramsOf(cond);
          routes = routes.filter((r) => !params.includes(r.id));
          return;
        }
        deletedRows(cond);
      },
    }),
  };
  return { db: db as never, deletedRows };
}

beforeEach(() => {
  deletes.length = 0;
  provisions.length = 0;
  staleRows = [];
  sharedValues = new Set();
  refusedValue = null;
  unreachable = false;
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

    const cleanup = await autoDeleteRouteDns(db, 'd1', 'shop.example.test');

    expect(deletes.sort()).toEqual(['A shop 198.51.100.7', 'A shop 203.0.113.1']);
    expect(deletedRows).toHaveBeenCalledTimes(2); // the two A rows, never the TXT
    expect(cleanup).toEqual({ status: 'removed' });
  });

  const twoAddresses = [
    { id: 'r1', recordType: 'A', recordName: 'shop', recordValue: '203.0.113.1' },
    { id: 'r2', recordType: 'AAAA', recordName: 'shop', recordValue: '2001:db8::1' },
  ];

  it('keeps the row of a value the server would not withdraw, and says so', async () => {
    refusedValue = '2001:db8::1';
    const { db, deletedRows } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1', ingress_default_ipv6: '2001:db8::1' },
      records: twoAddresses,
    });

    const cleanup = await autoDeleteRouteDns(db, 'd1', 'shop.example.test');

    expect(deletes.sort()).toEqual(['A shop 203.0.113.1', 'AAAA shop 2001:db8::1']);
    // Only the withdrawn A row goes; the AAAA row stays listed so it can be deleted later.
    expect(deletedRows).toHaveBeenCalledTimes(1);
    expect(cleanup).toEqual({
      status: 'failed',
      reason: "1 of 2 record(s) for 'shop.example.test' are still published — PowerDNS API error: 500",
    });
  });

  it('stops at a server that cannot be reached instead of waiting out its timeout once per value', async () => {
    unreachable = true;
    const { db, deletedRows } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1', ingress_default_ipv6: '2001:db8::1' },
      records: twoAddresses,
    });

    const cleanup = await autoDeleteRouteDns(db, 'd1', 'shop.example.test');

    expect(deletes).toHaveLength(1);
    expect(deletedRows).not.toHaveBeenCalled();
    expect(cleanup).toEqual({
      status: 'failed',
      reason: `2 of 2 record(s) for 'shop.example.test' are still published — ${TIMED_OUT}`,
    });
  });

  it('a server that answers with an error is still asked about the other values', async () => {
    refusedValue = '203.0.113.1';
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1', ingress_default_ipv6: '2001:db8::1' },
      records: twoAddresses,
    });

    await autoDeleteRouteDns(db, 'd1', 'shop.example.test');

    expect(deletes.sort()).toEqual(['A shop 203.0.113.1', 'AAAA shop 2001:db8::1']);
  });
});

describe('deleteRoute reports DNS it could not withdraw', () => {
  const routeFixture = (extra: Partial<RouteFixture> = {}): RouteFixture =>
    ({ id: 'apex', domainId: 'd1', hostname: 'example.test', path: '/', wwwRedirect: 'none', ...extra });

  it('returns no leftovers when everything was withdrawn', async () => {
    const { db } = fakeDb({ settings: { ingress_default_ipv4: '203.0.113.1' }, routes: [routeFixture()] });
    expect(await deleteRoute(db, 'apex')).toEqual({ dnsLeftovers: null });
  });

  it('names the route and its www companion when the server is unreachable', async () => {
    unreachable = true;
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      routes: [routeFixture({ wwwRedirect: 'add-www' })],
    });

    const { dnsLeftovers } = await deleteRoute(db, 'apex');

    expect(dnsLeftovers?.hostnames).toEqual(['example.test', 'www.example.test']);
    expect(dnsLeftovers?.reason).toContain('timed out connecting to ns1.example.test:8081');
  });
});

describe('a name another route still serves keeps its DNS', () => {
  const addressRows = [
    { id: 'r1', recordType: 'A', recordName: 'shop', recordValue: '203.0.113.1' },
  ];
  const route = (id: string, hostname: string, extra: Partial<RouteFixture> = {}): RouteFixture =>
    ({ id, domainId: 'd1', hostname, path: '/', wwwRedirect: 'none', ...extra });

  it('deleting /api keeps the records / on the same hostname still resolves through', async () => {
    const { db, deletedRows } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      records: addressRows,
      routes: [route('root', 'shop.example.test'), route('api', 'shop.example.test', { path: '/api' })],
    });

    await deleteRoute(db, 'api');

    expect(deletes).toEqual([]);
    expect(deletedRows).not.toHaveBeenCalled();
  });

  it('deleting the last route on the name removes its records', async () => {
    const { db, deletedRows } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      records: addressRows,
      routes: [route('api', 'shop.example.test', { path: '/api' }), route('blog', 'blog.example.test')],
    });

    await deleteRoute(db, 'api');

    expect(deletes).toEqual(['A shop 203.0.113.1']);
    expect(deletedRows).toHaveBeenCalledTimes(1);
  });

  it('matches the name case-insensitively', async () => {
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      records: addressRows,
      routes: [route('root', 'Shop.Example.TEST')],
    });

    await autoDeleteRouteDns(db, 'd1', 'shop.example.test');

    expect(deletes).toEqual([]);
  });

  it("keeps www while it is another route's www companion", async () => {
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      records: [{ id: 'w1', recordType: 'A', recordName: 'www', recordValue: '203.0.113.1' }],
      routes: [route('apex', 'example.test', { wwwRedirect: 'add-www' }), route('www', 'www.example.test')],
    });

    await deleteRoute(db, 'www');

    expect(deletes).toEqual([]);
  });

  it('switching Add www off keeps www while www is a route of its own', async () => {
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      records: [{ id: 'w1', recordType: 'A', recordName: 'www', recordValue: '203.0.113.1' }],
      routes: [route('apex', 'example.test', { wwwRedirect: 'add-www' }), route('www', 'www.example.test')],
    });

    await updateRedirectSettings(db, 'apex', 't1', { www_redirect: 'none' });

    expect(deletes).toEqual([]);
  });

  it('switching Add www off removes www when nothing else serves it', async () => {
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      records: [{ id: 'w1', recordType: 'A', recordName: 'www', recordValue: '203.0.113.1' }],
      routes: [route('apex', 'example.test', { wwwRedirect: 'add-www' })],
    });

    await updateRedirectSettings(db, 'apex', 't1', { www_redirect: 'none' });

    expect(deletes).toEqual(['A www 203.0.113.1']);
  });

  it("a route's own www companion goes with it when nothing else serves www", async () => {
    const { db } = fakeDb({
      settings: { ingress_default_ipv4: '203.0.113.1' },
      records: [{ id: 'a1', recordType: 'A', recordName: '@', recordValue: '203.0.113.1' }],
      routes: [route('apex', 'example.test', { wwwRedirect: 'add-www' })],
    });

    await deleteRoute(db, 'apex');

    // One delete per name: the apex and its companion (the fake returns the
    // same rows for both lookups, so only the names matter here).
    expect(deletes).toEqual(['A @ 203.0.113.1', 'A www 203.0.113.1']);
  });
});

// refreshRouteDnsForDomain is the shared route-DNS reconcile now — covered in
// dns-apex-drift/detector.test.ts and route-dns.integration.test.ts.
