/**
 * The integrity check and an archived tenant's storage volume — against a
 * REAL Postgres with every migration applied (the tenant row, the plan and
 * the tenant's lock are real), and a stand-in cluster.
 *
 * Two things must both hold: an archived tenant is never given a volume, and
 * the empty one an earlier release gave it is removed — but only that one.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { storageOperations, storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { RUN_LOCK_TTL_MS, runLockName } from '../../shared/exclusive-run.js';
import { claimSchedulerLease, releaseSchedulerLease } from '../../shared/scheduler-lease.js';
import { tenantLockJob } from '../tenant-lifecycle/tenant-lock.js';

const told = vi.fn(async () => undefined);
vi.mock('../notifications/events.js', () => ({ notifyAdminOperationalEvent: (...a: unknown[]) => told(...(a as [])) }));
const created: string[] = [];
vi.mock('../k8s-provisioner/service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  applyPVC: async (_k8s: unknown, namespace: string) => { created.push(`claim in ${namespace}`); },
}));

/** What a restore from the archive did, in order — beside the cluster's own `deleted`. */
const restored: string[] = [];
vi.mock('../storage-lifecycle/prebundle.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  restoreFilesBundleIntoPvc: async (args: { bundleId: string; pvcName: string }) => { restored.push(`files of ${args.bundleId} into ${args.pvcName}`); },
}));
vi.mock('../tenant-lifecycle/cascades.js', () => ({
  applyRestored: async (ctx: { db: Database }, tenantId: string) => {
    await ctx.db.update(tenants).set({ status: 'active', archivedAt: null }).where(eq(tenants.id, tenantId));
    return 't-1';
  },
}));

const { checkTenantNamespaceIntegrity, sweepFleetIntegrity } = await import('./service.js');
const { restoreArchivedTenant } = await import('../storage-lifecycle/service.js');
const { removeArchivedVolumeIfUnused } = await import('../storage-lifecycle/archived-volume.js');

const dbAvailable = await isDbAvailable();
const notFound = (): Error => Object.assign(new Error('not found'), { code: 404 });

describe.skipIf(!dbAvailable)('integrity check: an archived tenant\'s volume (real Postgres)', () => {
  const db = () => getTestDb() as unknown as Database;
  let regionId = '';
  let planId = '';
  const ARCHIVED_AT = new Date('2026-06-01T10:00:00.000Z');

  /** The cluster: per namespace, the claim (if any) and what Longhorn says of its volume. */
  interface Volume { created: Date; actualSize: number; lastPodRefAt: string; state: string }
  const volumes = new Map<string, Volume>();
  const deleted: string[] = [];
  /** Longhorn refuses to be read (a 403 on its volumes, an API server hiccup). */
  let unreadable = false;
  const k8s = {
    core: {
      readNamespace: async () => ({}),
      readNamespacedPersistentVolumeClaim: async ({ namespace }: { namespace: string }) => {
        const v = volumes.get(namespace);
        if (!v) throw notFound();
        return { metadata: { creationTimestamp: v.created }, spec: { volumeName: `pv-${namespace}`, resources: { requests: { storage: '10Gi' } } } };
      },
      readNamespacedResourceQuota: async () => ({}),
      listNamespacedResourceQuota: async () => ({ items: [] }),
      listNamespacedPod: async () => ({ items: [] }),
      readPersistentVolume: async ({ name }: { name: string }) => ({ spec: { csi: { driver: 'driver.longhorn.io', volumeHandle: name } } }),
      deleteNamespacedPersistentVolumeClaim: async ({ namespace }: { namespace: string }) => {
        if (!volumes.delete(namespace)) throw notFound();
        deleted.push(`claim in ${namespace}`);
      },
      deletePersistentVolume: async ({ name }: { name: string }) => { deleted.push(`pv ${name}`); },
    },
    networking: { readNamespacedNetworkPolicy: async () => ({}) },
    custom: {
      getNamespacedCustomObject: async ({ name }: { name: string }) => {
        if (unreadable) throw Object.assign(new Error('volumes.longhorn.io is forbidden'), { code: 403 });
        const v = volumes.get(name.replace(/^pv-/, ''));
        if (!v) throw notFound();
        return { status: { state: v.state, actualSize: v.actualSize, kubernetesStatus: { lastPodRefAt: v.lastPodRefAt } } };
      },
      deleteNamespacedCustomObject: async ({ name }: { name: string }) => { deleted.push(`longhorn ${name}`); },
    },
  } as unknown as K8sClients;

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw(`DELETE FROM platform_settings WHERE setting_key LIKE 'scheduler-lease:%'`));
    regionId = (await seedRegion(db())).id;
    planId = (await seedPlan(db())).id;
    volumes.clear(); deleted.length = 0; created.length = 0; told.mockClear();
    restored.length = 0; unreadable = false;
  });

  const tenant = async (over: Partial<typeof tenants.$inferInsert> = {}) => seedTenant(db(), regionId, planId, {
    status: 'archived', archivedAt: ARCHIVED_AT, provisioningStatus: 'provisioned', ...over,
  });
  /** The empty volume the sweep's earlier release created: after the archive, never mounted, zero bytes. */
  const stray = (namespace: string, over: Partial<Volume> = {}): void => {
    volumes.set(namespace, { created: new Date('2026-06-01T10:25:00.000Z'), actualSize: 0, lastPodRefAt: '', state: 'detached', ...over });
  };

  it('an archived tenant without a volume has nothing wrong with it, and gets none', async () => {
    const t = await tenant();
    const report = await checkTenantNamespaceIntegrity(db(), k8s, t.id, true);
    expect(report.findings).toEqual([]);
    expect(report.repaired).toEqual([]);
    expect(created).toEqual([]);
  });

  it('reports the empty volume left on an archived tenant — and only reports it when not asked to repair', async () => {
    const t = await tenant();
    stray(t.kubernetesNamespace);
    const report = await checkTenantNamespaceIntegrity(db(), k8s, t.id, false);
    expect(report.findings).toEqual(['archived_volume_unused']);
    expect(report.repaired).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('removes it on repair — the claim, then its volume — and tells the admins what it removed', async () => {
    const t = await tenant();
    stray(t.kubernetesNamespace);
    const report = await checkTenantNamespaceIntegrity(db(), k8s, t.id, true);
    expect(report).toMatchObject({ findings: ['archived_volume_unused'], repaired: ['archived_volume_unused'], errors: [] });
    expect(deleted).toEqual([`claim in ${t.kubernetesNamespace}`, `pv pv-${t.kubernetesNamespace}`, `longhorn pv-${t.kubernetesNamespace}`]);
    expect(told).toHaveBeenCalledTimes(1);
    const payload = (told.mock.calls[0] as unknown as [unknown, string, { items: string[]; detail: string }])[2];
    expect(payload.items).toEqual(['Repaired — the unused storage volume left on the archived tenant (removed)']);
    expect(payload.detail).toBe('Auto-repaired 1 resource(s).');
    // And the next check finds the tenant as an archive leaves it.
    expect((await checkTenantNamespaceIntegrity(db(), k8s, t.id, true)).findings).toEqual([]);
  });

  it.each<[string, Partial<Volume>]>([
    ['has been written to', { actualSize: 8192 }],
    ['was mounted by a pod at some time', { lastPodRefAt: '2026-06-03T00:00:00Z' }],
    ['is attached', { state: 'attached' }],
    ['is older than the archive', { created: new Date('2026-05-01T00:00:00.000Z') }],
  ])('a volume that %s is no finding, is not removed, and nobody is told', async (_what, over) => {
    const t = await tenant();
    stray(t.kubernetesNamespace, over);
    const report = await checkTenantNamespaceIntegrity(db(), k8s, t.id, true);
    expect(report.findings).toEqual([]);
    expect(deleted).toEqual([]);
    expect(told).not.toHaveBeenCalled();
  });

  it('a volume made within the last hour is not judged: a restore or a recovery may be about to fill it', async () => {
    const t = await tenant();
    stray(t.kubernetesNamespace, { created: new Date(Date.now() - 10 * 60_000) });
    expect((await checkTenantNamespaceIntegrity(db(), k8s, t.id, true)).findings).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('a volume that cannot be read is left alone, and the rest of the tenant\'s check still answers', async () => {
    const t = await tenant();
    stray(t.kubernetesNamespace);
    unreadable = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const report = await checkTenantNamespaceIntegrity(db(), k8s, t.id, true);
      expect(report).toMatchObject({ tenantId: t.id, findings: [], repaired: [], errors: [] });
      expect(deleted).toEqual([]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('could not read the storage volume of archived tenant'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('never looks at the volume of a tenant that is not archived', async () => {
    const t = await tenant({ status: 'suspended', archivedAt: ARCHIVED_AT });   // restored once, suspended now
    stray(t.kubernetesNamespace);
    const report = await checkTenantNamespaceIntegrity(db(), k8s, t.id, true);
    expect(report.findings).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it('never removes it while a storage operation owns the tenant — a restore is filling that very volume', async () => {
    const t = await tenant({ storageLifecycleState: 'restoring' });
    stray(t.kubernetesNamespace);
    expect((await checkTenantNamespaceIntegrity(db(), k8s, t.id, true)).findings).toEqual([]);
    expect(await removeArchivedVolumeIfUnused(db(), k8s, t.id)).toBe(false);
    expect(deleted).toEqual([]);
  });

  it('leaves the volume for the next sweep, without waiting, when another change holds the tenant', async () => {
    const t = await tenant();
    stray(t.kubernetesNamespace);
    const lock = runLockName(tenantLockJob(t.id));
    expect(await claimSchedulerLease(db(), lock, RUN_LOCK_TTL_MS, 'replica-b')).toBe(true);
    const began = performance.now();
    const report = await checkTenantNamespaceIntegrity(db(), k8s, t.id, true);
    expect(performance.now() - began).toBeLessThan(2_000);
    expect(report).toMatchObject({ findings: ['archived_volume_unused'], repaired: [], errors: [] });
    expect(deleted).toEqual([]);
    await releaseSchedulerLease(db(), lock, 'replica-b');
    expect((await checkTenantNamespaceIntegrity(db(), k8s, t.id, true)).repaired).toEqual(['archived_volume_unused']);
  });

  it('decides again under the lock: a tenant restored between the check and the removal keeps its volume', async () => {
    const t = await tenant();
    stray(t.kubernetesNamespace);
    await db().update(tenants).set({ status: 'active' }).where(eq(tenants.id, t.id));
    expect(await removeArchivedVolumeIfUnused(db(), k8s, t.id)).toBe(false);
    expect(deleted).toEqual([]);
  });

  it('the fleet sweep removes every such volume and counts the tenants it repaired', async () => {
    const a = await tenant();
    const b = await tenant();
    const live = await tenant({ status: 'active', archivedAt: null });
    stray(a.kubernetesNamespace);
    stray(b.kubernetesNamespace);
    stray(live.kubernetesNamespace, { actualSize: 123_456_789, lastPodRefAt: '2026-06-02T00:00:00Z' });   // a tenant's real volume
    expect(await sweepFleetIntegrity(db(), k8s)).toEqual({ checked: 3, repaired: 2, errored: 0 });
    expect([...volumes.keys()]).toEqual([live.kubernetesNamespace]);
    expect(created).toEqual([]);
  });

  describe('restoring an archived tenant that has such a volume', () => {
    const ctx = () => ({ db: db(), k8s, store: {}, platformNamespace: 'platform' }) as never;
    /** An archived tenant with its archive on record, as an archive leaves it. */
    const archived = async () => {
      const t = await tenant();
      await db().insert(storageSnapshots).values({
        id: crypto.randomUUID(), tenantId: t.id, kind: 'pre-archive', status: 'ready',
        archivePath: 'bundle:bkp-archive', expiresAt: new Date(Date.now() + 90 * 86_400_000),
      });
      return t;
    };
    const restoreEnded = async (tenantId: string) => {
      for (let i = 0; i < 100; i += 1) {
        const [row] = await db().select().from(storageOperations).where(eq(storageOperations.tenantId, tenantId));
        if (row?.completedAt) return row;
        await new Promise((resolve) => { setTimeout(resolve, 30); });
      }
      throw new Error('the restore did not end');
    };

    it('removes a volume that was never written to, then creates the one asked for and restores into that', async () => {
      const t = await archived();
      stray(t.kubernetesNamespace);
      await restoreArchivedTenant(ctx(), t.id);
      expect(await restoreEnded(t.id)).toMatchObject({ state: 'idle', lastError: null });
      expect(deleted).toEqual([`claim in ${t.kubernetesNamespace}`, `pv pv-${t.kubernetesNamespace}`, `longhorn pv-${t.kubernetesNamespace}`]);
      expect(created).toEqual([`claim in ${t.kubernetesNamespace}`]);
      expect(restored).toEqual([`files of bkp-archive into ${t.kubernetesNamespace}-storage`]);
    });

    it('keeps a volume that holds anything and restores into it', async () => {
      const t = await archived();
      stray(t.kubernetesNamespace, { actualSize: 52_428_800, lastPodRefAt: '2026-06-03T00:00:00Z' });
      await restoreArchivedTenant(ctx(), t.id);
      expect(await restoreEnded(t.id)).toMatchObject({ state: 'idle' });
      expect(deleted).toEqual([]);
      expect(restored).toHaveLength(1);
    });

    it('fails the restore, with nothing deleted, when the volume cannot be read — it does not guess', async () => {
      const t = await archived();
      stray(t.kubernetesNamespace);
      unreadable = true;
      await restoreArchivedTenant(ctx(), t.id);
      const row = await restoreEnded(t.id);
      expect(row.state).toBe('failed');
      expect(deleted).toEqual([]);
      expect(restored).toEqual([]);
    });
  });
});
