/**
 * Starting a storage operation — against a REAL Postgres with every migration
 * applied.
 *
 * A resize, a restore, a filesystem check and an archive run under a lock of
 * their own (`opLockJob`), and that lock is what the watchdog reads
 * "interrupted" from. So an operation whose lock could not be taken must not
 * be left claimed: nothing would be running it, and nothing would ever pick it
 * up.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedDomain, seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { backupComponents, backupJobs, hostingPlans, storageOperations, storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const did: string[] = [];
/** The size, in GiB, of every claim the restore asked for. */
const claimsAskedGi: string[] = [];
/** Run by the restore's look at the leftover volume, once: the claim starting to be deleted after the request. */
let whenRestoreLooks: (() => void) | null = null;
/** What asking for an operation's lock comes to: taken, held by another process, or the database not answering. */
let claim: 'taken' | 'held elsewhere' | 'database down' = 'taken';

vi.mock('../../shared/exclusive-run.js', async (orig) => {
  const actual = await orig<typeof import('../../shared/exclusive-run.js')>();
  return {
    ...actual,
    runExclusive: (db: never, job: string, fn: () => Promise<unknown>, opts: never) => {
      if (job.startsWith('storage-op:')) {
        if (claim === 'database down') return Promise.reject(new Error('connection terminated unexpectedly'));
        if (claim === 'held elsewhere') return Promise.resolve({ ran: false });
      }
      return actual.runExclusive(db, job, fn, opts);
    },
  };
});
vi.mock('./quiesce.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  quiesce: async (_k8s: unknown, _ns: string, persist?: (snap: unknown) => Promise<void>) => {
    did.push('quiesce');
    const snap = { deployments: [], cronJobs: [] };
    await persist?.(snap);
    return snap;
  },
  waitForQuiesced: async () => undefined,
  unquiesce: async () => { did.push('unquiesce'); },
}));
vi.mock('./prebundle.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveTenantBundleTarget: async () => ({ id: 'target-1' }),
  captureFilesOnlyBundle: async () => { did.push('capture'); return { bundleId: 'bkp-1', status: 'completed', sizeBytes: 10 }; },
  captureArchiveBundle: async () => { did.push('capture'); return { bundleId: 'bkp-1', status: 'completed', sizeBytes: 10 }; },
  restoreFilesBundleIntoPvc: async () => { did.push('restore'); },
  reapPreResizeBundle: async () => undefined,
}));
vi.mock('./fsck.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runFsck: async () => {
    did.push('fsck');
    return { fsType: 'xfs', dryRun: true, exitCode: 0, output: '', clean: true, verdict: 'clean', logDirty: false, summary: 'clean' };
  },
}));
vi.mock('./archived-volume.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  inspectArchivedVolume: async () => {
    if (!whenRestoreLooks) return { kind: 'absent' };
    whenRestoreLooks(); whenRestoreLooks = null;
    return { kind: 'releasing' };
  },
}));
vi.mock('../k8s-provisioner/service.js', () => ({
  applyPVC: async (_k8s: unknown, _ns: string, gi: string) => { did.push('apply claim'); claimsAskedGi.push(gi); },
  selectTenantStorageClass: () => 'longhorn-tenant',
}));
vi.mock('../file-manager/idle-cleanup.js', () => ({ recordFileManagerAccess: () => undefined }));
vi.mock('../tenant-lifecycle/cascades.js', () => ({
  applyArchived: async (ctx: { db: Database }, tenantId: string) => {
    did.push('cascade');
    await ctx.db.update(tenants).set({ status: 'archived', archivedAt: new Date() }).where(eq(tenants.id, tenantId));
    return 't-1';
  },
  applyActive: async (ctx: { db: Database }, tenantId: string) => {
    did.push('cascade active');
    await ctx.db.update(tenants).set({ status: 'active', suspendedAt: null }).where(eq(tenants.id, tenantId));
    return 't-3';
  },
  // A restore from archive lands suspended.
  applySuspendedFromArchive: async (ctx: { db: Database }, tenantId: string) => {
    did.push('cascade');
    await ctx.db.update(tenants).set({ status: 'suspended', suspendedAt: new Date(), archivedAt: null }).where(eq(tenants.id, tenantId));
    return 't-2';
  },
}));
// The waits for a claim to be gone, shortened: the logic is the module's own (claim-release.test.ts).
vi.mock('./claim-release.js', async (orig) => {
  const actual = await orig<typeof import('./claim-release.js')>();
  return {
    ...actual,
    deleteClaimAndWait: (k: never, ns: string, name: string, timing: Record<string, unknown> = {}) =>
      actual.deleteClaimAndWait(k, ns, name, { ...timing, timeoutMs: 50, pollMs: 5 }),
  };
});
// The node the restore runs on: the pin (restore-placement.test.ts covers the choice).
vi.mock('../tenant-archive/restore-placement.js', () => ({
  chooseRestoreNode: async (_db: unknown, _k8s: unknown, t: { nodeName: string | null }, requested: string | null | undefined) =>
    (requested === undefined ? t.nodeName ?? null : requested),
}));
// The routes a restored tenant's suspension redirects, rebuilt first — with
// the status its domains have at that moment (a certificate is looked up only
// for an active domain).
const domainsAtRoutes: string[] = [];
vi.mock('../domains/k8s-ingress.js', () => ({
  reconcileIngress: async (db: Database, _k8s: unknown, tenantId: string) => {
    const { domains } = await import('../../db/schema.js');
    const rows = await db.select({ status: domains.status }).from(domains).where(eq(domains.tenantId, tenantId));
    domainsAtRoutes.push(...rows.map((r) => r.status));
    did.push('routes');
  },
}));

const { archiveTenant, resizeTenant, fsckCheckTenant, restoreArchivedTenant, resumeTenant } = await import('./service.js');
const dbAvailable = await isDbAvailable();

describe('how a detached operation is started', () => {
  const source = readFileSync(fileURLToPath(new URL('./service.ts', import.meta.url)), 'utf8');

  it('never with a bare call that nothing waits for: such a run has no lock, and is nobody\'s when its process dies', () => {
    expect(source.match(/\bvoid run[A-Z]\w*\(/g) ?? []).toEqual([]);
  });

  it.each(['runGrowOnline', 'runResizeDestructive', 'runRestoreFromSnapshot', 'runRestoreFromRetained', 'runRestoreArchive', 'runFsckOp', 'runArchive'])(
    '%s is called from two places only: its starter, under the lock, and the pick-up',
    (runner) => {
      const lines = source.split('\n');
      const pickUpFrom = lines.findIndex((line) => line.startsWith('async function runnerFor('));
      const pickUpTo = lines.findIndex((line, i) => i > pickUpFrom && line === '}');
      expect(pickUpFrom).toBeGreaterThan(0);
      const calls = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => new RegExp(`\\b${runner}\\(`).test(line) && !line.includes(`async function ${runner}(`));
      expect(calls).toHaveLength(2);
      expect(calls.filter(({ line }) => line.includes('beginOp('))).toHaveLength(1);
      expect(calls.filter(({ i }) => i > pickUpFrom && i < pickUpTo)).toHaveLength(1);
    },
  );
});

describe.skipIf(!dbAvailable)('starting a storage operation (real Postgres)', () => {
  const db = () => getTestDb() as unknown as Database;
  let tenantId = '';
  let claimGi = 20;
  /** The claim was deleted and is still there: Kubernetes keeps it while a placed pod names it, finished or not. */
  let claimDeleting = false;
  /** Pods in the tenant namespace that name its claim. */
  let holders: Array<{ name: string; phase: string }> = [];
  const notFound = (): never => { throw Object.assign(new Error('not found'), { statusCode: 404 }); };
  const settleClaim = (): void => { if (claimDeleting && holders.length === 0) { claimDeleting = false; claimGi = 0; } };
  const k8s = {
    apps: { listNamespacedDeployment: async () => ({ items: [] }), readNamespacedDeployment: async () => notFound() },
    batch: { listNamespacedCronJob: async () => ({ items: [] }), deleteNamespacedJob: async () => undefined },
    core: {
      listNamespacedService: async () => ({ items: [] }),
      listNamespacedPod: async ({ namespace }: { namespace: string }) => ({
        items: holders.map((h) => ({
          metadata: { name: h.name },
          spec: { nodeName: 'node-a', volumes: [{ persistentVolumeClaim: { claimName: `${namespace}-storage` } }] },
          status: { phase: h.phase },
        })),
      }),
      deleteNamespacedPod: async ({ name }: { name: string }) => { did.push(`delete pod ${name}`); holders = holders.filter((h) => h.name !== name); },
      readNamespacedPersistentVolumeClaim: async () => { settleClaim(); return (claimGi > 0
        ? {
          metadata: claimDeleting ? { deletionTimestamp: new Date() } : {},
          spec: { storageClassName: 'longhorn-tenant', volumeName: 'pv-1', resources: { requests: { storage: `${claimGi}Gi` } } },
          status: { phase: 'Bound', capacity: { storage: `${claimGi}Gi` } },
        }
        : notFound()); },
      deleteNamespacedPersistentVolumeClaim: async () => {
        if (claimGi === 0) notFound();
        if (!claimDeleting) did.push('delete claim');
        claimDeleting = true;
        settleClaim();
      },
      createNamespacedPersistentVolumeClaim: async () => { did.push('create claim'); claimGi = 10; },
      patchNamespacedPersistentVolumeClaim: async () => { did.push('grow claim'); claimGi = 30; },
      readPersistentVolume: async () => ({ spec: { csi: { volumeAttributes: { fsType: 'xfs' } } } }),
      patchNamespacedResourceQuota: async ({ body }: { body: { spec: { hard: Record<string, string> } } }) => {
        did.push(`quota ${body.spec.hard['requests.storage']}`);
      },
    },
    custom: {
      getNamespacedCustomObject: async () => ({ status: { state: did.includes('attach') && !did.includes('detach') ? 'attached' : 'detached', currentNodeID: 'node-a', ownerID: 'node-a' } }),
      patchNamespacedCustomObject: async ({ body }: { body: { spec: { attachmentTickets: Record<string, unknown> } } }) => {
        did.push(Object.values(body.spec.attachmentTickets)[0] === null ? 'detach' : 'attach');
      },
    },
  } as unknown as K8sClients;
  const ctx = () => ({ db: db(), k8s, store: {}, platformNamespace: 'platform' }) as never;

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw(`DELETE FROM platform_settings WHERE setting_key LIKE 'scheduler-lease:%'`));
    const region = await seedRegion(db());
    const plan = await seedPlan(db());
    tenantId = (await seedTenant(db(), region.id, plan.id, { status: 'suspended', suspendedAt: new Date(Date.now() - 40 * 86_400_000) })).id;
    did.length = 0; claimsAskedGi.length = 0; claim = 'taken'; claimGi = 20; claimDeleting = false; holders = []; whenRestoreLooks = null;
  });

  const tenantRow = async () => (await db().select().from(tenants).where(eq(tenants.id, tenantId)))[0];
  const ops = () => db().select().from(storageOperations).where(eq(storageOperations.tenantId, tenantId)).orderBy(storageOperations.createdAt);
  const snaps = () => db().select().from(storageSnapshots).where(eq(storageSnapshots.tenantId, tenantId));
  const leases = async (): Promise<number> => ((await db().execute(sql`SELECT 1 FROM platform_settings WHERE setting_key LIKE 'scheduler-lease:%'`)) as unknown as { rows: unknown[] }).rows.length;
  const finished = async (operationId: string) => {
    for (let i = 0; i < 200; i += 1) {
      const row = (await ops()).find((o) => o.id === operationId);
      if (row?.completedAt && await leases() === 0) return row;
      await new Promise((resolve) => { setTimeout(resolve, 30); });
    }
    throw new Error(`operation ${operationId} did not finish; it did: ${did.join(' | ')}`);
  };
  /** An archived tenant with a ready archive to restore from. */
  const archived = async () => {
    await db().update(tenants).set({ status: 'archived', archivedAt: new Date(Date.now() - 86_400_000) }).where(eq(tenants.id, tenantId));
    await db().insert(storageSnapshots).values({
      id: crypto.randomUUID(), tenantId, kind: 'pre-archive', status: 'ready', archivePath: 'bundle:bkp-archive',
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
    });
    claimGi = 0;
  };

  interface Kind {
    readonly name: string;
    readonly prepare?: () => Promise<void>;
    readonly start: () => Promise<{ operationId: string }>;
    readonly does: string[];
    /** The snapshot row the starter writes beside the operation, if it writes one. */
    readonly writesSnapshot: boolean;
  }
  const KINDS: Kind[] = [
    { name: 'an archive', start: () => archiveTenant(ctx(), tenantId), does: ['quiesce', 'capture', 'delete claim', 'cascade'], writesSnapshot: true },
    { name: 'an online grow', start: () => resizeTenant(ctx(), tenantId, { newGi: 30 }), does: ['grow claim'], writesSnapshot: false },
    {
      name: 'a shrink', start: () => resizeTenant(ctx(), tenantId, { newGi: 10 }),
      does: ['quiesce', 'capture', 'delete claim', 'create claim', 'restore', 'unquiesce'], writesSnapshot: true,
    },
    { name: 'a filesystem check', start: () => fsckCheckTenant(ctx(), tenantId), does: ['quiesce', 'attach', 'fsck', 'detach', 'unquiesce'], writesSnapshot: false },
    { name: 'a restore of an archived tenant', prepare: archived, start: () => restoreArchivedTenant(ctx(), tenantId), does: ['apply claim', 'restore', 'routes', 'cascade'], writesSnapshot: false },
  ];

  it.each(KINDS)('$name answers once it is running under its lock, and then runs to its end', async ({ prepare, start, does }) => {
    await prepare?.();
    const { operationId } = await start();
    const row = await finished(operationId);
    expect(row, row.lastError ?? '').toMatchObject({ state: 'idle', progressPct: 100 });
    // The claim says it is waiting for its lock; a run that got it says it began.
    expect(row.params).toMatchObject({ awaitingLock: false });
    expect(await tenantRow()).toMatchObject({ storageLifecycleState: 'idle', activeStorageOpId: null });
    expect(did).toEqual(does);
    expect(await leases()).toBe(0);                    // the tenant's lock and the operation's, both given back
  });

  // The namespace's storage quota is the tenant's size to the MiB: a claim
  // rounded up to a whole GiB is refused by it, and the restore with it.
  it.each([
    { size: 'a 0.5 GiB plan', plan: '0.50', own: null, asks: '0.5' },
    { size: 'its own 2.5 GiB', plan: '0.50', own: '2.50', asks: '2.5' },
    { size: 'a 20 GiB plan', plan: '20.00', own: null, asks: '20' },
  ])('a restore asks for a claim of the tenant\'s own size: $size', async ({ plan, own, asks }) => {
    const { planId } = await tenantRow();
    await db().update(hostingPlans).set({ storageLimit: plan }).where(eq(hostingPlans.id, planId));
    await db().update(tenants).set({ storageLimitOverride: own }).where(eq(tenants.id, tenantId));
    await archived();
    const { operationId } = await restoreArchivedTenant(ctx(), tenantId);
    await finished(operationId);
    expect(claimsAskedGi).toEqual([asks]);
  });

  /** The archive's files, as its capture recorded them. */
  const archiveHolds = async (bytes: number) => {
    await db().insert(backupJobs).values({
      id: 'bkp-archive', tenantId, initiator: 'system', status: 'completed', systemTrigger: 'pre_archive',
      targetKind: 's3', targetUri: 's3://example.test/b', retentionDays: 90,
    });
    await db().insert(backupComponents).values({ id: crypto.randomUUID(), backupJobId: 'bkp-archive', component: 'files', artifactName: 'files', status: 'completed', sizeBytes: bytes });
  };

  it('a restore larger than the tenant makes that its size: its override, its quota, then the claim', async () => {
    const { planId } = await tenantRow();
    await db().update(hostingPlans).set({ storageLimit: '1.00' }).where(eq(hostingPlans.id, planId));
    await archived();
    const { operationId } = await restoreArchivedTenant(ctx(), tenantId, { newGi: 3 });
    const row = await finished(operationId);
    expect(row.state).toBe('idle');
    expect(did.slice(0, 2)).toEqual(['quota 3Gi', 'apply claim']);
    expect(claimsAskedGi).toEqual(['3']);
    expect((await tenantRow()).storageLimitOverride).toBe('3.00');
  });

  it('a restore smaller than the tenant makes that its size too: override, quota, claim agree', async () => {
    await archived();
    await finished((await restoreArchivedTenant(ctx(), tenantId, { newGi: 2.5 })).operationId);
    expect(did.slice(0, 2)).toEqual(['quota 2.5Gi', 'apply claim']);
    expect(claimsAskedGi).toEqual(['2.5']);
    expect((await tenantRow()).storageLimitOverride).toBe('2.50');
  });

  it('a restore at the tenant\'s own size leaves its quota alone', async () => {
    await archived();
    await finished((await restoreArchivedTenant(ctx(), tenantId)).operationId);
    expect(did.filter((d) => d.startsWith('quota'))).toEqual([]);
  });

  it('refuses a volume the archive\'s files cannot fit in, before anything is changed', async () => {
    const { planId } = await tenantRow();
    await db().update(hostingPlans).set({ storageLimit: '1.00' }).where(eq(hostingPlans.id, planId));
    await archived();
    await archiveHolds(Math.round(1.5 * 1024 ** 3));
    await expect(restoreArchivedTenant(ctx(), tenantId)).rejects.toMatchObject({ code: 'RESTORE_VOLUME_TOO_SMALL', status: 409 });
    expect(await ops()).toEqual([]);
    expect(await tenantRow()).toMatchObject({ status: 'archived', storageLifecycleState: 'idle', storageLimitOverride: null });
    // At a size that holds them, it goes ahead.
    await finished((await restoreArchivedTenant(ctx(), tenantId, { newGi: 2 })).operationId);
    expect(claimsAskedGi).toEqual(['2']);
  });

  // A backup's finished Job pod names the claim for the Job's TTL, and
  // Kubernetes keeps a deleted claim while it does: a restore started then
  // wrote into the archive's dying claim (measured on lab staging).
  const archiveClaimStillDeleting = async (pod: { name: string; phase: string }) => {
    await archived();
    claimGi = 20; claimDeleting = true; holders = [pod];
  };

  it('a restore removes the backup\'s finished pod that holds the archive\'s old claim, waits for the claim to go, then makes its own', async () => {
    await archiveClaimStillDeleting({ name: 'bk-files-bkp-1-abcde', phase: 'Succeeded' });
    const row = await finished((await restoreArchivedTenant(ctx(), tenantId)).operationId);
    expect(row.state).toBe('idle');
    expect(did.slice(0, 2)).toEqual(['delete pod bk-files-bkp-1-abcde', 'apply claim']);
    expect(claimDeleting).toBe(false);
  });

  it('refuses a restore while the archive\'s old claim is held by a pod that is still running — naming it, before anything is changed', async () => {
    await archiveClaimStillDeleting({ name: 'debug-shell', phase: 'Running' });
    await expect(restoreArchivedTenant(ctx(), tenantId)).rejects.toMatchObject({
      code: 'ARCHIVE_VOLUME_RELEASING', status: 409, message: expect.stringContaining('still used by debug-shell'),
    });
    expect(await ops()).toEqual([]);
    expect(await tenantRow()).toMatchObject({ status: 'archived', storageLifecycleState: 'idle' });
    expect(did).toEqual([]);
  });

  it('a claim that starts being deleted after the request was taken: the restore waits for it there too, then makes its own', async () => {
    await archived();
    whenRestoreLooks = () => { claimGi = 20; claimDeleting = true; holders = [{ name: 'bk-files-bkp-2-late', phase: 'Succeeded' }]; };
    const row = await finished((await restoreArchivedTenant(ctx(), tenantId)).operationId);
    expect(row, row.lastError ?? '').toMatchObject({ state: 'idle' });
    expect(did.slice(0, 2)).toEqual(['delete pod bk-files-bkp-2-late', 'apply claim']);
  });

  it('an archive waits for its claim to be gone, removing a backup\'s finished pod that holds it', async () => {
    holders = [{ name: 'bk-files-bkp-0-nightly', phase: 'Succeeded' }];
    const row = await finished((await archiveTenant(ctx(), tenantId)).operationId);
    expect(row).toMatchObject({ state: 'idle', progressMessage: 'Archive complete' });
    expect(did).toEqual(['quiesce', 'capture', 'delete pod bk-files-bkp-0-nightly', 'delete claim', 'cascade']);
    expect(claimGi).toBe(0);
  });

  it('an archive whose claim a running pod keeps still ends, and says the old volume was not removed and why', async () => {
    holders = [{ name: 'debug-shell', phase: 'Running' }];
    const row = await finished((await archiveTenant(ctx(), tenantId)).operationId);
    expect(row.state).toBe('idle');
    expect(row.progressMessage).toBe('Archive complete. The old volume was not removed: it is still used by debug-shell.');
    expect(await tenantRow()).toMatchObject({ status: 'archived' });
  });

  it('writes the node the restore runs on as the tenant\'s pin, before it starts', async () => {
    await db().update(tenants).set({ nodeName: 'sv-old' }).where(eq(tenants.id, tenantId));
    await archived();
    await finished((await restoreArchivedTenant(ctx(), tenantId, { nodeName: 'sv-new' })).operationId);
    expect((await tenantRow()).nodeName).toBe('sv-new');
  });

  it('rebuilds the routes with the tenant\'s domains active, so they keep their certificate', async () => {
    await seedDomain(db(), tenantId, { status: 'suspended' });
    await archived();
    domainsAtRoutes.length = 0;
    await finished((await restoreArchivedTenant(ctx(), tenantId)).operationId);
    expect(domainsAtRoutes).toEqual(['active']);
  });

  it('a restored tenant reads suspended, no longer archived', async () => {
    await archived();
    await finished((await restoreArchivedTenant(ctx(), tenantId)).operationId);
    expect(await tenantRow()).toMatchObject({ status: 'suspended', archivedAt: null });
  });

  // The hourly expiry check suspends an active tenant past its subscription
  // end: reactivated past it, it was suspended again within the hour.
  it('refuses to reactivate a tenant whose subscription has ended, and changes nothing', async () => {
    await db().update(tenants).set({ subscriptionExpiresAt: new Date(Date.now() - 86_400_000) }).where(eq(tenants.id, tenantId));
    await expect(resumeTenant(ctx(), tenantId)).rejects.toMatchObject({ code: 'SUBSCRIPTION_EXPIRED', status: 409 });
    expect(await tenantRow()).toMatchObject({ status: 'suspended', storageLifecycleState: 'idle' });
    expect(await ops()).toEqual([]);
    expect(did).toEqual([]);
  });

  it('reactivates once the subscription runs again, or has no end', async () => {
    await db().update(tenants).set({ subscriptionExpiresAt: new Date(Date.now() + 30 * 86_400_000) }).where(eq(tenants.id, tenantId));
    await resumeTenant(ctx(), tenantId);
    expect((await tenantRow()).status).toBe('active');
    await db().update(tenants).set({ status: 'suspended', subscriptionExpiresAt: null }).where(eq(tenants.id, tenantId));
    await resumeTenant(ctx(), tenantId);
    expect((await tenantRow()).status).toBe('active');
  });

  describe.each(KINDS)('$name whose lock cannot be taken', ({ prepare, start, writesSnapshot }) => {
    it.each(['database down', 'held elsewhere'] as const)('with the lock %s, the request fails and the tenant is left as it was — not claimed by an operation nobody runs', async (state) => {
      await prepare?.();
      const before = await tenantRow();
      const snapsBefore = (await snaps()).length;
      claim = state;
      const outcome = await start().then(() => null, (err: unknown) => err);
      expect(outcome).toMatchObject({ code: 'STORAGE_OP_NOT_STARTED', status: 503 });
      expect(did).toEqual([]);
      expect(await tenantRow()).toMatchObject({ status: before.status, storageLifecycleState: 'idle', activeStorageOpId: null });
      const [op] = await ops();
      expect(op).toMatchObject({ state: 'failed' });
      expect(op.completedAt).not.toBeNull();
      expect(op.lastError).toContain('its lock could not be taken');
      expect(op.params).toMatchObject({ awaitingLock: true });           // it never began, and its row says so
      if (writesSnapshot) expect((await snaps()).slice(snapsBefore)).toMatchObject([{ status: 'failed' }]);
      // …so the next attempt is not refused as "an operation is in progress".
      claim = 'taken';
      await expect(start()).resolves.toMatchObject({ operationId: expect.any(String) });
    });
  });
});
