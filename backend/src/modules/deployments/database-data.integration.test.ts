/**
 * Moving a standalone database's data (R48), against real Postgres and the
 * real folder script on a temporary directory standing in for the volume. The
 * file-manager pod is replaced by running the script locally; pods and the
 * stop/redeploy of an instance are fakes whose calls are checked.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { cleanTables, closeTestDb, getTestDb, isDbAvailable, runMigrations } from '../../test-helpers/db.js';
import { seedPlan, seedRegion, seedTenant } from '../../test-helpers/fixtures.js';
import { catalogEntries, deployments } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { PlatformFilesRun } from './database-folders.js';

let root = '';
/** Set by a test to make an exec reject after it ran (a connection lost mid-move). */
let rejectAfter: ((op: string) => boolean) | null = null;
const realRun: PlatformFilesRun = (argv) => new Promise((resolve) => {
  const [, , script, ...rest] = argv;
  execFile('sh', ['-c', String(script).replace(/\/data(?![A-Za-z0-9_-])/g, root), ...rest], (err, stdout, stderr) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
    resolve({ stdout, stderr, exitCode: code });
  });
});

const localRun: PlatformFilesRun = async (argv) => {
  const r = await realRun(argv);
  if (rejectAfter?.(String(argv[4]))) throw new Error('exec: connection lost');
  return r;
};

vi.mock('./database-folders.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./database-folders.js')>()),
  withPlatformFiles: async <T>(_k: unknown, _c: unknown, _n: unknown, _p: unknown, fn: (run: PlatformFilesRun, pod: string) => Promise<T>) => fn(localRun, 'file-manager-0'),
}));
const notify = vi.fn(async () => undefined);
vi.mock('../notifications/events.js', () => ({ notifyAdminOperationalEvent: notify }));

const {
  adoptFolderForNewDatabase, attachDatabaseData, detachDatabaseData, listDatabaseFolders,
  refuseDetachedData, relocateDatabaseFolders, releaseDatabaseFolderOnDelete, releaseOrphanFolders,
} = await import('./database-data.js');

const dbAvailable = await isDbAvailable();
const p = (rel: string): string => join(root, rel);
const k8s = { core: { listNamespacedPod: vi.fn(async () => ({ items: [] })) } } as unknown as K8sClients;

describe.skipIf(!dbAvailable)('database data folders (integration)', () => {
  const db = () => getTestDb();
  let tenantId = '';
  let namespace = '';
  let dbEntry = '';
  let appEntry = '';
  const control = () => ({ stop: vi.fn(async () => undefined), redeploy: vi.fn(async () => undefined) });

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'r48-it-'));
    rejectAfter = null;
    notify.mockClear();
    await cleanTables();
    for (const t of ['deployments', 'catalog_entries']) await db().execute(sql.raw(`TRUNCATE TABLE ${t} CASCADE`));
    const tenant = await seedTenant(db(), (await seedRegion(db())).id, (await seedPlan(db())).id);
    tenantId = tenant.id;
    namespace = tenant.kubernetesNamespace ?? '';
    dbEntry = randomUUID();
    appEntry = randomUUID();
    await db().insert(catalogEntries).values([
      { id: dbEntry, code: 'mariadb', name: 'MariaDB', type: 'database' },
      { id: appEntry, code: 'php', name: 'PHP', type: 'runtime' },
    ] as Array<typeof catalogEntries.$inferInsert>);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  async function seedDb(name: string, storagePath: string | null, extra: Partial<typeof deployments.$inferInsert> = {}): Promise<string> {
    const id = randomUUID();
    await db().insert(deployments).values({
      id, tenantId, name, catalogEntryId: dbEntry, cpuRequest: '0.25', status: 'running', storagePath, ...extra,
    } as typeof deployments.$inferInsert);
    if (storagePath) {
      mkdirSync(p(storagePath), { recursive: true });
      writeFileSync(p(`${storagePath}/ibdata1`), name);
    }
    return id;
  }
  async function seedApp(name: string, storagePath: string, extraMounts: Array<{ folder: string; mount_path: string; read_only: boolean }> = []): Promise<void> {
    await db().insert(deployments).values({
      id: randomUUID(), tenantId, name, catalogEntryId: appEntry, cpuRequest: '0.25', status: 'running', storagePath, extraMounts,
    } as typeof deployments.$inferInsert);
  }
  const row = async (id: string) => (await db().select().from(deployments).where(eq(deployments.id, id)))[0]!;

  it('detaches: stops the instance and moves its data to kept-databases/<name>', async () => {
    const id = await seedDb('shop', 'database/mariadb/shop');
    const c = control();
    const r = await detachDatabaseData({ db: db(), k8s }, tenantId, id, c);
    expect(r).toEqual({ detachedPath: 'kept-databases/shop' });
    expect(c.stop).toHaveBeenCalledOnce();
    expect(readFileSync(p('kept-databases/shop/ibdata1'), 'utf8')).toBe('shop');
    expect(existsSync(p('database/mariadb/shop'))).toBe(false);
    const after = await row(id);
    expect(after.dataDetachedPath).toBe('kept-databases/shop');
    expect(after.status).toBe('stopped');
    await expect(detachDatabaseData({ db: db(), k8s }, tenantId, id, c)).rejects.toMatchObject({ code: 'DATABASE_DATA_DETACHED' });
    expect(() => refuseDetachedData(after, 'start')).toThrow(/Attach it before you start/);
  });

  it('attaches the detached folder back and redeploys the instance', async () => {
    const id = await seedDb('shop', 'database/mariadb/shop', { replicaCount: 1 });
    await detachDatabaseData({ db: db(), k8s }, tenantId, id, control());
    writeFileSync(p('kept-databases/shop/edited'), 'by the tenant');
    const c = control();
    expect(await attachDatabaseData({ db: db(), k8s }, tenantId, id, undefined, c)).toEqual({ storagePath: 'database/mariadb/shop' });
    expect(readFileSync(p('database/mariadb/shop/edited'), 'utf8')).toBe('by the tenant');
    expect(c.redeploy).toHaveBeenCalledWith(1);
    const after = await row(id);
    expect(after.dataDetachedPath).toBeNull();
    // Starting (and the 'pending' status) is the redeploy's — the service's control.
    expect(after.storagePath).toBe('database/mariadb/shop');
  });

  it('attaches another folder', async () => {
    const id = await seedDb('shop', 'database/mariadb/shop');
    await detachDatabaseData({ db: db(), k8s }, tenantId, id, control());
    mkdirSync(p('uploads/olddata/mysql'), { recursive: true });
    writeFileSync(p('uploads/olddata/mysql/global_priv.MAD'), 'grants');
    await attachDatabaseData({ db: db(), k8s }, tenantId, id, 'uploads/olddata', control());
    expect(readFileSync(p('database/mariadb/shop/mysql/global_priv.MAD'), 'utf8')).toBe('grants');
    expect(existsSync(p('kept-databases/shop'))).toBe(true);
  });

  it('refuses to attach a folder in use, a protected path, or onto attached data', async () => {
    const id = await seedDb('shop', 'database/mariadb/shop');
    await expect(attachDatabaseData({ db: db(), k8s }, tenantId, id, 'uploads/x', control())).rejects.toMatchObject({ code: 'DATABASE_DATA_ATTACHED' });
    await detachDatabaseData({ db: db(), k8s }, tenantId, id, control());
    await seedApp('site', 'runtime/php/site', [{ folder: 'uploads', mount_path: '/srv/uploads', read_only: false }]);
    mkdirSync(p('uploads/olddata'), { recursive: true });
    await expect(attachDatabaseData({ db: db(), k8s }, tenantId, id, 'uploads/olddata', control())).rejects.toMatchObject({ code: 'FOLDER_IN_USE' });
    await expect(attachDatabaseData({ db: db(), k8s }, tenantId, id, 'database/mariadb/other', control())).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(attachDatabaseData({ db: db(), k8s }, tenantId, id, 'runtime/php/site', control())).rejects.toMatchObject({ code: 'FOLDER_IN_USE' });
  });

  it('refuses to attach another instance\'s detached data, or the whole kept folder', async () => {
    const a = await seedDb('alpha', 'database/mariadb/alpha');
    const b = await seedDb('beta', 'database/mariadb/beta');
    await detachDatabaseData({ db: db(), k8s }, tenantId, a, control());
    await detachDatabaseData({ db: db(), k8s }, tenantId, b, control());
    await expect(attachDatabaseData({ db: db(), k8s }, tenantId, b, 'kept-databases/alpha', control())).rejects.toMatchObject({ code: 'FOLDER_IN_USE' });
    await expect(attachDatabaseData({ db: db(), k8s }, tenantId, b, 'kept-databases', control())).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('finishes an attach whose move landed before the row was updated', async () => {
    const id = await seedDb('half', 'database/mariadb/half');
    await detachDatabaseData({ db: db(), k8s }, tenantId, id, control());
    // The data went back, the row still says detached (a crash in between).
    rmSync(p('database/mariadb/half'), { recursive: true, force: true });
    mkdirSync(p('database/mariadb'), { recursive: true });
    const { renameSync } = await import('node:fs');
    renameSync(p('kept-databases/half'), p('database/mariadb/half'));
    const c = control();
    expect(await attachDatabaseData({ db: db(), k8s }, tenantId, id, undefined, c)).toEqual({ storagePath: 'database/mariadb/half' });
    expect((await row(id)).dataDetachedPath).toBeNull();
    expect(c.redeploy).toHaveBeenCalledWith(1);
  });

  it('refuses to attach a folder with hard-linked files, and moves nothing', async () => {
    const id = await seedDb('hlink', 'database/mariadb/hlink');
    await detachDatabaseData({ db: db(), k8s }, tenantId, id, control());
    mkdirSync(p('outside'));
    linkSync(p('kept-databases/hlink/ibdata1'), p('outside/second-name'));
    await expect(attachDatabaseData({ db: db(), k8s }, tenantId, id, undefined, control())).rejects.toMatchObject({ code: 'FOLDER_HAS_HARD_LINKS' });
    expect(existsSync(p('kept-databases/hlink/ibdata1'))).toBe(true);
    expect((await row(id)).dataDetachedPath).toBe('kept-databases/hlink');
  });

  it('a permanent delete finds data still in the instance\'s folder when its detach never moved it', async () => {
    const id = await seedDb('halfdel', 'database/mariadb/halfdel');
    await db().update(deployments).set({ dataDetachedPath: 'kept-databases/halfdel' }).where(eq(deployments.id, id));
    expect(await releaseDatabaseFolderOnDelete({ db: db(), k8s }, namespace, await row(id), 'keep')).toBe('kept-databases/halfdel');
    expect(readFileSync(p('kept-databases/halfdel/ibdata1'), 'utf8')).toBe('halfdel');
  });

  it('a detach whose move fails leaves the instance attached', async () => {
    const id = await seedDb('stuck', 'database/mariadb/stuck');
    rmSync(p('database/mariadb/stuck'), { recursive: true, force: true }); // nothing to move
    await expect(detachDatabaseData({ db: db(), k8s }, tenantId, id, control())).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect((await row(id)).dataDetachedPath).toBeNull();
  });

  it('removes detached data on a permanent delete with its data', async () => {
    const id = await seedDb('gonewithdata', 'database/mariadb/gonewithdata');
    await detachDatabaseData({ db: db(), k8s }, tenantId, id, control());
    const r = await row(id);
    expect(await releaseDatabaseFolderOnDelete({ db: db(), k8s }, namespace, r, 'remove')).toBeNull();
    expect(existsSync(p('kept-databases/gonewithdata'))).toBe(false);
  });

  it('cleans the configuration of an attached PostgreSQL folder before its start', async () => {
    const id = await seedDb('pgish', 'database/mariadb/pgish');
    await detachDatabaseData({ db: db(), k8s }, tenantId, id, control());
    mkdirSync(p('kept-databases/pgish/18/docker'), { recursive: true });
    writeFileSync(p('kept-databases/pgish/18/docker/postgresql.auto.conf'), "shared_preload_libraries = 'evil'\nwork_mem = '4MB'\n");
    await attachDatabaseData({ db: db(), k8s }, tenantId, id, undefined, control());
    expect(readFileSync(p('database/mariadb/pgish/18/docker/postgresql.auto.conf'), 'utf8')).toBe("work_mem = '4MB'\n");
  });

  it('refuses an app instance', async () => {
    const appId = randomUUID();
    await db().insert(deployments).values({ id: appId, tenantId, name: 'web', catalogEntryId: appEntry, cpuRequest: '0.25', status: 'running', storagePath: 'runtime/php/web' } as typeof deployments.$inferInsert);
    await expect(detachDatabaseData({ db: db(), k8s }, tenantId, appId, control())).rejects.toMatchObject({ code: 'NOT_A_DATABASE_INSTANCE' });
  });

  it('adopts a picked folder for a new instance, moving old data under that name aside', async () => {
    mkdirSync(p('database/mariadb/fresh'), { recursive: true });
    writeFileSync(p('database/mariadb/fresh/old'), 'left by a delete');
    mkdirSync(p('uploads/mydata'), { recursive: true });
    writeFileSync(p('uploads/mydata/ibdata1'), 'mine');
    expect(await adoptFolderForNewDatabase({ db: db(), k8s }, tenantId, namespace, 'uploads/mydata', 'database/mariadb/fresh')).toBe('adopted');
    expect(readFileSync(p('database/mariadb/fresh/ibdata1'), 'utf8')).toBe('mine');
    expect(readFileSync(p('kept-databases/fresh/old'), 'utf8')).toBe('left by a delete');
    expect(await adoptFolderForNewDatabase({ db: db(), k8s }, tenantId, namespace, 'uploads/none', 'database/mariadb/other')).toBe('empty');
  });

  it('lists the instances and the folders that belong to none, and changes nothing', async () => {
    await seedDb('shop', 'database/mariadb/shop');
    await seedDb('gone', 'database/mariadb/gone', { status: 'deleted', deletedAt: new Date() });
    mkdirSync(p('database/mariadb/orphan'), { recursive: true });
    writeFileSync(p('database/mariadb/orphan/ibdata1'), 'x');
    await seedApp('legacyapp', 'database/legacy/app');
    mkdirSync(p('database/legacy/app'), { recursive: true });
    const r = await listDatabaseFolders({ db: db(), k8s }, tenantId, namespace);
    expect(r.instances.map((i) => [i.name, i.status, i.folder])).toEqual([
      ['gone', 'deleted', 'database/mariadb/gone'],
      ['shop', 'running', 'database/mariadb/shop'],
    ]);
    expect(r.instances.every((i) => (i.sizeBytes ?? 0) > 0)).toBe(true);
    // An app's folder there is no orphan.
    expect(r.orphans.map((o) => o.folder)).toEqual(['database/mariadb/orphan']);
    expect(existsSync(p('database/mariadb/orphan'))).toBe(true);
  });

  it('releases the folders that belong to none to kept-databases/ when asked', async () => {
    await seedDb('shop', 'database/mariadb/shop');
    mkdirSync(p('database/mariadb/orphan'), { recursive: true });
    writeFileSync(p('database/mariadb/orphan/ibdata1'), 'x');
    expect(await releaseOrphanFolders({ db: db(), k8s }, tenantId, namespace)).toEqual({ moved: [{ from: 'database/mariadb/orphan', to: 'kept-databases/orphan' }] });
    expect(existsSync(p('kept-databases/orphan/ibdata1'))).toBe(true);
    expect(existsSync(p('database/mariadb/shop'))).toBe(true);
  });

  it('moves an instance on a custom path into the protected folder once', async () => {
    const id = await seedDb('legacy', 'public_html/db', { replicaCount: 1 });
    const controls = new Map<string, ReturnType<typeof control>>();
    const r = await relocateDatabaseFolders({ db: db(), k8s }, (dep) => { const c = control(); controls.set(dep.id, c); return c; });
    expect(r).toEqual({ moved: 1, blocked: 0 });
    const after = await row(id);
    expect(after.storagePath).toBe('database/mariadb/legacy');
    expect(after.storageRelocatedFrom).toBe('public_html/db');
    expect(readFileSync(p('database/mariadb/legacy/ibdata1'), 'utf8')).toBe('legacy');
    expect(controls.get(id)?.stop).toHaveBeenCalledOnce();
    // The stopped template points at the new folder before anything moves; started after.
    expect(controls.get(id)?.redeploy.mock.calls).toEqual([[0], [1]]);
    expect(await relocateDatabaseFolders({ db: db(), k8s }, () => control())).toEqual({ moved: 0, blocked: 0 });
  });

  it('keeps a stopped instance stopped when it moves it', async () => {
    const id = await seedDb('quiet', 'custom/quiet', { status: 'stopped' });
    const c = control();
    await relocateDatabaseFolders({ db: db(), k8s }, () => c);
    expect(c.stop).not.toHaveBeenCalled();
    expect(c.redeploy).toHaveBeenCalledWith(0);
    expect((await row(id)).storagePath).toBe('database/mariadb/quiet');
  });

  it('stops nothing for a move that cannot happen, and waits before trying it again', async () => {
    const id = await seedDb('linked', null, { replicaCount: 1 });
    mkdirSync(p('real/linked'), { recursive: true });
    symlinkSync(p('real'), p('alias'));
    await db().update(deployments).set({ storagePath: 'alias/linked' }).where(eq(deployments.id, id));
    const c = control();
    let now = 1_000_000;
    expect(await relocateDatabaseFolders({ db: db(), k8s }, () => c, 1, () => now)).toEqual({ moved: 0, blocked: 0 });
    expect(c.stop).not.toHaveBeenCalled();
    expect(c.redeploy).not.toHaveBeenCalled();
    expect((await row(id)).storagePath).toBe('alias/linked');
    expect((await row(id)).dataDetachedPath).toBeNull();
    // Within the back-off it is not tried at all; after it, it is.
    const spy = vi.spyOn(k8s.core, 'listNamespacedPod');
    await relocateDatabaseFolders({ db: db(), k8s }, () => c, 1, () => now + 30 * 60 * 1000);
    expect(spy).not.toHaveBeenCalled();
    now += 2 * 60 * 60 * 1000;
    rmSync(p('alias'));
    mkdirSync(p('alias/linked'), { recursive: true });
    expect(await relocateDatabaseFolders({ db: db(), k8s }, () => c, 1, () => now)).toEqual({ moved: 1, blocked: 0 });
  });

  it('marks the instance while its data moves, so nothing starts it on the wrong folder', async () => {
    const id = await seedDb('marked', 'custom/marked', { replicaCount: 1 });
    let markDuringStop: string | null | undefined;
    const c = { stop: vi.fn(async () => { markDuringStop = (await row(id)).dataDetachedPath; }), redeploy: vi.fn(async () => undefined) };
    await relocateDatabaseFolders({ db: db(), k8s }, () => c);
    expect(markDuringStop).toBe('custom/marked');
    expect((await row(id)).dataDetachedPath).toBeNull();
  });

  it('puts an instance back as it was when its move fails cleanly', async () => {
    const id = await seedDb('hl', 'custom/hl', { replicaCount: 1 });
    mkdirSync(p('elsewhere'));
    linkSync(p('custom/hl/ibdata1'), p('elsewhere/second-name'));
    const c = control();
    await relocateDatabaseFolders({ db: db(), k8s }, () => c, 1, () => 5_000_000);
    const after = await row(id);
    expect(after.storagePath).toBe('custom/hl');
    expect(after.dataDetachedPath).toBeNull();
    expect(c.redeploy.mock.calls).toEqual([[0], [1]]); // to the new folder (stopped), then back on the old one, started
    expect(readFileSync(p('custom/hl/ibdata1'), 'utf8')).toBe('hl');
  });

  it('keeps the mark when a move was interrupted after the data left, and Attach finishes it', async () => {
    const id = await seedDb('cut', 'custom/cut', { replicaCount: 1 });
    rejectAfter = (op) => op === 'move-in';
    const c = control();
    await relocateDatabaseFolders({ db: db(), k8s }, () => c, 1, () => 9_000_000);
    const after = await row(id);
    expect(after.dataDetachedPath).toBe('custom/cut');
    expect(after.storagePath).toBe('database/mariadb/cut');
    expect(c.redeploy.mock.calls).toEqual([[0]]); // never started on an empty folder
    expect(notify).toHaveBeenCalled();
    expect(readFileSync(p('database/mariadb/cut/ibdata1'), 'utf8')).toBe('cut');
    rejectAfter = null;
    const a = control();
    expect(await attachDatabaseData({ db: db(), k8s }, tenantId, id, undefined, a)).toEqual({ storagePath: 'database/mariadb/cut' });
    expect((await row(id)).dataDetachedPath).toBeNull();
    expect(a.redeploy).toHaveBeenCalledWith(1);
  });

  it('does not let a blocked instance hold the others back', async () => {
    await seedDb('shared', 'media/db');
    await seedApp('site', 'runtime/php/site', [{ folder: 'media', mount_path: '/srv/media', read_only: false }]);
    const free = await seedDb('free', 'custom/free');
    expect(await relocateDatabaseFolders({ db: db(), k8s }, () => control())).toEqual({ moved: 1, blocked: 1 });
    expect((await row(free)).storagePath).toBe('database/mariadb/free');
  });

  it('leaves a shared folder where it is and tells the operator (one notice per key; the dispatcher dedupes)', async () => {
    const id = await seedDb('shared', 'media/db');
    await seedApp('site', 'runtime/php/site', [{ folder: 'media', mount_path: '/srv/media', read_only: false }]);
    expect(await relocateDatabaseFolders({ db: db(), k8s }, () => control())).toEqual({ moved: 0, blocked: 1 });
    expect(await relocateDatabaseFolders({ db: db(), k8s }, () => control())).toEqual({ moved: 0, blocked: 1 });
    expect(notify).toHaveBeenCalledWith(expect.anything(), 'database', expect.objectContaining({ subsystem: 'Tenant databases' }), `database-folder-relocate-blocked:${id}`);
    expect((await row(id)).storagePath).toBe('media/db');
  });

  it('the deployment service refuses a storage-path re-point, a start while detached, and restores a detached instance stopped', async () => {
    const { renderedExtraMounts, restoreDeployment, updateDeployment } = await import('./service.js');
    const id = await seedDb('svc', 'database/mariadb/svc');
    await expect(updateDeployment(db(), tenantId, id, { storage_path: 'uploads/other' })).rejects.toMatchObject({ code: 'DATABASE_FOLDER_MANAGED' });
    await detachDatabaseData({ db: db(), k8s }, tenantId, id, control());
    await expect(updateDeployment(db(), tenantId, id, { status: 'running' })).rejects.toMatchObject({ code: 'DATABASE_DATA_DETACHED' });
    await db().update(deployments).set({ status: 'deleted', deletedAt: new Date() }).where(eq(deployments.id, id));
    await restoreDeployment(db(), tenantId, id);
    expect((await row(id)).status).toBe('stopped');
    expect(renderedExtraMounts('runtime', [{ folder: 'database/mariadb/svc' }, { folder: 'media' }])).toEqual([{ folder: 'media' }]);
    expect(renderedExtraMounts('database', [{ folder: 'media' }])).toBeUndefined();
    const { redeployWithCurrentConfig } = await import('./service.js');
    await expect(redeployWithCurrentConfig(db(), await row(id), {} as K8sClients, { armPasswordReset: true }))
      .rejects.toMatchObject({ code: 'DATABASE_DATA_DETACHED' });
  });

  it('releases the folder on a permanent delete: kept, or removed', async () => {
    await seedDb('keep', 'database/mariadb/keep');
    await seedDb('drop', 'database/mariadb/drop');
    expect(await releaseDatabaseFolderOnDelete({ db: db(), k8s }, namespace, { name: 'keep', storagePath: 'database/mariadb/keep', dataDetachedPath: null }, 'keep'))
      .toBe('kept-databases/keep');
    expect(await releaseDatabaseFolderOnDelete({ db: db(), k8s }, namespace, { name: 'drop', storagePath: 'database/mariadb/drop', dataDetachedPath: null }, 'remove'))
      .toBeNull();
    expect(existsSync(p('kept-databases/keep/ibdata1'))).toBe(true);
    expect(existsSync(p('database/mariadb/drop'))).toBe(false);
    expect(await releaseDatabaseFolderOnDelete({ db: db(), k8s }, namespace, { name: 'x', storagePath: 'public_html/x', dataDetachedPath: null }, 'keep')).toBeNull();
  });
});
