/**
 * The daily catalog sync on real Postgres: which repositories are due, and a
 * real sync of a local HTTP catalog through runCatalogAutoSync, a failing one
 * included.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { closeTestDb, cleanTables, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { catalogEntries, catalogRepositories, platformSettings } from '../../db/schema.js';
import { privateIPv4 } from '../../test-helpers/private-address.js';
import { AUTO_SYNC_EVERY_MS, STALE_SYNCING_MS, reposDueForAutoSync, runCatalogAutoSync } from './auto-sync.js';
import { createCatalogRepo, syncCatalogRepo, updateCatalogRepo } from './service.js';

const dbAvailable = await isDbAvailable();
// The fake repository is on this machine's private address: loopback is never fetched.
const lanIp = privateIPv4();
const HOUR = 60 * 60 * 1000;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!dbAvailable || !lanIp)('catalog auto-sync (integration)', () => {
  const db = () => getTestDb();
  let server: Server;
  let baseUrl = '';
  let listed: unknown[] = ['alpha'];
  let requested: string[] = [];

  beforeAll(async () => {
    await runMigrations();
    server = createServer((req, res) => {
      const path = (req.url ?? '').replace(/^\//, '');
      requested.push(req.url ?? '');
      const send = (body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (path === 'catalog.json') return send({ entries: listed });
      if (path === 'alpha/manifest.json') {
        return send({
          name: 'Entry alpha', code: 'alpha', type: 'service', version: '1.0', category: 'service',
          image: 'example.test/alpha:1.0',
          components: [{ name: 'alpha', type: 'deployment', image: 'example.test/alpha:1.0', ports: [{ port: 8080, protocol: 'tcp' }] }],
          volumes: [],
        });
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, lanIp!, resolve));
    baseUrl = `http://${lanIp}:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb();
  });
  // A real sync stamps the real time, so the tests judge against it.
  let now = new Date();
  const allowPrivate = (on: boolean) => db().insert(platformSettings).values({ key: 'catalog_repos_allow_private_hosts', value: String(on) })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: String(on) } });
  beforeEach(async () => { await cleanTables(); await allowPrivate(true); now = new Date(); listed = ['alpha']; requested = []; });

  const ago = (ms: number) => new Date(now.getTime() - ms);
  const repo = async (name: string, v: { auto?: boolean; synced?: Date | null; status?: 'active' | 'error' | 'syncing'; updated?: Date; url?: string }) => {
    const id = randomUUID();
    await db().insert(catalogRepositories).values({
      id, name, url: v.url ?? `${baseUrl}/${name}`, branch: 'main',
      autoSyncEnabled: v.auto ?? true, lastSyncedAt: v.synced ?? null, status: v.status ?? 'active',
      updatedAt: v.updated ?? ago(2 * HOUR),
    });
    return id;
  };

  it('is due when auto-sync is on and the last good sync is a day old or missing', async () => {
    await repo('never', { synced: null });
    await repo('fresh', { synced: ago(2 * HOUR) });
    await repo('day-old', { synced: ago(AUTO_SYNC_EVERY_MS) });
    await repo('off', { auto: false, synced: ago(3 * AUTO_SYNC_EVERY_MS) });
    await repo('failed', { synced: ago(2 * AUTO_SYNC_EVERY_MS), status: 'error' });
    await repo('busy', { synced: ago(2 * AUTO_SYNC_EVERY_MS), status: 'syncing', updated: ago(10 * 60 * 1000) });
    await repo('stuck', { synced: ago(2 * AUTO_SYNC_EVERY_MS), status: 'syncing', updated: ago(STALE_SYNCING_MS + 1000) });
    const due = (await reposDueForAutoSync(db(), now)).map((r) => r.name).sort();
    expect(due).toEqual(['day-old', 'failed', 'never', 'stuck']);
  });

  it('syncs a due repository, records a failing one, and tries the failing one again on the next tick', async () => {
    const good = await repo('good', { synced: ago(2 * AUTO_SYNC_EVERY_MS), url: baseUrl });
    const bad = await repo('bad', { synced: ago(2 * AUTO_SYNC_EVERY_MS), url: `${baseUrl}/missing` });
    await repo('off', { auto: false, synced: ago(2 * AUTO_SYNC_EVERY_MS), url: `${baseUrl}/missing-too` });

    const first = await runCatalogAutoSync(db(), quiet, now);
    expect(first).toEqual({ due: 2, synced: 1, failed: 1 });

    const [g] = await db().select().from(catalogRepositories).where(eq(catalogRepositories.id, good));
    expect(g.status).toBe('active');
    expect(g.lastSyncedAt!.getTime()).toBeGreaterThan(now.getTime() - AUTO_SYNC_EVERY_MS);
    expect((await db().select().from(catalogEntries).where(eq(catalogEntries.code, 'alpha'))).length).toBe(1);
    const [b] = await db().select().from(catalogRepositories).where(eq(catalogRepositories.id, bad));
    expect(b.status).toBe('error');
    expect(b.lastError).toBeTruthy();

    // An hour on: the good one is not due again for a day, the failed one is.
    const later = new Date(Date.now() + HOUR);
    expect((await reposDueForAutoSync(db(), later)).map((r) => r.id)).toEqual([bad]);
  });

  it('turning auto-sync off through the update takes the repository out of the daily sync', async () => {
    const id = await repo('toggled', { synced: ago(2 * AUTO_SYNC_EVERY_MS) });
    expect((await reposDueForAutoSync(db(), now)).map((r) => r.id)).toEqual([id]);
    const off = await updateCatalogRepo(db(), id, { auto_sync_enabled: false });
    expect(off.autoSyncEnabled).toBe(false);
    expect(await reposDueForAutoSync(db(), now)).toEqual([]);
    const on = await updateCatalogRepo(db(), id, { auto_sync_enabled: true });
    expect(on.autoSyncEnabled).toBe(true);
  });

  it('an HTTP catalog fetches only valid entry codes and leaves no directory behind', async () => {
    listed = ['alpha', '../../escape', 'Bad_Code'];
    const id = await repo('http', { url: baseUrl });
    const left = async () => (await readdir(tmpdir())).filter((n) => n.startsWith('catalog-http-')).length;
    const before = await left();
    const result = await syncCatalogRepo(db(), id);
    expect(result.synced).toBe(1);
    expect(result.errors.join(' ')).toContain('Invalid entry code: "../../escape"');
    expect(requested.filter((u) => u.includes('escape') || u.includes('Bad_Code'))).toEqual([]);
    await syncCatalogRepo(db(), id);
    expect(await left()).toBe(before);
    const [row] = await db().select().from(catalogRepositories).where(eq(catalogRepositories.id, id));
    expect(row.localCachePath).toBe(`${tmpdir()}/catalog-cache-${id}`);
  });

  it('refuses a repository on a private address while that is not allowed, and loopback always', async () => {
    const id = await repo('lan', { url: baseUrl });
    await allowPrivate(false);
    await expect(syncCatalogRepo(db(), id)).rejects.toMatchObject({ code: 'CATALOG_URL_REFUSED' });
    const [row] = await db().select().from(catalogRepositories).where(eq(catalogRepositories.id, id));
    expect(row.status).toBe('error');
    expect(row.lastError).toContain('Allow repositories on private networks');
    expect(requested).toEqual([]);

    await allowPrivate(true);
    const port = (server.address() as AddressInfo).port;
    const lo = await repo('loopback', { url: `http://127.0.0.1:${port}` });
    await expect(syncCatalogRepo(db(), lo)).rejects.toMatchObject({ code: 'CATALOG_URL_REFUSED' });
    expect(requested).toEqual([]);
  });

  it('a repository someone adds starts with auto-sync off unless they ask for it', async () => {
    const off = await createCatalogRepo(db(), { name: 'mine', url: baseUrl, branch: 'main' });
    expect(off.autoSyncEnabled).toBe(false);
    const on = await createCatalogRepo(db(), { name: 'mine-too', url: `${baseUrl}/`, branch: 'main', auto_sync_enabled: true });
    expect(on.autoSyncEnabled).toBe(true);
  });
});
