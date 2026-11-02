/**
 * An entry its catalog repository stops listing, on real Postgres and through a
 * real sync: the repository is a local HTTP catalog (the per-file source path),
 * so catalog.json and the manifests are read exactly as from any HTTP repo.
 *
 * The removed entry stays in the table (deployments made from it keep working),
 * is hidden from tenants, is refused for new deploys, and returns when the
 * repository lists it again. A sync that could not read every listed manifest,
 * or a catalog.json that lists nothing, withdraws nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closeTestDb, cleanTables, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { catalogEntries, catalogRepositories } from '../../db/schema.js';
import { getCatalogEntryByCode, listCatalogEntries, markEntriesRemovedFromSource, syncCatalogRepo } from './service.js';
import { createDeployment } from '../deployments/service.js';

const dbAvailable = await isDbAvailable();

/** A manifest that passes every sync validation. */
const manifest = (code: string) => ({
  name: `Entry ${code}`,
  code,
  type: 'service',
  version: '1.0',
  category: 'service',
  image: `example.test/${code}:1.0`,
  components: [{ name: code, type: 'deployment', image: `example.test/${code}:1.0`, ports: [{ port: 8080, protocol: 'tcp' }] }],
  volumes: [],
});

describe.skipIf(!dbAvailable)('catalog entries removed from their repository (integration)', () => {
  const db = () => getTestDb();
  // What the fake repository serves: catalog.json plus `<code>/manifest.json`.
  let listed: string[] = [];
  let unreadable = new Set<string>();
  let server: Server;
  let baseUrl = '';
  let repoId = '';

  beforeAll(async () => {
    await runMigrations();
    server = createServer((req, res) => {
      // An HTTP source is read as `<url>/<path>`, with no branch in it.
      const path = (req.url ?? '').replace(/^\//, '');
      const send = (body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (path === 'catalog.json') return send({ entries: listed });
      const m = path.match(/^([a-z0-9-]+)\/manifest\.json$/);
      if (m && !unreadable.has(m[1])) return send(manifest(m[1]));
      res.writeHead(m ? 500 : 404); res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb();
  });
  beforeEach(async () => {
    await cleanTables();
    listed = [];
    unreadable = new Set();
    repoId = randomUUID();
    await db().insert(catalogRepositories).values({ id: repoId, name: 'Fake repo', url: baseUrl, branch: 'main', status: 'active' });
  });

  const entry = async (code: string) => {
    const [row] = await db().select().from(catalogEntries).where(eq(catalogEntries.code, code));
    return row;
  };
  // The tenant view of the catalog, and the admin view (which also shows disabled and removed entries).
  const listCodes = async (includeDisabled: boolean) => (await listCatalogEntries(db(), {
    limit: 100, sort: { field: 'createdAt', direction: 'asc' }, includeDisabled,
  })).data.map((e) => e.code).sort();
  const tenantCodes = () => listCodes(false);
  const adminCodes = () => listCodes(true);

  it('marks an entry the repository stops listing, hides it from tenants only, and keeps the row', async () => {
    listed = ['alpha', 'beta'];
    const first = await syncCatalogRepo(db(), repoId);
    expect(first.synced).toBe(2);
    expect(first.removed).toEqual([]);

    listed = ['alpha'];
    const second = await syncCatalogRepo(db(), repoId);
    expect(second.removed).toEqual(['beta']);
    expect(second.message).toContain('no longer listed, hidden from tenants: beta');

    const beta = await entry('beta');
    expect(beta).toBeDefined();
    expect(beta.removedFromSourceAt).toBeInstanceOf(Date);
    expect((await entry('alpha')).removedFromSourceAt).toBeNull();
    expect(await tenantCodes()).toEqual(['alpha']);
    expect(await adminCodes()).toEqual(['alpha', 'beta']);
  });

  it('keeps the first removal time on later syncs and clears it when the repository lists the entry again', async () => {
    listed = ['alpha', 'beta'];
    await syncCatalogRepo(db(), repoId);
    listed = ['alpha'];
    await syncCatalogRepo(db(), repoId);
    const removedAt = (await entry('beta')).removedFromSourceAt;

    const again = await syncCatalogRepo(db(), repoId);
    expect(again.removed).toEqual([]);
    expect((await entry('beta')).removedFromSourceAt).toEqual(removedAt);

    listed = ['alpha', 'beta'];
    await syncCatalogRepo(db(), repoId);
    expect((await entry('beta')).removedFromSourceAt).toBeNull();
    expect(await tenantCodes()).toEqual(['alpha', 'beta']);
  });

  it('withdraws nothing when a listed manifest cannot be read', async () => {
    listed = ['alpha', 'beta'];
    await syncCatalogRepo(db(), repoId);

    // beta is gone from catalog.json, but alpha's manifest fails to load: this
    // sync cannot know every stored code the repository still lists.
    listed = ['alpha'];
    unreadable = new Set(['alpha']);
    const result = await syncCatalogRepo(db(), repoId);
    expect(result.removed).toEqual([]);
    expect((await entry('beta')).removedFromSourceAt).toBeNull();
    expect(await tenantCodes()).toEqual(['alpha', 'beta']);
  });

  it('withdraws nothing when catalog.json lists no entries', async () => {
    listed = ['alpha', 'beta'];
    await syncCatalogRepo(db(), repoId);
    listed = [];
    const result = await syncCatalogRepo(db(), repoId);
    expect(result.removed).toEqual([]);
    expect(await tenantCodes()).toEqual(['alpha', 'beta']);
  });

  it("only marks the syncing repository's own entries", async () => {
    listed = ['alpha'];
    await syncCatalogRepo(db(), repoId);
    const otherRepo = randomUUID();
    await db().insert(catalogRepositories).values({ id: otherRepo, name: 'Other', url: 'http://example.test/other', branch: 'main', status: 'active' });
    await db().insert(catalogEntries).values({ id: randomUUID(), code: 'gamma', name: 'Gamma', type: 'service', sourceRepoId: otherRepo });

    expect(await markEntriesRemovedFromSource(db(), repoId, ['alpha'], new Date())).toEqual([]);
    expect((await entry('gamma')).removedFromSourceAt).toBeNull();
  });

  it('leaves alone a row another sync wrote after this one started', async () => {
    listed = ['alpha', 'beta'];
    const startedBefore = new Date(Date.now() - 60_000);
    await syncCatalogRepo(db(), repoId);
    // A sync that started a minute ago, from a catalog.json without beta, ends
    // after the newer sync above listed beta: beta stays.
    expect(await markEntriesRemovedFromSource(db(), repoId, ['alpha'], startedBefore)).toEqual([]);
    expect((await entry('beta')).removedFromSourceAt).toBeNull();
    // The same mark from a sync that started after beta was written does withdraw it.
    expect(await markEntriesRemovedFromSource(db(), repoId, ['alpha'], new Date(Date.now() + 1000))).toEqual(['beta']);
  });

  it('looks a shared code up as the copy that can still be deployed', async () => {
    listed = ['alpha'];
    await syncCatalogRepo(db(), repoId);
    const otherRepo = randomUUID();
    await db().insert(catalogRepositories).values({ id: otherRepo, name: 'Other', url: 'http://example.test/other', branch: 'main', status: 'active' });
    // The older copy, in this repository, is about to be removed; the newer one in another repository is listed.
    await db().insert(catalogEntries).values({ id: randomUUID(), code: 'alpha', name: 'Alpha elsewhere', type: 'service', sourceRepoId: otherRepo });
    expect((await getCatalogEntryByCode(db(), 'alpha')).sourceRepoId).toBe(repoId);

    listed = ['beta'];
    await syncCatalogRepo(db(), repoId);
    expect((await getCatalogEntryByCode(db(), 'alpha')).sourceRepoId).toBe(otherRepo);
  });

  it('refuses a new deploy from a removed entry with CATALOG_ENTRY_REMOVED', async () => {
    listed = ['alpha', 'beta'];
    await syncCatalogRepo(db(), repoId);
    listed = ['alpha'];
    await syncCatalogRepo(db(), repoId);

    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    const tenant = await seedTenant(db(), region.id, plan.id);
    const beta = await entry('beta');
    await expect(createDeployment(db(), tenant.id, { catalog_entry_id: beta.id, name: 'beta-app' } as Parameters<typeof createDeployment>[2], 'test-actor'))
      .rejects.toMatchObject({ code: 'CATALOG_ENTRY_REMOVED', status: 409 });
  });
});
