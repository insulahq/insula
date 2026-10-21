/**
 * A storage operation whose process is gone is picked up again — against a
 * REAL Postgres with every migration applied, so the operation, snapshot,
 * bundle, tenant and lock rows are the real tables.
 *
 * The cluster, the captures, the reverts, the filesystem tool and the tenant's
 * cascades are stand-ins; what is under test is which operations are taken for
 * interrupted, what a second run does and does not repeat — at each step the
 * first one can have died in — and that a live operation is never taken over.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { desc, eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { backupJobs, storageOperations, storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { runLockName } from '../../shared/exclusive-run.js';
import { REPLICA_ID } from '../../shared/scheduler-lease.js';
import { tenantLockJob } from '../tenant-lifecycle/tenant-lock.js';

/** What the stand-ins were asked to do, in order. */
const did: string[] = [];
let captureOutcome: { status: 'completed' | 'partial' } | Error = { status: 'completed' };
/** Resolved by a test to let a step that is "running" finish. */
let gate: Promise<void> | null = null;
/** The fsck Job a dead process left, by the name the runner would look for. */
let leftFsckJob: string | null = null;
/** The Job a dead process left restoring a bundle into the volume. */
let leftRestoreJob: string | null = null;
/** The Longhorn volume as the stand-in cluster reports it. */
let volume = { state: 'detached', frontendDisabled: false, node: 'node-a' };
/** A stand-in step that fails, by the word it logs. */
let fails: string | null = null;
/** Called as the workloads are started, before anything else is recorded. */
let atUnquiesce: (() => Promise<void>) | null = null;
/** What the admins were told. */
const told: Array<{ subsystem: string; payload: Record<string, unknown>; dedupeKey?: string }> = [];
const failing = (step: string): void => { if (fails === step) throw new Error(`${step} failed`); };

vi.mock('./quiesce.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  quiesce: async (_k8s: unknown, _ns: string, persist?: (snap: unknown) => Promise<void>) => {
    // The workloads are at zero already when an operation is picked up again:
    // counts taken now are all zero.
    const now = { deployments: [{ name: 'web', replicas: 0 }], cronJobs: [] };
    did.push(persist ? 'quiesce (writing the counts down)' : 'quiesce');
    await persist?.(now);
    return now;
  },
  waitForQuiesced: async () => undefined,
  unquiesce: async (_k8s: unknown, _ns: string, snap: { deployments: Array<{ name: string; replicas: number }> }) => {
    await atUnquiesce?.();
    did.push(`unquiesce to ${snap.deployments.map((d) => `${d.name}=${d.replicas}`).join(',')}`);
  },
  clearQuiesceHold: async () => { did.push('clear hold'); },
}));
/** The capture stand-in: a shrink's files-only bundle and an archive's whole one alike. */
const capture = async () => {
  did.push('capture');
  await gate;
  if (captureOutcome instanceof Error) throw captureOutcome;
  return { bundleId: 'bkp-new', status: captureOutcome.status, sizeBytes: 4242 };
};
vi.mock('./prebundle.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  captureFilesOnlyBundle: capture,
  captureArchiveBundle: capture,
  restoreFilesBundleIntoPvc: async (args: { bundleId: string; resumed?: boolean }) => {
    did.push(`restore ${args.bundleId}${args.resumed ? ' (looking for the Job left behind)' : ''}`);
    await gate;
    failing('restore');
  },
  reapPreResizeBundle: async () => { did.push('reap bundle'); },
}));
vi.mock('./longhorn-revert.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  revertVolumeToSnapshot: async (_k8s: unknown, vol: string, snap: string) => { did.push(`revert ${vol} to ${snap}`); await gate; return []; },
  releaseLeftoverMaintenanceAttach: async (_k8s: unknown, vol: string) => { did.push(`release maintenance attach of ${vol}`); return false; },
}));
vi.mock('./fsck.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  leftoverFsckJob: async () => leftFsckJob,
  runFsck: async (_k8s: unknown, opts: { jobName: string; adopt: boolean; dryRun: boolean }) => {
    did.push(`fsck ${opts.jobName}${opts.adopt ? ' (waiting for the Job left behind)' : ''}`);
    await gate;
    return { fsType: 'xfs', dryRun: opts.dryRun, exitCode: 0, output: 'no errors', clean: true, verdict: 'clean', logDirty: false, summary: 'Filesystem is clean' };
  },
}));
vi.mock('./archived-volume.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  inspectArchivedVolume: async () => ({ kind: 'absent' }),
}));
vi.mock('../k8s-provisioner/service.js', () => ({
  applyPVC: async (_k8s: unknown, _ns: string, gi: string, cls: string) => { did.push(`apply claim ${gi}Gi ${cls}`); },
  selectTenantStorageClass: () => 'longhorn-tenant',
}));
vi.mock('../tenant-lifecycle/cascades.js', () => ({
  applyArchived: async (ctx: { db: Database }, tenantId: string) => {
    did.push('cascade archived');
    await ctx.db.update(tenants).set({ status: 'archived', archivedAt: new Date() }).where(eq(tenants.id, tenantId));
    return 'transition-1';
  },
  applyRestored: async (ctx: { db: Database }, tenantId: string) => {
    did.push('cascade restored');
    await ctx.db.update(tenants).set({ status: 'active', archivedAt: null }).where(eq(tenants.id, tenantId));
    return 'transition-2';
  },
  // What it does and does not run again is cascade-once.integration.test.ts's;
  // here: that a picked-up run asks for this, with the operation's own start.
  applyOnceSince: async (
    ctx: { db: Database; suppressTenantNotification?: boolean },
    tenantId: string,
    _ns: string,
    transition: 'archived' | 'restored' | 'suspended' | 'active',
    since: Date,
  ) => {
    // The tenant's newest operation is the one being picked up.
    const [op] = await ctx.db.select({ createdAt: storageOperations.createdAt }).from(storageOperations)
      .where(eq(storageOperations.tenantId, tenantId)).orderBy(desc(storageOperations.createdAt)).limit(1);
    did.push(`cascade ${transition}, once${since.getTime() === op?.createdAt.getTime() ? ' since the operation began' : ' SINCE THE WRONG MOMENT'}`
      + (ctx.suppressTenantNotification ? ', the tenant not told' : ''));
    await gate;
    failing('cascade');
    const status = { archived: 'archived', suspended: 'suspended', restored: 'active', active: 'active' } as const;
    await ctx.db.update(tenants)
      .set({ status: status[transition], ...(transition === 'archived' ? { archivedAt: new Date() } : {}), ...(status[transition] === 'active' ? { archivedAt: null } : {}) })
      .where(eq(tenants.id, tenantId));
    return 'transition-3';
  },
}));
vi.mock('../notifications/events.js', () => ({
  notifyAdminOperationalEvent: async (_db: unknown, subsystem: string, payload: Record<string, unknown>, dedupeKey?: string) => {
    told.push({ subsystem, payload, dedupeKey });
  },
}));
vi.mock('../file-manager/idle-cleanup.js', () => ({ recordFileManagerAccess: () => undefined }));
/** Whether the tenant's file manager can be started, and what its mount does to the claim. */
let fileManager: { starts: boolean; stopped: boolean; onMount: () => void } = { starts: true, stopped: false, onMount: () => undefined };
vi.mock('../file-manager/lease.js', () => ({
  acquireFileManagerLease: async (_k8s: unknown, namespace: string, purpose: string) => {
    did.push(`hold the file manager of ${namespace} for ${purpose}`);
    if (!fileManager.starts) throw new Error('File manager not ready: timeout');
    fileManager.onMount();
    return { podName: 'file-manager-1', currentPod: async () => 'file-manager-1', release: async () => { did.push('hand the file manager back'); } };
  },
}));

const {
  findInterruptedOperations, pickUpInterruptedOperations, everyPodRunsTheSameRelease,
  DEAD_HOLDER_GRACE_MS, UNLOCKED_GRACE_MS,
} = await import('./interrupted-ops.js');
const { opLockJob, operationIsMine, OP_MAX_RESUMES } = await import('./op-lock.js');
const { sweepAbandonedQuiesce } = await import('./quiesce-watchdog.js');
const { cancelStorageOperation, resumeOperation } = await import('./service.js');

const dbAvailable = await isDbAvailable();
const notFound = (): never => { throw Object.assign(new Error('not found'), { statusCode: 404 }); };

describe('which API processes are this release', () => {
  const pod = (name: string, image: string, phase = 'Running') => ({ metadata: { name }, spec: { containers: [{ image }] }, status: { phase } });

  it('every pod on this process\'s image: one release', () => {
    expect(everyPodRunsTheSameRelease([pod('api-1', 'api:2'), pod('api-2', 'api:2')], 'api-1')).toBe(true);
  });

  it('a pod of another image is still listed — on its way out or not — so an operation without a lock may be its', () => {
    expect(everyPodRunsTheSameRelease([pod('api-1', 'api:2'), pod('api-old', 'api:1')], 'api-1')).toBe(false);
    expect(everyPodRunsTheSameRelease([pod('api-1', 'api:2'), pod('api-old', 'api:1', 'Pending')], 'api-1')).toBe(false);
  });

  it.each(['Succeeded', 'Failed'])('a pod that has %s runs nothing and does not count', (phase) => {
    expect(everyPodRunsTheSameRelease([pod('api-1', 'api:2'), pod('api-old', 'api:1', phase)], 'api-1')).toBe(true);
  });

  it('cannot tell when this process is not one of the pods, or has no image to compare: null, never true', () => {
    expect(everyPodRunsTheSameRelease([pod('api-1', 'api:2'), pod('api-2', 'api:2')], 'my-laptop')).toBeNull();
    expect(everyPodRunsTheSameRelease([], 'api-1')).toBeNull();
    expect(everyPodRunsTheSameRelease([{ metadata: { name: 'api-1' }, spec: { containers: [] }, status: { phase: 'Running' } }], 'api-1')).toBeNull();
  });
});

describe.skipIf(!dbAvailable)('storage operations interrupted by a restart (real Postgres)', () => {
  const db = () => getTestDb() as unknown as Database;
  let regionId = '';
  let planId = '';
  const log: string[] = [];
  /** The tenant's claim as the stand-in cluster has it; null when absent. */
  let claim: { request: string; storageClass: string; volumeName: string; capacity?: string } | null = null;
  /** A grow extends the block device only; the filesystem — and the claim's capacity — waits for a mount. */
  let growAwaitsMount = false;
  /** The API pods the stand-in cluster lists. */
  let apiPods: Array<{ name: string; image: string }> = [];
  /** Namespaces whose Deployments carry the quiesce hold, as the watchdog's leftover leg lists them. */
  let heldNamespaces: string[] = [];
  let claimUnreadable = false;

  const k8s = {
    apps: {
      listNamespacedDeployment: async () => ({ items: [] }),
      listDeploymentForAllNamespaces: async () => ({
        items: heldNamespaces.map((namespace) => ({ metadata: { namespace, annotations: { 'insula.host/storage-quiesced': 'true' } } })),
      }),
      readNamespacedDeployment: async ({ name }: { name: string }) => (name === 'file-manager' && fileManager.stopped
        ? { metadata: { annotations: { 'insula.host/storage-quiesced': 'true' } } }
        : notFound()),
    },
    batch: {
      listNamespacedCronJob: async () => ({ items: [] }),
      listNamespacedJob: async ({ labelSelector }: { labelSelector?: string }) => ({
        items: [
          ...(labelSelector?.includes('component=fsck') && leftFsckJob ? [{ metadata: { name: leftFsckJob } }] : []),
          ...(labelSelector?.includes('pre-resize-bundle') && leftRestoreJob ? [{ metadata: { name: leftRestoreJob } }] : []),
        ],
      }),
      deleteNamespacedJob: async ({ name }: { name: string }) => { did.push(`delete job ${name}`); },
    },
    core: {
      listNamespacedService: async () => ({ items: [] }),
      listNamespacedPod: async () => ({
        items: apiPods.map((p) => ({ metadata: { name: p.name }, spec: { containers: [{ image: p.image }] }, status: { phase: 'Running' } })),
      }),
      readNamespacedPersistentVolumeClaim: async () => {
        if (claimUnreadable) throw Object.assign(new Error('the API server did not answer'), { statusCode: 503 });
        return claim
        ? {
          metadata: {},
          spec: { storageClassName: claim.storageClass, volumeName: claim.volumeName, resources: { requests: { storage: claim.request } } },
          status: {
            phase: 'Bound',
            capacity: { storage: claim.capacity ?? claim.request },
            conditions: claim.capacity && claim.capacity !== claim.request ? [{ type: 'FileSystemResizePending', status: 'True' }] : [],
          },
        }
        : notFound();
      },
      deleteNamespacedPersistentVolumeClaim: async ({ name }: { name: string }) => {
        if (!claim) notFound();
        did.push(`delete claim ${name}`);
        claim = null;
      },
      createNamespacedPersistentVolumeClaim: async ({ body }: { body: { spec: { storageClassName: string; volumeName?: string; resources: { requests: { storage: string } } } } }) => {
        failing('create claim');
        did.push(`create claim ${body.spec.resources.requests.storage} ${body.spec.storageClassName}${body.spec.volumeName ? ` on ${body.spec.volumeName}` : ''}`);
        claim = { request: body.spec.resources.requests.storage, storageClass: body.spec.storageClassName, volumeName: body.spec.volumeName ?? 'pv-new' };
      },
      patchNamespacedPersistentVolumeClaim: async ({ body }: { body: { spec: { resources: { requests: { storage: string } } } } }) => {
        did.push(`grow claim to ${body.spec.resources.requests.storage}`);
        if (claim) claim = { ...claim, request: body.spec.resources.requests.storage, ...(growAwaitsMount ? { capacity: claim.capacity ?? claim.request } : {}) };
      },
      readPersistentVolume: async () => ({
        spec: { capacity: { storage: '20Gi' }, storageClassName: 'longhorn-tenant', csi: { volumeAttributes: { fsType: 'xfs' } } },
        status: { phase: 'Available' },
      }),
      patchPersistentVolume: async ({ name }: { name: string }) => { did.push(`free volume ${name} for a new claim`); },
      patchNamespacedResourceQuota: async () => undefined,
    },
    custom: {
      getNamespacedCustomObject: async () => ({
        status: { state: volume.state, frontendDisabled: volume.frontendDisabled, currentNodeID: volume.state === 'attached' ? volume.node : '', ownerID: volume.node },
      }),
      patchNamespacedCustomObject: async ({ body }: { body: { spec: { attachmentTickets: Record<string, unknown> } } }) => {
        const attach = Object.values(body.spec.attachmentTickets)[0] !== null;
        did.push(attach ? 'attach volume for the check' : 'release the check\'s attach');
        volume = { ...volume, state: attach ? 'attached' : 'detached' };
      },
    },
  } as unknown as K8sClients;

  beforeAll(async () => { await runMigrations(); });
  afterAll(async () => { await closeTestDb(); });
  beforeEach(async () => {
    await cleanTables();
    await db().execute(sql.raw('TRUNCATE TABLE backup_jobs CASCADE'));
    await db().execute(sql.raw(`DELETE FROM platform_settings WHERE setting_key LIKE 'scheduler-lease:%'`));
    regionId = (await seedRegion(db())).id;
    planId = (await seedPlan(db())).id;
    did.length = 0; log.length = 0;
    captureOutcome = { status: 'completed' }; gate = null; leftFsckJob = null; leftRestoreJob = null;
    fails = null; atUnquiesce = null; told.length = 0; heldNamespaces = []; claimUnreadable = false;
    growAwaitsMount = false; fileManager = { starts: true, stopped: false, onMount: () => undefined };
    volume = { state: 'detached', frontendDisabled: false, node: 'node-a' };
    claim = { request: '20Gi', storageClass: 'longhorn-tenant', volumeName: 'pv-old' };
    apiPods = [];
  });

  const key = (job: string): string => `scheduler-lease:${runLockName(job)}`;
  /** A lock row as a process leaves it: `seconds` ahead (negative: lapsed that long ago). */
  const lockAt = (job: string, seconds: number, holder = 'replica-that-died') => db().execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value)
    VALUES (${key(job)}, json_build_object('holder', ${holder}::text, 'until', now() + make_interval(secs => ${seconds}))::text)
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`);
  const lock = (opId: string, seconds: number, holder?: string) => lockAt(opLockJob(opId), seconds, holder);
  const lockRow = async (job: string): Promise<{ holder: string } | null> => {
    const res = await db().execute(sql`SELECT setting_value FROM platform_settings WHERE setting_key = ${key(job)}`) as unknown as { rows: Array<{ setting_value: string }> };
    return res.rows[0] ? JSON.parse(res.rows[0].setting_value) as { holder: string } : null;
  };

  type OpType = typeof storageOperations.$inferInsert['opType'];
  type OpState = typeof storageOperations.$inferInsert['state'];
  interface InFlight { tenantId: string; opId: string; snapId: string | null; namespace: string }
  const WRITTEN = { deployments: [{ name: 'web', replicas: 2 }], cronJobs: [] };

  /** A tenant with an operation in flight, as its rows stand at the given step. */
  const inFlight = async (opType: OpType, over: {
    state?: OpState;
    params?: Record<string, unknown>;
    snapshot?: 'pre-archive' | 'pre-resize';
    captured?: string;                       // the bundle the snapshot row already points at
    tenantStatus?: 'active' | 'suspended' | 'archived';
    minutesOld?: number;
    active?: boolean;
  } = {}): Promise<InFlight> => {
    const tenant = await seedTenant(db(), regionId, planId, {
      status: over.tenantStatus ?? 'active',
      ...(over.tenantStatus === 'suspended' ? { suspendedAt: new Date(Date.now() - 40 * 86_400_000) } : {}),
      ...(over.tenantStatus === 'archived' ? { archivedAt: new Date(Date.now() - 86_400_000) } : {}),
    });
    const opId = crypto.randomUUID();
    const snapId = over.snapshot ? crypto.randomUUID() : null;
    const state = over.state ?? 'quiescing';
    if (snapId && over.snapshot) {
      await db().insert(storageSnapshots).values({
        id: snapId, tenantId: tenant.id, kind: over.snapshot,
        status: over.captured ? 'ready' : 'creating',
        archivePath: over.captured ? `bundle:${over.captured}` : 'bundle:pending',
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
      });
    }
    await db().insert(storageOperations).values({
      id: opId, tenantId: tenant.id, opType, state,
      snapshotId: snapId,
      params: { quiesceSnapshot: WRITTEN, ...over.params },
      createdAt: new Date(Date.now() - (over.minutesOld ?? 30) * 60_000),
      ...(state === 'idle' || state === 'failed' ? { completedAt: new Date() } : {}),
    });
    await db().update(tenants)
      .set({ storageLifecycleState: state, activeStorageOpId: over.active === false ? null : opId })
      .where(eq(tenants.id, tenant.id));
    return { tenantId: tenant.id, opId, snapId, namespace: tenant.kubernetesNamespace };
  };
  const archive = (over: Parameters<typeof inFlight>[1] = {}) => inFlight('archive', {
    snapshot: 'pre-archive', tenantStatus: 'suspended', state: 'snapshotting', ...over, params: { retentionDays: 90, ...over.params },
  });
  const shrink = (over: Parameters<typeof inFlight>[1] = {}) => inFlight('resize', {
    snapshot: 'pre-resize', state: 'snapshotting', ...over, params: { fromMib: 20480, toMib: 10240, mode: 'destructive', ...over.params },
  });

  const op = async (opId: string) => (await db().select().from(storageOperations).where(eq(storageOperations.id, opId)))[0];
  const tenantRow = async (id: string) => (await db().select().from(tenants).where(eq(tenants.id, id)))[0];
  const snapshot = async (id: string | null) => (await db().select().from(storageSnapshots).where(eq(storageSnapshots.id, id ?? '')))[0];
  /** Wait for a detached operation to end, either way. */
  const ended = async (opId: string) => {
    for (let i = 0; i < 150; i += 1) {
      const row = await op(opId);
      if (row?.completedAt) {
        // The lock is given back a moment after the last write.
        for (let j = 0; j < 50 && await lockRow(opLockJob(opId)); j += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
        return row;
      }
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    throw new Error(`operation ${opId} did not end; it did: ${did.join(' | ')}`);
  };
  const reached = async (step: string) => {
    for (let i = 0; i < 150 && !did.some((d) => d.startsWith(step)); i += 1) await new Promise((r) => { setTimeout(r, 20); });
    expect(did.some((d) => d.startsWith(step)), `never reached "${step}": ${did.join(' | ')}`).toBe(true);
  };
  const pickUp = () => pickUpInterruptedOperations(db(), k8s, {}, (line) => { log.push(line); });
  /** The database, with something happening right after its first raw query — the finder's look, or a lock's claim. */
  const racing = (then: () => Promise<unknown>): Database => {
    const real = db().execute.bind(db());
    let first = true;
    return new Proxy(db(), {
      get: (target, prop, receiver) => (prop === 'execute'
        ? async (query: unknown) => {
          const res = await real(query as Parameters<typeof real>[0]);
          if (first) { first = false; await then(); }
          return res;
        }
        : Reflect.get(target, prop, receiver)),
    }) as Database;
  };
  const found = async () => (await findInterruptedOperations(db())).map((o) => o.opId);
  const DEAD = -(DEAD_HOLDER_GRACE_MS / 1000) - 60;

  describe('which operations are taken for interrupted', () => {
    it.each<OpType>(['archive', 'resize', 'restore', 'fsck'])('a %s in flight whose lock lapsed more than the grace ago', async (kind) => {
      const a = await inFlight(kind);
      await lock(a.opId, DEAD);
      expect(await findInterruptedOperations(db())).toEqual([
        { opId: a.opId, opType: kind, tenantId: a.tenantId, namespace: a.namespace, unlocked: false },
      ]);
    });

    it.each<[string, number]>([
      ['its lock is held', 90],
      ['its lock lapsed only a moment ago — a holder late renewing is not a dead one', -10],
    ])('not one in flight when %s', async (_why, seconds) => {
      const a = await inFlight('resize');
      await lock(a.opId, seconds);
      expect(await found()).toEqual([]);
    });

    it('one with no lock at all, once it has been without for minutes — and says that it has none', async () => {
      const a = await inFlight('restore', { minutesOld: UNLOCKED_GRACE_MS / 60_000 + 1 });
      expect(await findInterruptedOperations(db())).toEqual([expect.objectContaining({ opId: a.opId, unlocked: true })]);
    });

    it.each<[string, number]>([
      ['it has only just begun — its starter takes the lock a moment after writing the claim', 1],
      ['it is older than the age rule: its lock was given up as hung, and the work may still be going on', 6 * 60 + 5],
    ])('not one with no lock when %s', async (_why, minutesOld) => {
      await inFlight('restore', { minutesOld });
      expect(await found()).toEqual([]);
    });

    it.each<OpType>(['suspend', 'resume'])('a %s is read from its tenant\'s lock, which it holds for as long as it runs', async (kind) => {
      const a = await inFlight(kind);
      await lock(a.opId, DEAD);                                     // not its lock: says nothing
      await lockAt(tenantLockJob(a.tenantId), 90);
      expect(await found()).toEqual([]);
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      expect(await found()).toEqual([a.opId]);
    });

    it.each<[string, OpType, Parameters<typeof inFlight>[1]]>([
      ['an operation that has ended', 'resize', { state: 'idle' }],
      ['an operation that has failed', 'fsck', { state: 'failed' }],
      ['a move, which has its own rule', 'relocate', {}],
      ['an operation that is no longer its tenant\'s active one', 'restore', { active: false }],
    ])('not %s, whatever its lock says', async (_what, kind, over) => {
      const a = await inFlight(kind, over);
      await lock(a.opId, DEAD);
      expect(await found()).toEqual([]);
      await db().execute(sql`DELETE FROM platform_settings WHERE setting_key = ${key(opLockJob(a.opId))}`);
      expect(await found()).toEqual([]);
    });

    it('a lock row that cannot be read is not a reason to pick up, and not an error', async () => {
      const a = await inFlight('resize');
      for (const value of ['not json', '{}', '{"holder":"x","until":"soon"}']) {
        await db().execute(sql`INSERT INTO platform_settings (setting_key, setting_value) VALUES (${key(opLockJob(a.opId))}, ${value})
          ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`);
        expect(await found(), value).toEqual([]);
      }
    });

    it('the oldest first', async () => {
      const young = await inFlight('fsck', { minutesOld: 60 });
      const old = await inFlight('resize', { minutesOld: 180 });
      await lock(young.opId, DEAD);
      await lock(old.opId, DEAD);
      expect(await found()).toEqual([old.opId, young.opId]);
    });
  });

  describe('an operation with no lock at all', () => {
    const unlocked = () => shrink({ minutesOld: 10, captured: 'bkp-1' });

    it('is left alone while an API process of another release exists: that one may be running it', async () => {
      const a = await unlocked();
      apiPods = [{ name: REPLICA_ID.split(':')[0], image: 'api:2' }, { name: 'api-old', image: 'api:1' }];
      expect(await pickUp()).toEqual({ resumed: 0, ended: 0, leftAlone: 1 });
      expect(did).toEqual([]);
      expect((await op(a.opId)).state).toBe('snapshotting');
      expect(log[0]).toContain('an API process of another release may be running it');
    });

    it('is left alone when it cannot be told which releases are running', async () => {
      await unlocked();
      apiPods = [{ name: 'some-other-pod', image: 'api:2' }];
      expect(await pickUp()).toEqual({ resumed: 0, ended: 0, leftAlone: 1 });
      expect(did).toEqual([]);
    });

    it('is picked up once every API process is this release', async () => {
      const a = await unlocked();
      apiPods = [{ name: REPLICA_ID.split(':')[0], image: 'api:2' }, { name: 'api-2', image: 'api:2' }];
      expect(await pickUp()).toEqual({ resumed: 1, ended: 0, leftAlone: 0 });
      expect((await ended(a.opId)).state).toBe('idle');
    });
  });

  describe('picking up, whatever the kind', () => {
    it('holds the lock under this process\'s own name while it works, so no other watchdog takes it too', async () => {
      const a = await archive();
      await lock(a.opId, DEAD);
      let finish: () => void = () => {};
      gate = new Promise<void>((resolve) => { finish = resolve; });
      expect(await pickUp()).toEqual({ resumed: 1, ended: 0, leftAlone: 0 });
      await reached('capture');
      expect((await lockRow(opLockJob(a.opId)))?.holder).toBe(REPLICA_ID);
      expect(await found()).toEqual([]);                             // held: nobody's to pick up
      expect(await pickUp()).toEqual({ resumed: 0, ended: 0, leftAlone: 0 });
      finish();
      const done = await ended(a.opId);
      expect(done).toMatchObject({ state: 'idle', progressPct: 100 });
      expect((done.params as { resumes: number }).resumes).toBe(1);
      expect(did.filter((d) => d === 'capture')).toHaveLength(1);
      expect(await lockRow(opLockJob(a.opId))).toBeNull();
      expect(log).toEqual([`archive ${a.opId} had no live process behind it — picked up again`]);
    });

    it('never takes over one whose holder was only slow and has the lock again', async () => {
      const a = await shrink();
      await lock(a.opId, DEAD);
      const interrupted = await findInterruptedOperations(db());
      await lock(a.opId, 90, 'the-slow-holder');                     // it renewed between the look and the pick-up
      expect(interrupted).toHaveLength(1);
      const { resumeOperation } = await import('./service.js');
      expect(await resumeOperation({ db: db(), k8s }, a.opId)).toBe('held');
      expect(did).toEqual([]);
      expect((await op(a.opId)).params).not.toHaveProperty('resumes');
    });

    it.each<[string, Parameters<typeof inFlight>[1]]>([
      ['has ended', { state: 'idle' }],
      ['has failed', { state: 'failed' }],
      ['is no longer its tenant\'s', { active: false }],
    ])('does nothing to an operation that %s by the time it is looked at', async (_what, over) => {
      const a = await shrink({ captured: 'bkp-1', ...over });
      expect(await resumeOperation({ db: db(), k8s }, a.opId)).toBe('ended');
      expect(did).toEqual([]);
      expect(await lockRow(opLockJob(a.opId))).toBeNull();
      expect((await op(a.opId)).params).not.toHaveProperty('resumes');
    });

    it('writes nothing on one that finished between the look and the lock: the run that was only slow was still at it', async () => {
      const a = await shrink({ captured: 'bkp-1', state: 'unquiescing' });
      const finishedMeanwhile = racing(() => db().update(storageOperations)
        .set({ state: 'idle', progressMessage: 'Resize complete', completedAt: new Date() }).where(eq(storageOperations.id, a.opId)));
      await resumeOperation({ db: finishedMeanwhile, k8s }, a.opId);
      for (let j = 0; j < 100 && await lockRow(opLockJob(a.opId)); j += 1) await new Promise((r) => { setTimeout(r, 20); });
      expect(did).toEqual([]);
      const row = await op(a.opId);
      expect(row.progressMessage).toBe('Resize complete');
      expect(row.params).not.toHaveProperty('resumes');
    });

    it('cut off while its workloads were starting, with the replica counts gone: it fails and says so — not "done" with the tenant at zero', async () => {
      const a = await shrink({ captured: 'bkp-1', state: 'unquiescing' });
      await db().update(storageOperations).set({ params: { fromMib: 20480, toMib: 10240, mode: 'destructive' } }).where(eq(storageOperations.id, a.opId));
      claim = { request: '10Gi', storageClass: 'longhorn-tenant', volumeName: 'pv-new' };
      await lock(a.opId, DEAD);
      await pickUp();
      const row = await ended(a.opId);
      expect(row.state).toBe('failed');
      expect(row.lastError).toContain('replica counts written down for this operation could not be read');
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'failed' });
    });

    it('ends one that was picked up as often as an operation is: failed, and the workloads back at the counts written down', async () => {
      const a = await shrink({ captured: 'bkp-1', params: { resumes: OP_MAX_RESUMES } });
      await lock(a.opId, DEAD);
      expect(await pickUp()).toEqual({ resumed: 0, ended: 1, leftAlone: 0 });
      expect(did).toEqual(['unquiesce to web=2']);
      const row = await op(a.opId);
      expect(row.state).toBe('failed');
      expect(row.lastError).toContain('picked up again more than once and interrupted each time');
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'failed', activeStorageOpId: null });
      expect(await lockRow(opLockJob(a.opId))).toBeNull();
    });

    it('ends one whose row does not say how to run it again, rather than leaving its tenant stopped for hours', async () => {
      const a = await inFlight('restore', { params: { mode: 'a-mode-of-a-later-release' } });
      await lock(a.opId, DEAD);
      expect(await pickUp()).toEqual({ resumed: 0, ended: 1, leftAlone: 0 });
      expect((await op(a.opId)).lastError).toContain('could not be picked up again');
      expect(did).toEqual(['unquiesce to web=2']);
    });

    it('a run that stalled and wakes after its successor has finished finds the operation is not its own — even holding the lock', async () => {
      const a = await shrink({ state: 'idle' });
      // Its renewal wrote the lock again, under its own name, after the successor let go.
      await lock(a.opId, 90, REPLICA_ID);
      expect(await operationIsMine(db(), a.opId)).toBe(false);
      const b = await shrink();
      await lock(b.opId, 90, REPLICA_ID);
      expect(await operationIsMine(db(), b.opId)).toBe(true);
      await lock(b.opId, 90, 'another-replica');
      expect(await operationIsMine(db(), b.opId)).toBe(false);
    });

    it('an operator\'s cancel stops the run: it does not go on, fail a second time and mark the tenant failed', async () => {
      const a = await shrink();
      await lock(a.opId, DEAD);
      let finish: () => void = () => {};
      gate = new Promise<void>((resolve) => { finish = resolve; });
      await pickUp();
      await reached('capture');
      // A run that is past its question and about to act must find the
      // operation ended before the workloads this cancel starts are running.
      atUnquiesce = async () => { did.push(`the operation reads ${(await op(a.opId)).state} as the workloads are started`); };
      await cancelStorageOperation({ db: db(), k8s, store: {} as never, platformNamespace: 'platform' }, a.tenantId);
      expect(did.slice(-3)).toEqual(['the operation reads failed as the workloads are started', 'unquiesce to web=2', 'clear hold']);
      const before = did.length;
      finish();
      for (let j = 0; j < 100 && await lockRow(opLockJob(a.opId)); j += 1) await new Promise((r) => { setTimeout(r, 20); });
      expect(did.slice(before)).toEqual([]);                         // no delete, no restore, no second unquiesce
      expect((await op(a.opId)).lastError).toContain('Cancelled by operator');
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'idle', activeStorageOpId: null });
    });
  });

  describe('an archive picked up again', () => {
    it('runs to its end: the tenant archived, the capture noted, the lock given back', async () => {
      const a = await archive();
      await lock(a.opId, DEAD);
      await pickUp();
      await ended(a.opId);
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'archived', storageLifecycleState: 'idle', activeStorageOpId: null });
      expect(await snapshot(a.snapId)).toMatchObject({ status: 'ready', archivePath: 'bundle:bkp-new', sizeBytes: '4242' });
      expect(did).toEqual(['quiesce', 'capture', `delete claim ${a.namespace}-storage`, 'cascade archived, once since the operation began']);
    });

    it('does not write the replica counts down again — they would all be zero — and restores the first ones if it fails', async () => {
      const a = await archive();
      await lock(a.opId, DEAD);
      captureOutcome = new Error('the backup target did not answer');
      await pickUp();
      const done = await ended(a.opId);
      expect(done.state).toBe('failed');
      expect(did).toEqual(['quiesce', 'capture', 'unquiesce to web=2']);
      expect((done.params as { quiesceSnapshot: typeof WRITTEN }).quiesceSnapshot).toEqual(WRITTEN);
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'suspended', storageLifecycleState: 'failed' });
    });

    it('writes the counts down when the first process died before it had', async () => {
      const a = await archive({ state: 'quiescing' });
      await db().update(storageOperations).set({ params: { retentionDays: 90 } }).where(eq(storageOperations.id, a.opId));
      await lock(a.opId, DEAD);
      await pickUp();
      await ended(a.opId);
      expect(did[0]).toBe('quiesce (writing the counts down)');
    });

    /** The bundle a first run recorded, as its capture wrote it. */
    const capturedBundle = (id: string, tenantId: string, systemTrigger: 'pre_archive' | 'pre_resize') => db().insert(backupJobs).values({
      id, tenantId, initiator: 'system', systemTrigger, status: 'completed',
      targetKind: 's3', targetUri: 's3://example.test/b', retentionDays: 90,
    });

    it('does not take a capture that is already there', async () => {
      const taken = await archive({ captured: 'bkp-first', state: 'replacing' });
      await capturedBundle('bkp-first', taken.tenantId, 'pre_archive');
      await lock(taken.opId, DEAD);
      await pickUp();
      await ended(taken.opId);
      expect(did).not.toContain('capture');
      expect((await snapshot(taken.snapId)).archivePath).toBe('bundle:bkp-first');
    });

    it('takes a whole capture when the first run, from before archives were whole, left a files-only one and the volume is still there', async () => {
      const taken = await archive({ captured: 'bkp-files-only', state: 'replacing' });
      await capturedBundle('bkp-files-only', taken.tenantId, 'pre_resize');
      await lock(taken.opId, DEAD);
      await pickUp();
      await ended(taken.opId);
      expect(did).toContain('capture');
      expect((await snapshot(taken.snapId)).archivePath).toBe('bundle:bkp-new');
    });

    it.each<[string, () => Promise<InFlight>, 'pre_archive' | 'pre_resize']>([
      ['an archive', () => archive(), 'pre_archive'],
      ['a shrink', () => shrink(), 'pre_resize'],
    ])('%s fails the capture the dead process was in the middle of, removes its Job, and touches no other bundle', async (_kind, start, trigger) => {
      const a = await start();
      const other = await seedTenant(db(), regionId, planId);
      const bundle = (id: string, tenantId: string, over: Partial<typeof backupJobs.$inferInsert> = {}) => db().insert(backupJobs).values({
        id, tenantId, initiator: 'system', systemTrigger: trigger, status: 'running',
        targetKind: 's3', targetUri: 's3://example.test/b', retentionDays: 90, createdAt: new Date(Date.now() - 20 * 60_000), ...over,
      });
      await bundle('bkp-cut-off', a.tenantId);
      await bundle('bkp-before-the-operation', a.tenantId, { createdAt: new Date(Date.now() - 5 * 3_600_000) });
      await bundle('bkp-operators-own', a.tenantId, { initiator: 'admin', systemTrigger: null });
      await bundle('bkp-not-the-systems', a.tenantId, { initiator: 'admin' });       // same trigger, but nobody's operation
      await bundle('bkp-done', a.tenantId, { status: 'completed' });
      await bundle('bkp-another-tenant', other.id);
      await lock(a.opId, DEAD);
      await pickUp();
      await ended(a.opId);
      const rows = await db().select({ id: backupJobs.id, status: backupJobs.status, lastError: backupJobs.lastError }).from(backupJobs);
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
        'bkp-cut-off': 'failed',
        'bkp-before-the-operation': 'running',
        'bkp-operators-own': 'running',
        'bkp-not-the-systems': 'running',
        'bkp-done': 'completed',
        'bkp-another-tenant': 'running',
      });
      expect(rows.find((r) => r.id === 'bkp-cut-off')?.lastError).toContain('the platform API restarted');
      expect(did.filter((d) => d.startsWith('delete job'))).toEqual(['delete job bk-files-bkp-cut-off']);
      expect(did.indexOf('delete job bk-files-bkp-cut-off')).toBeLessThan(did.indexOf('capture'));
    });

    it.each<[string, () => Promise<InFlight>]>([
      ['an archive', () => archive()],
      ['a shrink', () => shrink()],
    ])('%s refuses to remove the volume when the second capture is not complete either', async (_kind, start) => {
      const a = await start();
      await lock(a.opId, DEAD);
      captureOutcome = { status: 'partial' };
      await pickUp();
      const row = await ended(a.opId);
      expect(row.state).toBe('failed');
      expect(row.lastError).toContain("finished 'partial'");
      expect(did).toEqual(['quiesce', 'capture', 'unquiesce to web=2']);
      expect(claim).not.toBeNull();
    });

    it('asks for the cascades once more even when the tenant reads archived: its status is stamped by one hook, with others after it', async () => {
      const a = await archive({ captured: 'bkp-first', state: 'archiving', tenantStatus: 'archived' });
      claim = null;                                                   // deleted by the first run
      await lock(a.opId, DEAD);
      await pickUp();
      await ended(a.opId);
      expect(did).toEqual(['quiesce', 'cascade archived, once since the operation began']);
      expect(did).not.toContain('cascade archived');                 // never the plain one, which would run every hook again
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'archived', storageLifecycleState: 'idle' });
    });
  });

  describe('a shrink picked up again', () => {
    const done = async (a: InFlight) => {
      const row = await ended(a.opId);
      expect(row, row.lastError ?? '').toMatchObject({ state: 'idle', progressPct: 100 });
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'idle', activeStorageOpId: null, storageLimitOverride: '10.00' });
      expect(await snapshot(a.snapId)).toMatchObject({ status: 'expired' });
    };

    it('cut off while capturing: takes the capture again, then replaces the volume and restores into it', async () => {
      const a = await shrink();
      await lock(a.opId, DEAD);
      await pickUp();
      await done(a);
      expect(did).toEqual([
        'quiesce', 'capture', `delete claim ${a.namespace}-storage`, 'create claim 10Gi longhorn-tenant',
        'restore bkp-new (looking for the Job left behind)', 'unquiesce to web=2', 'reap bundle',
      ]);
    });

    it('cut off after the old volume was deleted: the files are in the bundle only — it creates the new one, of the class noted, and restores', async () => {
      const a = await shrink({ captured: 'bkp-1', state: 'replacing', params: { storageClass: 'longhorn-tenant-ha' } });
      claim = null;
      await lock(a.opId, DEAD);
      await pickUp();
      await done(a);
      expect(did).toEqual([
        'quiesce', 'create claim 10Gi longhorn-tenant-ha', 'restore bkp-1 (looking for the Job left behind)', 'unquiesce to web=2', 'reap bundle',
      ]);
    });

    it('cut off while restoring: the new volume is there — it is not deleted a second time, with the files half in it', async () => {
      const a = await shrink({ captured: 'bkp-1', state: 'restoring', params: { storageClass: 'longhorn-tenant' } });
      claim = { request: '10Gi', storageClass: 'longhorn-tenant', volumeName: 'pv-new' };
      await lock(a.opId, DEAD);
      await pickUp();
      await done(a);
      expect(did).toEqual(['quiesce', 'restore bkp-1 (looking for the Job left behind)', 'unquiesce to web=2', 'reap bundle']);
    });

    it('cut off after the workloads were started again: they are not stopped and the bundle is not written over what they did since', async () => {
      const a = await shrink({ captured: 'bkp-1', state: 'unquiescing' });
      claim = { request: '10Gi', storageClass: 'longhorn-tenant', volumeName: 'pv-new' };
      await lock(a.opId, DEAD);
      await pickUp();
      await done(a);
      expect(did).toEqual(['unquiesce to web=2', 'reap bundle']);
    });

    it.each<[string, typeof claim]>([
      ['the old volume is gone', null],
      ['the volume there is already the new one', { request: '10Gi', storageClass: 'longhorn-tenant', volumeName: 'pv-new' }],
    ])('with no capture and %s, it fails rather than capture an empty volume as the tenant\'s files', async (_why, now) => {
      const a = await shrink();
      claim = now;
      await lock(a.opId, DEAD);
      await pickUp();
      const row = await ended(a.opId);
      expect(row.state).toBe('failed');
      expect(row.lastError).toContain('refusing to continue');
      expect(did).toEqual(['quiesce', 'unquiesce to web=2']);
      expect(await snapshot(a.snapId)).toMatchObject({ status: 'failed' });
    });
  });

  describe('the other kinds picked up again', () => {
    it('an online grow: asks for the size again, which changes nothing when it was already asked for', async () => {
      const a = await inFlight('resize', { state: 'resizing', params: { fromMib: 20480, toMib: 30720, mode: 'grow_online' } });
      await lock(a.opId, DEAD);
      await pickUp();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['grow claim to 30Gi']);
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'idle', storageLimitOverride: '30.00' });
    });

    const grow = () => inFlight('resize', { state: 'resizing', params: { fromMib: 20480, toMib: 30720, mode: 'grow_online' } });

    it('an online grow of a tenant with no running pod: the file manager is held so the filesystem can grow, and handed back', async () => {
      const a = await grow();
      growAwaitsMount = true;
      fileManager.onMount = () => { if (claim) claim = { ...claim, capacity: claim.request }; };
      await lock(a.opId, DEAD);
      await pickUp();
      const row = await ended(a.opId);
      expect(did).toEqual(['grow claim to 30Gi', `hold the file manager of ${a.namespace} for storage-grow`, 'hand the file manager back']);
      expect(row).toMatchObject({ state: 'idle', progressMessage: 'Grew 20480 → 30720 MiB online (no downtime)' });
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'idle', storageLimitOverride: '30.00' });
    });

    it('an online grow of a tenant whose workloads are stopped — suspended: done, its file manager left stopped, and it says the filesystem grows at the next start', async () => {
      const a = await grow();
      growAwaitsMount = true;
      fileManager.stopped = true;
      await lock(a.opId, DEAD);
      await pickUp();
      const row = await ended(a.opId);
      expect(did).toEqual(['grow claim to 30Gi']);                    // nothing is started over the hold
      expect(row.state).toBe('idle');
      expect(row.lastError).toBeNull();
      expect(row.progressMessage).toBe('Volume extended 20480 → 30720 MiB. No pod of the tenant mounts it now (its workloads are stopped), so its filesystem grows to the new size when the next one starts.');
      // The limit follows the claim, which already asks for the new size.
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'idle', activeStorageOpId: null, storageLimitOverride: '30.00' });
    });

    it('an online grow whose file manager cannot be started: tried again, then done — and the reason is in what it says', async () => {
      const a = await grow();
      growAwaitsMount = true;
      fileManager.starts = false;
      await lock(a.opId, DEAD);
      await pickUp();
      const row = await ended(a.opId);
      expect(did.filter((d) => d.startsWith('hold the file manager'))).toHaveLength(3);
      expect(row.state).toBe('idle');
      expect(row.progressMessage).toContain('(its file manager could not be started: File manager not ready: timeout)');
      expect(row.progressMessage).toContain('grows to the new size when the next one starts');
    }, 20_000);

    it('an online grow that fails still hands the file manager back', async () => {
      const a = await grow();
      growAwaitsMount = true;
      fileManager.onMount = () => { claimUnreadable = true; };
      await lock(a.opId, DEAD);
      await pickUp();
      const row = await ended(a.opId);
      expect(row.state).toBe('failed');
      expect(did).toContain('hand the file manager back');
    });

    const revert = (over: Parameters<typeof inFlight>[1] = {}) => inFlight('restore', {
      state: 'restoring', ...over, params: { mode: 'snapshot_revert', volumeName: 'pv-old', snapshotName: 'snap-1', ...over.params },
    });

    it('a restore from a snapshot: releases the attach the dead process left, reverts, and starts the workloads at the counts written down', async () => {
      const a = await revert();
      await lock(a.opId, DEAD);
      await pickUp();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['quiesce', 'release maintenance attach of pv-old', 'revert pv-old to snap-1', 'unquiesce to web=2']);
    });

    it('a restore from a snapshot cut off after the revert: no second revert over what the tenant wrote since', async () => {
      const a = await revert({ state: 'unquiescing' });
      await lock(a.opId, DEAD);
      await pickUp();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['unquiesce to web=2']);
    });

    const retained = (over: Parameters<typeof inFlight>[1] = {}) => inFlight('restore', {
      state: 'replacing', ...over,
      params: { mode: 'retained_volume', retainedPvName: 'pv-kept', retainedVolumeName: 'pv-kept', snapshotName: 'snap-1', ...over.params },
    });

    it('a restore from a retained volume cut off in mid-swap, the claim gone: finishes the swap and keeps the fallback it noted', async () => {
      const a = await retained({ params: { fallbackVolume: 'pv-old' } });
      claim = null;
      await lock(a.opId, DEAD);
      await pickUp();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual([
        'quiesce', 'release maintenance attach of pv-kept', 'revert pv-kept to snap-1',
        'free volume pv-kept for a new claim', 'create claim 20Gi longhorn-tenant on pv-kept', 'unquiesce to web=2',
      ]);
      expect((await op(a.opId)).params).toMatchObject({ fallbackVolume: 'pv-old' });
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLimitOverride: '20.00' });
    });

    it('a restore from a retained volume cut off after the swap: the claim is on that volume — it is not swapped again, setting the retained volume itself aside', async () => {
      const a = await retained({ params: { fallbackVolume: 'pv-old' } });
      claim = { request: '20Gi', storageClass: 'longhorn-tenant', volumeName: 'pv-kept' };
      await lock(a.opId, DEAD);
      await pickUp();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['quiesce', 'unquiesce to web=2']);
      expect((await op(a.opId)).params).toMatchObject({ fallbackVolume: 'pv-old' });
    });

    it('a restore from a retained volume cut off while the workloads were starting: they are not stopped again', async () => {
      const a = await retained({ state: 'unquiescing', params: { fallbackVolume: 'pv-old' } });
      claim = { request: '20Gi', storageClass: 'longhorn-tenant', volumeName: 'pv-kept' };
      await lock(a.opId, DEAD);
      await pickUp();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['unquiesce to web=2']);
    });

    it('a first run notes the volume set aside before the swap, not after', async () => {
      const a = await retained();
      await lock(a.opId, DEAD);
      let finish: () => void = () => {};
      gate = new Promise<void>((resolve) => { finish = resolve; });
      await pickUp();
      await reached('revert');
      expect((await op(a.opId)).params).not.toHaveProperty('fallbackVolume');
      finish();
      await ended(a.opId);
      expect((await op(a.opId)).params).toMatchObject({ fallbackVolume: 'pv-old' });
      expect(did.indexOf(`delete claim ${a.namespace}-storage`)).toBeGreaterThan(did.indexOf('revert pv-kept to snap-1'));
    });

    const unarchive = async (over: Parameters<typeof inFlight>[1] = {}) => {
      const a = await inFlight('restore', { state: 'restoring', tenantStatus: 'archived', ...over });
      const snapId = crypto.randomUUID();
      await db().insert(storageSnapshots).values({
        id: snapId, tenantId: a.tenantId, kind: 'pre-archive', status: 'ready', archivePath: 'bundle:bkp-archive',
        expiresAt: new Date(Date.now() + 90 * 86_400_000),
      });
      await db().update(storageOperations).set({ params: { fromSnapshot: snapId, targetGi: 15 } }).where(eq(storageOperations.id, a.opId));
      return a;
    };

    it('a restore of an archived tenant: leaves the claim, waits for the restore the dead process started, then tells the tenant it is back', async () => {
      const a = await unarchive();
      await lock(a.opId, DEAD);
      await pickUp();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['apply claim 15Gi longhorn-tenant', 'restore bkp-archive (looking for the Job left behind)', 'cascade restored, once since the operation began']);
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'active', storageLifecycleState: 'idle', activeStorageOpId: null });
    });

    it('a restore of an archived tenant cut off after its status was stamped: the archive is not written over what it has done since — and its cascades are finished', async () => {
      const a = await unarchive({ tenantStatus: 'active' });
      await lock(a.opId, DEAD);
      await pickUp();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['cascade restored, once since the operation began']);
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'active', storageLifecycleState: 'idle', activeStorageOpId: null });
    });

    const check = (over: Parameters<typeof inFlight>[1] = {}) => inFlight('fsck', {
      ...over, params: { dryRun: true, fsckVolume: { volumeName: 'pv-old', nodeName: 'node-a', fsType: 'xfs' }, ...over.params },
    });

    it('a filesystem check whose tool is still at work: waits for that Job and leaves its attach — no second tool on the same blocks', async () => {
      const a = await check();
      leftFsckJob = 'fsck-check-left-by-the-dead-process';
      volume = { ...volume, state: 'attached' };
      await lock(a.opId, DEAD);
      await pickUp();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual([
        'quiesce', 'fsck fsck-check-left-by-the-dead-process (waiting for the Job left behind)', 'release the check\'s attach', 'unquiesce to web=2',
      ]);
    });

    it('a filesystem check with no tool left: releases the dead process\'s attach, waits for the volume, and checks again', async () => {
      const a = await check();
      volume = { ...volume, state: 'attached' };
      await lock(a.opId, DEAD);
      await pickUp();
      const row = await ended(a.opId);
      expect(row.state).toBe('idle');
      expect(did).toEqual([
        'quiesce', 'release the check\'s attach', 'attach volume for the check',
        `fsck fsck-check-pv-old-${a.opId.slice(0, 8)}`, 'release the check\'s attach', 'unquiesce to web=2',
      ]);
      expect(row.progressMessage).toContain('Filesystem is clean');
    });

    it('a filesystem check cut off after its result was noted: the tenant is not stopped a second time to find out what is known', async () => {
      const a = await check({
        state: 'unquiescing',
        params: { fsckResult: { fsType: 'xfs', dryRun: true, exitCode: 0, output: 'noted output', clean: true, verdict: 'clean', logDirty: false, summary: 'Filesystem is clean (noted)' } },
      });
      await lock(a.opId, DEAD);
      await pickUp();
      const row = await ended(a.opId);
      expect(row.state).toBe('idle');
      expect(did).toEqual(['unquiesce to web=2']);
      expect(row.progressMessage).toContain('Filesystem is clean (noted)');
    });
  });

  describe('a suspend or a resume whose process is gone', () => {
    /** Wait for a suspend or a resume picked up again to end, and for the tenant's lock to be given back. */
    const settled = async (a: InFlight) => {
      for (let i = 0; i < 150; i += 1) {
        const row = await op(a.opId);
        if (row?.completedAt) {
          for (let j = 0; j < 50 && await lockRow(tenantLockJob(a.tenantId)); j += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
          return row;
        }
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      throw new Error(`operation ${a.opId} did not end; it did: ${did.join(' | ')}`);
    };
    /** A resume in flight, after the suspend that wrote the replica counts down. */
    const resuming = async (over: Parameters<typeof inFlight>[1] = {}) => {
      const a = await inFlight('resume', { state: 'unquiescing', tenantStatus: 'suspended', ...over, params: { quiesceSnapshot: undefined, ...over.params } });
      await db().insert(storageOperations).values({
        id: crypto.randomUUID(), tenantId: a.tenantId, opType: 'suspend', state: 'idle',
        params: { quiesceSnapshot: WRITTEN },
        createdAt: new Date(Date.now() - 3 * 86_400_000), completedAt: new Date(Date.now() - 3 * 86_400_000),
      });
      return a;
    };

    it('a suspend is finished: scaled down with the counts it wrote down kept, its cascades run once, the tenant suspended', async () => {
      const a = await inFlight('suspend');
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      expect(await pickUp()).toEqual({ resumed: 1, ended: 0, leftAlone: 0 });
      const row = await settled(a);
      expect(did).toEqual(['quiesce', 'cascade suspended, once since the operation began']);
      expect(row).toMatchObject({ state: 'idle', progressMessage: 'Tenant suspended', lastError: null });
      // What a resume reads to start the workloads again: 2, not the 0 they are at now.
      expect(row.params).toMatchObject({ quiesceSnapshot: WRITTEN, resumes: 1 });
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'suspended', storageLifecycleState: 'idle', activeStorageOpId: null });
      expect(await lockRow(tenantLockJob(a.tenantId))).toBeNull();
    });

    it('a suspend cut off before it wrote any counts down takes them now', async () => {
      const a = await inFlight('suspend', { params: { quiesceSnapshot: undefined } });
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      await pickUp();
      await settled(a);
      expect(did).toEqual(['quiesce (writing the counts down)', 'cascade suspended, once since the operation began']);
    });

    it('a resume is finished: the workloads started from the counts of its suspend, its cascades run once, the tenant active', async () => {
      const a = await resuming();
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      expect(await pickUp()).toEqual({ resumed: 1, ended: 0, leftAlone: 0 });
      const row = await settled(a);
      expect(did).toEqual(['unquiesce to web=2', 'cascade active, once since the operation began']);
      expect(row).toMatchObject({ state: 'idle', progressMessage: 'Tenant resumed', lastError: null });
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'active', storageLifecycleState: 'idle', activeStorageOpId: null });
    });

    it.each<[OpType, string]>([['suspend', 'suspended'], ['resume', 'active']])('a %s whose operator chose not to tell the tenant still does not tell it', async (kind, transition) => {
      const a = kind === 'suspend'
        ? await inFlight('suspend', { params: { suppressTenantNotification: true } })
        : await resuming({ params: { suppressTenantNotification: true } });
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      await pickUp();
      await settled(a);
      expect(did).toContain(`cascade ${transition}, once since the operation began, the tenant not told`);
    });

    it('is run under the tenant\'s lock, so nothing else is started on the tenant meanwhile — and not picked up twice', async () => {
      const a = await inFlight('suspend');
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => { open = resolve; });
      expect(await pickUp()).toEqual({ resumed: 1, ended: 0, leftAlone: 0 });
      await reached('cascade suspended');
      expect(await lockRow(tenantLockJob(a.tenantId))).toMatchObject({ holder: REPLICA_ID });
      expect(await pickUp()).toEqual({ resumed: 0, ended: 0, leftAlone: 0 });       // its lock is live: not even found
      open();
      await settled(a);
      expect(did.filter((d) => d.startsWith('cascade'))).toHaveLength(1);
    });

    it('one that fails when it is picked up fails as its first run would: the operation failed, the tenant free', async () => {
      const a = await inFlight('suspend');
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      fails = 'cascade';
      await pickUp();
      const row = await settled(a);
      expect(row.state).toBe('failed');
      expect(row.lastError).toContain('cascade failed');
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'idle', activeStorageOpId: null });
    });

    it.each<[OpType, string]>([
      ['suspend', 'resume and suspend it again'],
      ['resume', 'suspend and resume it again'],
    ])('a %s picked up as often as an operation is, and cut off each time, is ended: failed, the tenant free, nothing touched', async (kind, advice) => {
      const a = await inFlight(kind, { params: { resumes: OP_MAX_RESUMES } });
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      expect(await pickUp()).toEqual({ resumed: 0, ended: 1, leftAlone: 0 });
      const row = await op(a.opId);
      expect(row.state).toBe('failed');
      expect(row.lastError).toContain('picked up again more than once');
      expect(row.lastError).toContain(advice);
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'idle', activeStorageOpId: null });
      expect(did).toEqual([]);                                       // the workloads are not touched
      expect(await lockRow(tenantLockJob(a.tenantId))).toBeNull();
    });

    it('is not picked up when a process took the tenant\'s lock between the look and the pick-up', async () => {
      const a = await inFlight('suspend');
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      // Right after the finder's query, the tenant's lock is taken by a live process.
      const taken = racing(() => lockAt(tenantLockJob(a.tenantId), 90, 'a-live-suspend'));
      expect(await pickUpInterruptedOperations(taken, k8s, {}, (line) => { log.push(line); })).toEqual({ resumed: 0, ended: 0, leftAlone: 1 });
      expect((await op(a.opId)).state).toBe('quiescing');
      expect(did).toEqual([]);
    });

    it('is not touched when it finished between the look and the pick-up', async () => {
      const a = await inFlight('resume', { state: 'unquiescing' });
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      const finished = racing(async () => {
        await db().update(storageOperations).set({ state: 'idle', progressMessage: 'Tenant resumed', completedAt: new Date() }).where(eq(storageOperations.id, a.opId));
        await db().update(tenants).set({ storageLifecycleState: 'idle', activeStorageOpId: null }).where(eq(tenants.id, a.tenantId));
      });
      expect(await pickUpInterruptedOperations(finished, k8s, {}, (line) => { log.push(line); })).toEqual({ resumed: 0, ended: 0, leftAlone: 1 });
      expect(await op(a.opId)).toMatchObject({ state: 'idle', lastError: null });
      expect(did).toEqual([]);
    });

    it('is not run when it ended between the pick-up\'s look and its lock', async () => {
      const a = await inFlight('suspend');
      await lockAt(tenantLockJob(a.tenantId), DEAD);
      const { resumeTransitionOp } = await import('./service.js');
      // The lock's claim is the first raw query of the pick-up of one operation.
      const cleared = racing(async () => {
        await db().update(storageOperations).set({ state: 'failed', completedAt: new Date() }).where(eq(storageOperations.id, a.opId));
        await db().update(tenants).set({ storageLifecycleState: 'idle', activeStorageOpId: null }).where(eq(tenants.id, a.tenantId));
      });
      expect(await resumeTransitionOp({ db: cleared, k8s }, a.opId)).toBe('resumed');
      for (let j = 0; j < 50 && await lockRow(tenantLockJob(a.tenantId)); j += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
      expect(did).toEqual([]);
      expect((await op(a.opId)).params).not.toHaveProperty('resumes');
    });
  });

  describe('an operation that left the volume without the tenant\'s files', () => {
    const SMALL = { request: '10Gi', storageClass: 'longhorn-tenant', volumeName: 'pv-new' };
    const stopped = async (a: InFlight) => {
      const row = await op(a.opId);
      expect(row.state).toBe('failed');
      expect(row.lastError).toContain('workloads were left stopped');
      expect(did.filter((d) => d.startsWith('unquiesce'))).toEqual([]);
      // Still pointing at the failed operation: what keeps the leftover leg and
      // the workload-health reconciler from starting the workloads.
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'failed', activeStorageOpId: a.opId });
      return row;
    };

    it.each<[string, OpState, typeof claim]>([
      ['while the files were being restored into the new volume', 'restoring', SMALL],
      ['after the old volume was deleted and before the new one was made', 'replacing', null],
    ])('a shrink ended %s: its workloads are NOT started on it, and the admins are told where the files are', async (_when, state, now) => {
      const a = await shrink({ captured: 'bkp-1', state, params: { resumes: OP_MAX_RESUMES } });
      claim = now;
      leftRestoreJob = 'rs-preresize-bkp1';
      await lock(a.opId, DEAD);
      expect(await pickUp()).toEqual({ resumed: 0, ended: 1, leftAlone: 0 });
      const row = await stopped(a);
      expect(row.lastError).toContain('pre-resize bundle');
      expect(did).toEqual(['delete job rs-preresize-bkp1']);          // nothing goes on writing to the volume either
      expect(await snapshot(a.snapId)).toMatchObject({ status: 'ready', archivePath: 'bundle:bkp-1' });   // the files: kept
      expect(told).toHaveLength(1);
      // 'integrity' is the category that opens the tenants list — not the cluster's storage page.
      expect(told[0]).toMatchObject({ subsystem: 'integrity', dedupeKey: `storage-op-ended:${a.opId}` });
      expect(told[0].payload).toMatchObject({ severityLabel: 'failed — tenant left stopped' });
      expect(told[0].payload.recommendedAction).toContain('Restore the files from that bundle');
    });

    it('…and the watchdog\'s leftover leg does not start them a quarter of an hour later', async () => {
      const a = await shrink({ captured: 'bkp-1', state: 'restoring', params: { resumes: OP_MAX_RESUMES } });
      claim = SMALL;
      await lock(a.opId, DEAD);
      await pickUp();
      heldNamespaces = [a.namespace];
      did.length = 0;
      expect(await sweepAbandonedQuiesce(db(), k8s)).toEqual({ abandonedOps: 0, recoveredNamespaces: 0 });
      expect(did).toEqual([]);
      // "Reset to idle" — the operator's — is what starts them.
      const { clearFailedStorageState } = await import('./service.js');
      await clearFailedStorageState(db(), a.tenantId, k8s);
      expect(did).toEqual(['unquiesce to web=2']);
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'idle', activeStorageOpId: null });
    });

    it('a shrink ended while its old volume is still the one there: the workloads are started — nothing was taken off it', async () => {
      const a = await shrink({ captured: 'bkp-1', state: 'replacing', params: { resumes: OP_MAX_RESUMES } });
      await lock(a.opId, DEAD);
      await pickUp();
      expect(did).toEqual(['unquiesce to web=2']);
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'failed', activeStorageOpId: null });
      expect(told[0].payload).toMatchObject({ severityLabel: 'failed' });
      expect(told[0].payload.recommendedAction).toContain('workloads were started again');
    });

    it('a shrink ended when the claim cannot even be read: stopped — "cannot tell" is not "the files are there"', async () => {
      const a = await shrink({ captured: 'bkp-1', state: 'restoring', params: { resumes: OP_MAX_RESUMES } });
      claimUnreadable = true;
      await lock(a.opId, DEAD);
      await pickUp();
      await stopped(a);
    });

    it('a shrink whose own restore fails: the same — it does not start the tenant on the half-restored volume', async () => {
      const a = await shrink({ captured: 'bkp-1', state: 'restoring', params: { storageClass: 'longhorn-tenant' } });
      claim = SMALL;
      fails = 'restore';
      await lock(a.opId, DEAD);
      await pickUp();
      await ended(a.opId);
      const row = await stopped(a);
      expect(row.lastError).toContain('restore failed');
      expect(await snapshot(a.snapId)).toMatchObject({ status: 'ready', archivePath: 'bundle:bkp-1' });
      // Whoever started it may have left: the admins are told, once.
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ subsystem: 'integrity', dedupeKey: `storage-op-ended:${a.opId}` });
      expect(told[0].payload).toMatchObject({ severityLabel: 'failed — tenant left stopped', detail: 'A resize of this tenant failed.' });
    });

    it('a shrink that fails with its old volume intact tells nobody more than its own failure does', async () => {
      const a = await shrink();
      captureOutcome = new Error('the backup target did not answer');
      await lock(a.opId, DEAD);
      await pickUp();
      await ended(a.opId);
      expect(told).toEqual([]);
      expect(did).toEqual(['quiesce', 'capture', 'unquiesce to web=2']);
    });

    it('a restore from a retained volume that fails in mid-swap, with no claim at all: stopped, and told to start the restore again', async () => {
      const a = await inFlight('restore', {
        state: 'replacing',
        params: { mode: 'retained_volume', retainedPvName: 'pv-kept', retainedVolumeName: 'pv-kept', snapshotName: 'snap-1' },
      });
      fails = 'create claim';
      await lock(a.opId, DEAD);
      await pickUp();
      await ended(a.opId);
      const row = await stopped(a);
      expect(row.lastError).toContain('start the restore from the retained volume again');
      expect(claim).toBeNull();
      expect(told).toHaveLength(1);
      expect(told[0].payload).toMatchObject({ detail: 'A restore of this tenant failed.' });
    });

    it('the reason is put where it is read first: the first step of a structured error, the opening of a plain one', async () => {
      const { withHold } = await import('./service.js');
      expect(withHold('plain failure', null)).toBe('plain failure');
      expect(withHold('plain failure', 'Left stopped.')).toBe('Left stopped.\n\nWhat failed: plain failure');
      const structured = JSON.stringify({ code: 'X', title: 'T', detail: 'D', remediation: ['first'], retryable: false });
      expect(JSON.parse(withHold(structured, 'Left stopped.'))).toEqual({ code: 'X', title: 'T', detail: 'D', remediation: ['Left stopped.', 'first'], retryable: false });
      expect(withHold('{"not":"an envelope"}', 'Left stopped.')).toBe('Left stopped.\n\nWhat failed: {"not":"an envelope"}');
    });
  });

  describe('a claim whose operation never began', () => {
    it('is withdrawn, not run: its starter did not get the lock and told its caller that nothing was started', async () => {
      const a = await shrink({ minutesOld: 10, params: { awaitingLock: true } });
      apiPods = [{ name: REPLICA_ID.split(':')[0], image: 'api:2' }];
      expect(await pickUp()).toEqual({ resumed: 0, ended: 1, leftAlone: 0 });
      expect(did).toEqual([]);
      const row = await op(a.opId);
      expect(row.state).toBe('failed');
      expect(row.lastError).toContain('could not be started');
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'idle', activeStorageOpId: null });
      expect(await snapshot(a.snapId)).toMatchObject({ status: 'failed' });
      expect(log[0]).toContain('never began');
    });

    it('one that began is not withdrawn by that mark\'s absence or its `false`', async () => {
      const { withdrawUnstartedOp } = await import('./service.js');
      for (const params of [{}, { awaitingLock: false }]) {
        const a = await shrink({ captured: 'bkp-1', params });
        expect(await withdrawUnstartedOp(db(), a.opId)).toBe(false);
        expect(await op(a.opId)).toMatchObject({ state: 'snapshotting', lastError: null });
        await lock(a.opId, DEAD);
        expect(await resumeOperation({ db: db(), k8s }, a.opId)).toBe('resumed');
        await ended(a.opId);
      }
    });

    it('one that has ended is not withdrawn a second time', async () => {
      const { withdrawUnstartedOp } = await import('./service.js');
      const a = await shrink({ state: 'failed', params: { awaitingLock: true } });
      await db().update(storageOperations).set({ lastError: 'what it said first' }).where(eq(storageOperations.id, a.opId));
      expect(await withdrawUnstartedOp(db(), a.opId)).toBe(false);
      expect((await op(a.opId)).lastError).toBe('what it said first');
    });
  });

  describe('the age rule beside it', () => {
    it('ends an operation older than six hours that nobody holds, and removes what was left working on its volume', async () => {
      const a = await inFlight('fsck', { minutesOld: 7 * 60, params: { fsckVolume: { volumeName: 'pv-old', nodeName: 'node-a', fsType: 'xfs' } } });
      leftFsckJob = 'fsck-left-running';
      expect(await sweepAbandonedQuiesce(db(), k8s)).toMatchObject({ abandonedOps: 1 });
      expect((await op(a.opId)).lastError).toContain("Abandoned in state 'quiescing'");
      expect(did).toEqual(['delete job fsck-left-running', 'release the check\'s attach', 'unquiesce to web=2']);
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'failed', activeStorageOpId: null });
    });

    it.each<OpType>(['archive', 'resize', 'restore', 'fsck'])('does not end an old %s that a process holds: it was picked up late and is working', async (kind) => {
      const a = await inFlight(kind, { minutesOld: 7 * 60 });
      await lock(a.opId, 90, 'the-replica-that-picked-it-up');
      expect(await sweepAbandonedQuiesce(db(), k8s)).toMatchObject({ abandonedOps: 0 });
      expect((await op(a.opId)).state).toBe('quiescing');
      expect(did).toEqual([]);
    });
  });
});
