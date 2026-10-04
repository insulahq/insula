/**
 * Route DNS drift — scan and repair against REAL Postgres, with an in-memory
 * DNS server standing in for PowerDNS (the provider is the only fake).
 *
 * Covers what the operator asked the repair to get right: servers ADDED,
 * servers REMOVED, a server's ingress DISABLED, a server's address CHANGED —
 * on the apex, a subdomain, a wildcard and a www companion — and what it must
 * never do: touch a record it cannot attribute, remove a hand-made record or a
 * rebooting server's address, or withdraw old addresses at a name where the
 * new ones could not be added.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant, seedDomain } from '../../test-helpers/fixtures.js';
import { clusterNodes, dnsRecords, ingressRoutes, platformSettings } from '../../db/schema.js';
import { qualifyName } from '../dns-servers/wire-format.js';

// ── In-memory DNS server ────────────────────────────────────────────────────
interface Rec { id: string; name: string; type: string; content: string; ttl: number }
const zone: Rec[] = [];
/** Set to make the server refuse one write — `name|content`. */
let refuseCreate: string | null = null;
const fakeProvider = {
  listRecords: async () => zone.map((r) => ({ ...r })),
  createRecord: async (z: string, input: { name: string; type: string; content: string; ttl?: number }) => {
    const name = qualifyName(z, input.name);
    if (refuseCreate === `${name}|${input.content}`) throw new Error('provider refused the write');
    const dup = zone.find((r) => r.name === name && r.type === input.type.toUpperCase() && r.content === input.content);
    if (dup) return dup;
    const rec = { id: randomUUID(), name, type: input.type.toUpperCase(), content: input.content, ttl: input.ttl ?? 3600 };
    zone.push(rec);
    return rec;
  },
  deleteRecord: async (_z: string, id: string) => {
    const i = zone.findIndex((r) => r.id === id);
    if (i >= 0) zone.splice(i, 1);
  },
};
vi.mock('../dns-servers/service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../dns-servers/service.js')>();
  const server = { id: 'srv-1', providerType: 'powerdns', enabled: 1, role: 'primary', name: 'fake-pdns' };
  return {
    ...real,
    getActiveServersForDomain: async () => [server],
    getActiveServers: async () => [server],
    getProviderForServer: () => fakeProvider,
  };
});

const { scanApexDrift, getLastReport } = await import('./service.js');
const { loadIngressInventory } = await import('./inventory.js');
const { reconcileDomainRouteDns } = await import('./reconcile.js');
const { refreshRouteDnsForDomain } = await import('../ingress-routes/service.js');

const dbAvailable = await isDbAvailable();
const ZONE = 'example.test';

describe.skipIf(!dbAvailable)('route DNS drift — scan and repair (integration)', () => {
  const db = () => getTestDb();
  let domainId = '';

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    zone.length = 0;
    refuseCreate = null;
    await cleanTables();
    for (const t of ['dns_records', 'cluster_nodes', 'platform_settings']) await db().execute(sql.raw(`TRUNCATE TABLE ${t} CASCADE`));
    const regionId = (await seedRegion(db())).id;
    const planId = (await seedPlan(db())).id;
    const tenantId = (await seedTenant(db(), regionId, planId)).id;
    domainId = (await seedDomain(db(), tenantId, { domainName: ZONE, dnsMode: 'primary' })).id;
    const route = (hostname: string, isApex = 0, wwwRedirect?: string) => db().insert(ingressRoutes).values({
      id: randomUUID(), domainId, hostname, ingressCname: 'ingress.platform.test', isApex, status: 'active',
      ...(wwwRedirect ? { wwwRedirect } : {}),
    } as typeof ingressRoutes.$inferInsert);
    await route(ZONE, 1, 'add-www');           // apex + its www companion
    await route(`blog.${ZONE}`);
    await route(`*.sites.${ZONE}`);
  });

  const servers = async (rows: Array<{ name: string; ip: string; mode?: 'all' | 'none' }>) => {
    for (const r of rows) {
      await db().insert(clusterNodes).values({ name: r.name, role: 'server', publicIp: r.ip, ingressMode: r.mode ?? 'all' } as typeof clusterNodes.$inferInsert)
        .onConflictDoUpdate({ target: clusterNodes.name, set: { publicIp: r.ip, ingressMode: r.mode ?? 'all' } });
    }
  };
  const discovered = async (ips: string[]) => {
    await db().insert(platformSettings).values({ key: 'ingress_discovered_ipv4', value: ips.join(',') })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: ips.join(',') } });
  };
  const publish = (name: string, content: string) => fakeProvider.createRecord(ZONE, { name, type: 'A', content });
  const at = (host: string) => zone.filter((r) => r.type === 'A' && r.name === qualifyName(ZONE, host)).map((r) => r.content).sort();
  const repair = async () => reconcileDomainRouteDns(db(), domainId, await loadIngressInventory(db(), null));

  it('ADDED server: every route name gets its address; the repair adds exactly those', async () => {
    await servers([{ name: 'sv1', ip: '203.0.113.1' }]);
    await discovered(['203.0.113.1']);
    for (const h of [ZONE, `www.${ZONE}`, `blog.${ZONE}`, `*.sites.${ZONE}`]) await publish(h, '203.0.113.1');

    await servers([{ name: 'sv2', ip: '203.0.113.2' }]);
    await discovered(['203.0.113.1', '203.0.113.2']);
    const report = await scanApexDrift(db(), { trigger: 'manual', k8s: null });
    const d = report.domains[0];
    expect(d.hostnames.map((h) => h.hostname)).toEqual([`*.sites.${ZONE}`, `blog.${ZONE}`, ZONE, `www.${ZONE}`]);
    expect(d.missingCount).toBe(4);
    expect(d.hostnames.every((h) => h.missing.length === 1 && h.missing[0].servers[0] === 'sv2')).toBe(true);
    expect(report.driftCount).toBe(1);

    const { result } = await repair();
    expect(result.added).toHaveLength(4);
    expect(result.removed).toEqual([]);
    for (const h of [ZONE, `www.${ZONE}`, `blog.${ZONE}`, `*.sites.${ZONE}`]) expect(at(h)).toEqual(['203.0.113.1', '203.0.113.2']);
    // The panel's DNS list matches the zone: one ingress-route row per name and address.
    const rows = await db().select().from(dnsRecords).where(and(eq(dnsRecords.domainId, domainId), eq(dnsRecords.managedBy, 'ingress-route')));
    expect(rows).toHaveLength(8);

    expect((await scanApexDrift(db(), { trigger: 'manual', k8s: null })).driftCount).toBe(0);
  });

  it('REMOVED server: its records are withdrawn and its rows dropped, attributed by address history', async () => {
    await servers([{ name: 'sv1', ip: '203.0.113.1' }, { name: 'sv-old', ip: '203.0.113.9' }]);
    await discovered(['203.0.113.1', '203.0.113.9']);
    await loadIngressInventory(db(), null); // the platform has seen sv-old's address
    await repair();
    expect(at(ZONE)).toEqual(['203.0.113.1', '203.0.113.9']);

    // The admin removes sv-old: its inventory row is deleted outright.
    await db().delete(clusterNodes).where(eq(clusterNodes.name, 'sv-old'));
    await discovered(['203.0.113.1']);
    // History keeps who 203.0.113.9 belonged to (written by the node reconciler in production).
    await db().insert(platformSettings).values({ key: 'ingress_address_history', value: JSON.stringify({ 'A|203.0.113.9': { server: 'sv-old', lastSeenAt: new Date().toISOString() } }) })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: JSON.stringify({ 'A|203.0.113.9': { server: 'sv-old', lastSeenAt: new Date().toISOString() } }) } });

    const report = await scanApexDrift(db(), { trigger: 'manual', k8s: null });
    const apex = report.domains[0].hostnames.find((h) => h.hostname === ZONE)!;
    expect(apex.stale).toEqual([{ type: 'A', content: '203.0.113.9', servers: ['sv-old'], reason: 'server-removed' }]);
    expect(report.servers.find((s) => s.name === 'sv-old')?.status).toBe('removed');

    const { result } = await repair();
    expect(result.removed).toHaveLength(4);
    for (const h of [ZONE, `www.${ZONE}`, `blog.${ZONE}`, `*.sites.${ZONE}`]) expect(at(h)).toEqual(['203.0.113.1']);
    const leftover = await db().select().from(dnsRecords).where(and(eq(dnsRecords.domainId, domainId), eq(dnsRecords.recordValue, '203.0.113.9')));
    expect(leftover).toEqual([]);
  });

  it('INGRESS DISABLED on a server: its address is stale with that reason, and comes back when re-enabled', async () => {
    await servers([{ name: 'sv1', ip: '203.0.113.1' }, { name: 'sv2', ip: '203.0.113.2' }]);
    await discovered(['203.0.113.1', '203.0.113.2']);
    await repair();

    await servers([{ name: 'sv2', ip: '203.0.113.2', mode: 'none' }]);
    await discovered(['203.0.113.1']);
    const stale = (await scanApexDrift(db(), { trigger: 'manual', k8s: null })).domains[0].hostnames[0].stale;
    expect(stale).toEqual([{ type: 'A', content: '203.0.113.2', servers: ['sv2'], reason: 'ingress-disabled' }]);
    await repair();
    expect(at(`blog.${ZONE}`)).toEqual(['203.0.113.1']);

    await servers([{ name: 'sv2', ip: '203.0.113.2', mode: 'all' }]);
    await discovered(['203.0.113.1', '203.0.113.2']);
    const { result } = await repair();
    expect(result.added.filter((a) => a.servers.includes('sv2'))).toHaveLength(4);
    expect(at(`blog.${ZONE}`)).toEqual(['203.0.113.1', '203.0.113.2']);
  });

  it('CHANGED address: the new one is added and the old one withdrawn in one repair', async () => {
    await servers([{ name: 'sv1', ip: '203.0.113.1' }]);
    await discovered(['203.0.113.1']);
    await loadIngressInventory(db(), null);
    await db().insert(platformSettings).values({ key: 'ingress_address_history', value: JSON.stringify({ 'A|203.0.113.1': { server: 'sv1', lastSeenAt: new Date().toISOString() } }) })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: JSON.stringify({ 'A|203.0.113.1': { server: 'sv1', lastSeenAt: new Date().toISOString() } }) } });
    await repair();

    await servers([{ name: 'sv1', ip: '203.0.113.11' }]);
    await discovered(['203.0.113.11']);
    const { result } = await repair();
    expect(result.added.map((a) => a.content)).toEqual(Array(4).fill('203.0.113.11'));
    expect(result.removed.map((r) => [r.content, r.servers, r.reason])).toEqual(Array(4).fill(['203.0.113.1', ['sv1'], 'no-longer-ingress']));
    expect(at(ZONE)).toEqual(['203.0.113.11']);
  });

  it('a FOREIGN record is reported and left alone; a record the platform created is not foreign', async () => {
    await servers([{ name: 'sv1', ip: '203.0.113.1' }]);
    await discovered(['203.0.113.1']);
    await publish(`blog.${ZONE}`, '198.51.100.7'); // the tenant's own record, unknown address
    await publish(ZONE, '192.0.2.44');               // created by the platform earlier, address unknown
    await db().insert(dnsRecords).values({ id: randomUUID(), domainId, recordType: 'A', recordName: '@', recordValue: '192.0.2.44', ttl: 300, managedBy: 'apex-drift' } as typeof dnsRecords.$inferInsert);

    const d = (await scanApexDrift(db(), { trigger: 'manual', k8s: null })).domains[0];
    expect(d.hostnames.find((h) => h.hostname === `blog.${ZONE}`)!.foreign).toEqual([{ type: 'A', content: '198.51.100.7' }]);
    expect(d.hostnames.find((h) => h.hostname === ZONE)!.stale.map((s) => s.reason)).toEqual(['platform-created']);

    await repair();
    expect(at(`blog.${ZONE}`)).toEqual(['198.51.100.7', '203.0.113.1']);
    expect(at(ZONE)).toEqual(['203.0.113.1']);
    expect((await scanApexDrift(db(), { trigger: 'manual', k8s: null })).foreignCount).toBe(1);
  });

  it('NOT READY server (a reboot): its address is HELD, not removed — and stale once the server is gone', async () => {
    const node = (name: string, ip: string, ready: boolean) => ({
      metadata: { name, labels: {} },
      status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], addresses: [{ type: 'ExternalIP', address: ip }] },
    });
    const k8sWith = (items: unknown[]) => ({ core: { listNode: async () => ({ items }) } }) as unknown as Parameters<typeof loadIngressInventory>[1];
    const repairWith = async (items: unknown[]) => reconcileDomainRouteDns(db(), domainId, await loadIngressInventory(db(), k8sWith(items)));

    await repairWith([node('sv1', '203.0.113.1', true), node('sv2', '203.0.113.2', true)]);
    expect(at(ZONE)).toEqual(['203.0.113.1', '203.0.113.2']);

    // sv2 reboots: no longer Ready, so it drops out of the expected set …
    const rebooting = [node('sv1', '203.0.113.1', true), node('sv2', '203.0.113.2', false)];
    const report = await scanApexDrift(db(), { trigger: 'manual', k8s: k8sWith(rebooting) });
    const apex = report.domains[0].hostnames.find((h) => h.hostname === ZONE)!;
    expect(apex.held).toEqual([{ type: 'A', content: '203.0.113.2', servers: ['sv2'], reason: 'server-not-ready' }]);
    expect(apex.stale).toEqual([]);
    expect(report.driftCount).toBe(0); // nothing to fix, so no tile
    expect(report.heldCount).toBe(4);
    // … and a repair (or "Refresh route DNS") clicked meanwhile keeps its records.
    const { result } = await repairWith(rebooting);
    expect(result.removed).toEqual([]);
    expect(at(`blog.${ZONE}`)).toEqual(['203.0.113.1', '203.0.113.2']);

    // It never comes back and is removed from the cluster: now it is stale.
    const gone = await scanApexDrift(db(), { trigger: 'manual', k8s: k8sWith([node('sv1', '203.0.113.1', true)]) });
    expect(gone.domains[0].hostnames[0].stale.map((r) => [r.content, r.reason])).toEqual([['203.0.113.2', 'server-removed']]);
    expect(gone.servers.map((s) => [s.name, s.status])).toEqual([['sv1', 'ingress'], ['sv2', 'removed']]);
    await repairWith([node('sv1', '203.0.113.1', true)]);
    expect(at(`blog.${ZONE}`)).toEqual(['203.0.113.1']);
    // Once nothing points at it, the removed server leaves the report.
    expect((await scanApexDrift(db(), { trigger: 'manual', k8s: k8sWith([node('sv1', '203.0.113.1', true)]) })).servers.map((s) => s.name)).toEqual(['sv1']);
  });

  it('a HAND-MADE record keeps its address even when it is a removed server\'s — row and record both stay', async () => {
    await servers([{ name: 'sv1', ip: '203.0.113.1' }]);
    await discovered(['203.0.113.1']);
    const history = JSON.stringify({ 'A|203.0.113.9': { server: 'sv-old', lastSeenAt: new Date().toISOString() } });
    await db().insert(platformSettings).values({ key: 'ingress_address_history', value: history })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: history } });
    for (const h of [ZONE, `www.${ZONE}`, `blog.${ZONE}`, `*.sites.${ZONE}`]) await publish(h, '203.0.113.9');
    // The operator deliberately keeps blog on the old machine (managed_by NULL = hand-made).
    const manualId = randomUUID();
    await db().insert(dnsRecords).values({ id: manualId, domainId, recordType: 'A', recordName: 'blog', recordValue: '203.0.113.9', ttl: 300 } as typeof dnsRecords.$inferInsert);

    const d = (await scanApexDrift(db(), { trigger: 'manual', k8s: null })).domains[0];
    expect(d.hostnames.find((h) => h.hostname === `blog.${ZONE}`)!.held).toEqual([{ type: 'A', content: '203.0.113.9', servers: ['sv-old'], reason: 'manual-record' }]);
    expect(d.staleCount).toBe(3);

    const { result } = await repair();
    expect(result.removed.map((r) => r.hostname).sort()).toEqual([`*.sites.${ZONE}`, ZONE, `www.${ZONE}`]);
    expect(at(`blog.${ZONE}`)).toEqual(['203.0.113.1', '203.0.113.9']);
    expect(at(ZONE)).toEqual(['203.0.113.1']);
    expect(await db().select().from(dnsRecords).where(eq(dnsRecords.id, manualId))).toHaveLength(1);
  });

  it('an ADD that fails keeps the old address at that name — a name is never left resolving to nothing', async () => {
    await servers([{ name: 'sv1', ip: '203.0.113.1' }]);
    await discovered(['203.0.113.1']);
    await loadIngressInventory(db(), null);
    const history = JSON.stringify({ 'A|203.0.113.1': { server: 'sv1', lastSeenAt: new Date().toISOString() } });
    await db().insert(platformSettings).values({ key: 'ingress_address_history', value: history })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: history } });
    await repair();

    // sv1 is renumbered, and the DNS server refuses the new address at blog only.
    await servers([{ name: 'sv1', ip: '203.0.113.11' }]);
    await discovered(['203.0.113.11']);
    refuseCreate = `${qualifyName(ZONE, `blog.${ZONE}`)}|203.0.113.11`;
    const { result } = await repair();

    expect(at(`blog.${ZONE}`)).toEqual(['203.0.113.1']); // old address kept: blog still resolves
    expect(result.failures.map((f) => f.hostname)).toEqual([`blog.${ZONE}`, `blog.${ZONE}`]);
    expect(result.failures[1].detail).toMatch(/A 203\.0\.113\.1 kept: the new addresses could not be added first/);
    // Every other name was switched over.
    expect(at(ZONE)).toEqual(['203.0.113.11']);
    expect(result.removed.map((r) => r.hostname).sort()).toEqual([`*.sites.${ZONE}`, ZONE, `www.${ZONE}`]);
  });

  it('"Refresh route DNS" is the same reconcile', async () => {
    await servers([{ name: 'sv1', ip: '203.0.113.1' }, { name: 'sv2', ip: '203.0.113.2' }]);
    await discovered(['203.0.113.1', '203.0.113.2']);
    const res = await refreshRouteDnsForDomain(db(), domainId);
    expect(res).toMatchObject({ hostnames: 4, created: 8, removed: 0, failures: [] });
    expect(await getLastReport(db())).toBeNull(); // refresh does not pretend to be a scan
  });

  it('refuses to repair when no ingress address is known — nothing is removed', async () => {
    await publish(ZONE, '203.0.113.1');
    await discovered([]);
    await db().delete(platformSettings).where(eq(platformSettings.key, 'ingress_discovered_ipv4'));
    process.env.INGRESS_DEFAULT_IPV4 ??= '';
    await expect(repair()).rejects.toThrow(/No ingress address is known/);
    expect(at(ZONE)).toEqual(['203.0.113.1']);
  });
});
