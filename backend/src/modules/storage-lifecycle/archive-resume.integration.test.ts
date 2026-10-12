/**
 * An archive whose process is gone is picked up again — against a REAL
 * Postgres with every migration applied, so the operation, snapshot, bundle,
 * tenant and lock rows are the real tables.
 *
 * The cluster, the capture and the tenant's cascades are stand-ins; what is
 * under test is which archives are taken for interrupted, what a second run
 * does and does not repeat, and that a live archive is never taken over.
 *
 * Needs a database — CI's integration job provides DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { isDbAvailable, runMigrations, cleanTables, closeTestDb, getTestDb } from '../../test-helpers/db.js';
import { seedRegion, seedPlan, seedTenant } from '../../test-helpers/fixtures.js';
import { backupJobs, storageOperations, storageSnapshots, tenants } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { runLockName } from '../../shared/exclusive-run.js';
import { REPLICA_ID } from '../../shared/scheduler-lease.js';

/** What the stand-ins were asked to do, in order. */
const did: string[] = [];
let captureOutcome: { status: 'completed' | 'partial' } | Error = { status: 'completed' };
/** Resolved by a test to let a capture that is "running" finish. */
let captureGate: Promise<void> | null = null;
let ctxFails: Error | null = null;

vi.mock('./quiesce.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  quiesce: async (_k8s: unknown, _ns: string, persist?: (snap: unknown) => Promise<void>) => {
    // The workloads are at zero already when an archive is picked up again:
    // counts taken now are all zero.
    const now = { deployments: [{ name: 'web', replicas: 0 }], cronJobs: [] };
    did.push(persist ? 'quiesce (writing the counts down)' : 'quiesce');
    await persist?.(now);
    return now;
  },
  waitForQuiesced: async () => undefined,
  unquiesce: async (_k8s: unknown, _ns: string, snap: { deployments: Array<{ name: string; replicas: number }> }) => {
    did.push(`unquiesce to ${snap.deployments.map((d) => `${d.name}=${d.replicas}`).join(',')}`);
  },
}));
vi.mock('./prebundle.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  captureFilesOnlyBundle: async () => {
    did.push('capture');
    await captureGate;
    if (captureOutcome instanceof Error) throw captureOutcome;
    return { bundleId: 'bkp-new', status: captureOutcome.status, sizeBytes: 4242 };
  },
}));
vi.mock('../tenant-lifecycle/cascades.js', () => ({
  applyArchived: async (ctx: { db: Database }, tenantId: string) => {
    did.push('cascade');
    await ctx.db.update(tenants).set({ status: 'archived', archivedAt: new Date() }).where(eq(tenants.id, tenantId));
    return 'transition-1';
  },
}));
vi.mock('./snapshot-ctx.js', () => ({
  buildArchiveServiceCtx: async (db: Database, k8s: K8sClients) => {
    if (ctxFails) throw ctxFails;
    return { db, k8s, store: {}, platformNamespace: 'platform' };
  },
}));

const { findInterruptedArchives, resumeInterruptedArchives, DEAD_HOLDER_GRACE_MS } = await import('./archive-resume.js');
const { archiveLockJob, ARCHIVE_MAX_RESUMES } = await import('./service.js');
const { sweepAbandonedQuiesce } = await import('./quiesce-watchdog.js');

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('archives interrupted by a restart (real Postgres)', () => {
  const db = () => getTestDb() as unknown as Database;
  let regionId = '';
  let planId = '';
  const log: string[] = [];

  const k8s = {
    apps: { listNamespacedDeployment: async () => ({ items: [] }), listDeploymentForAllNamespaces: async () => ({ items: [] }) },
    batch: {
      listNamespacedCronJob: async () => ({ items: [] }),
      deleteNamespacedJob: async ({ name }: { name: string }) => { did.push(`delete job ${name}`); },
    },
    core: {
      listNamespacedService: async () => ({ items: [] }),
      deleteNamespacedPersistentVolumeClaim: async ({ name }: { name: string }) => { did.push(`delete claim ${name}`); },
    },
    custom: {},
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
    captureOutcome = { status: 'completed' }; captureGate = null; ctxFails = null;
  });

  const lockKey = (opId: string): string => `scheduler-lease:${runLockName(archiveLockJob(opId))}`;
  /** A lock row as a process leaves it: `seconds` ahead (negative: lapsed that long ago). */
  const lock = (opId: string, seconds: number, holder = 'replica-that-died') => db().execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value)
    VALUES (${lockKey(opId)}, json_build_object('holder', ${holder}::text, 'until', now() + make_interval(secs => ${seconds}))::text)
    ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`);
  const lockRow = async (opId: string): Promise<{ holder: string } | null> => {
    const res = await db().execute(sql`SELECT setting_value FROM platform_settings WHERE setting_key = ${lockKey(opId)}`) as unknown as { rows: Array<{ setting_value: string }> };
    return res.rows[0] ? JSON.parse(res.rows[0].setting_value) as { holder: string } : null;
  };

  interface InFlight { tenantId: string; opId: string; snapId: string; namespace: string }
  /** A tenant with an archive in flight, as its rows stand at the given step. */
  const archiveInFlight = async (over: {
    state?: 'quiescing' | 'snapshotting' | 'replacing' | 'archiving' | 'idle' | 'failed';
    opType?: 'archive' | 'resize';
    params?: Record<string, unknown>;
    captured?: string;                       // the bundle the snapshot row already points at
    tenantStatus?: 'suspended' | 'archived';
    hoursOld?: number;
    active?: boolean;
  } = {}): Promise<InFlight> => {
    const tenant = await seedTenant(db(), regionId, planId, {
      status: over.tenantStatus ?? 'suspended', suspendedAt: new Date(Date.now() - 40 * 86_400_000),
    });
    const opId = crypto.randomUUID();
    const snapId = crypto.randomUUID();
    const state = over.state ?? 'snapshotting';
    await db().insert(storageSnapshots).values({
      id: snapId, tenantId: tenant.id, kind: 'pre-archive',
      status: over.captured ? 'ready' : 'creating',
      archivePath: over.captured ? `bundle:${over.captured}` : 'bundle:pending',
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
    });
    await db().insert(storageOperations).values({
      id: opId, tenantId: tenant.id, opType: over.opType ?? 'archive', state,
      snapshotId: snapId,
      params: over.params ?? { retentionDays: 90, quiesceSnapshot: { deployments: [{ name: 'web', replicas: 2 }], cronJobs: [] } },
      createdAt: new Date(Date.now() - (over.hoursOld ?? 0.5) * 3_600_000),
      ...(state === 'idle' || state === 'failed' ? { completedAt: new Date() } : {}),
    });
    await db().update(tenants)
      .set({ storageLifecycleState: state === 'failed' ? 'failed' : state, activeStorageOpId: over.active === false ? null : opId })
      .where(eq(tenants.id, tenant.id));
    return { tenantId: tenant.id, opId, snapId, namespace: tenant.kubernetesNamespace };
  };

  const op = async (opId: string) => (await db().select().from(storageOperations).where(eq(storageOperations.id, opId)))[0];
  const tenantRow = async (id: string) => (await db().select().from(tenants).where(eq(tenants.id, id)))[0];
  const snapshot = async (id: string) => (await db().select().from(storageSnapshots).where(eq(storageSnapshots.id, id)))[0];
  /** Wait for a detached archive to end, either way. */
  const ended = async (opId: string) => {
    for (let i = 0; i < 100; i += 1) {
      const row = await op(opId);
      if (row?.completedAt) return row;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    throw new Error(`archive ${opId} did not end; it did: ${did.join(' | ')}`);
  };
  const resume = () => resumeInterruptedArchives(db(), k8s, {}, (line) => { log.push(line); });
  const DEAD = -(DEAD_HOLDER_GRACE_MS / 1000) - 60;

  describe('which archives are taken for interrupted', () => {
    it('one in flight whose lock lapsed more than the grace ago', async () => {
      const a = await archiveInFlight();
      await lock(a.opId, DEAD);
      expect(await findInterruptedArchives(db())).toEqual([a.opId]);
    });

    it.each<[string, number | null]>([
      ['its lock is held', 90],
      ['its lock lapsed only a moment ago — a holder late renewing is not a dead one', -10],
      ['it has no lock at all — started by a release without one, or given up as hung', null],
    ])('not one in flight when %s', async (_why, seconds) => {
      const a = await archiveInFlight();
      if (seconds !== null) await lock(a.opId, seconds);
      expect(await findInterruptedArchives(db())).toEqual([]);
    });

    it.each<[string, Parameters<typeof archiveInFlight>[0]]>([
      ['an archive that has ended', { state: 'idle' }],
      ['an archive that has failed', { state: 'failed' }],
      ['an operation of another kind', { opType: 'resize' }],
      ['an archive that is no longer its tenant\'s active operation', { active: false }],
    ])('not %s, whatever its lock says', async (_what, over) => {
      const a = await archiveInFlight(over);
      await lock(a.opId, DEAD);
      expect(await findInterruptedArchives(db())).toEqual([]);
    });

    it('a lock row that cannot be read is not a reason to resume, and not an error', async () => {
      const a = await archiveInFlight();
      for (const value of ['not json', '{}', '{"holder":"x","until":"soon"}']) {
        await db().execute(sql`INSERT INTO platform_settings (setting_key, setting_value) VALUES (${lockKey(a.opId)}, ${value})
          ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`);
        expect(await findInterruptedArchives(db()), value).toEqual([]);
      }
    });

    it('the oldest first', async () => {
      const young = await archiveInFlight({ hoursOld: 1 });
      const old = await archiveInFlight({ hoursOld: 3 });
      await lock(young.opId, DEAD);
      await lock(old.opId, DEAD);
      expect(await findInterruptedArchives(db())).toEqual([old.opId, young.opId]);
    });
  });

  describe('picking one up again', () => {
    it('runs it to its end: the tenant is archived, the operation done, and the lock given back', async () => {
      const a = await archiveInFlight();
      await lock(a.opId, DEAD);
      expect(await resume()).toEqual({ resumed: 1, leftAlone: 0 });
      const done = await ended(a.opId);
      expect(done).toMatchObject({ state: 'idle', progressPct: 100, lastError: null });
      expect((done.params as { resumes: number }).resumes).toBe(1);
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'archived', storageLifecycleState: 'idle', activeStorageOpId: null });
      expect(await snapshot(a.snapId)).toMatchObject({ status: 'ready', archivePath: 'bundle:bkp-new', sizeBytes: '4242' });
      expect(did).toEqual(['quiesce', 'capture', `delete claim ${a.namespace}-storage`, 'cascade']);
      expect(await lockRow(a.opId)).toBeNull();
      expect(log).toEqual([`archive ${a.opId} had no live process behind it — picked up again`]);
    });

    it('holds its lock under this process\'s own name while it works, so no other watchdog takes it too', async () => {
      const a = await archiveInFlight();
      await lock(a.opId, DEAD);
      let finish: () => void = () => {};
      captureGate = new Promise<void>((resolve) => { finish = resolve; });
      await resume();
      for (let i = 0; i < 100 && !did.includes('capture'); i += 1) await new Promise((r) => { setTimeout(r, 20); });
      expect((await lockRow(a.opId))?.holder).toBe(REPLICA_ID);
      expect(await findInterruptedArchives(db())).toEqual([]);          // held: nobody's to resume
      expect(await resume()).toEqual({ resumed: 0, leftAlone: 0 });
      finish();
      await ended(a.opId);
      expect(did.filter((d) => d === 'capture')).toHaveLength(1);
    });

    it('does not write the replica counts down again — they would all be zero — and restores the first ones if it fails', async () => {
      const a = await archiveInFlight();
      await lock(a.opId, DEAD);
      captureOutcome = new Error('the backup target did not answer');
      await resume();
      const done = await ended(a.opId);
      expect(done.state).toBe('failed');
      expect(did).toEqual(['quiesce', 'capture', 'unquiesce to web=2']);
      expect((done.params as { quiesceSnapshot: { deployments: Array<{ replicas: number }> } }).quiesceSnapshot.deployments[0].replicas).toBe(2);
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'suspended', storageLifecycleState: 'failed' });
    });

    it('writes the counts down when the first process died before it had', async () => {
      const a = await archiveInFlight({ state: 'quiescing', params: { retentionDays: 90 } });
      await lock(a.opId, DEAD);
      await resume();
      await ended(a.opId);
      expect(did[0]).toBe('quiesce (writing the counts down)');
    });

    it('does not take a second archive when the first one was complete', async () => {
      const a = await archiveInFlight({ state: 'replacing', captured: 'bkp-first' });
      await lock(a.opId, DEAD);
      await resume();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['quiesce', `delete claim ${a.namespace}-storage`, 'cascade']);
      expect((await snapshot(a.snapId)).archivePath).toBe('bundle:bkp-first');
    });

    it('does not run the tenant\'s cascades — and so not its "archived" message — a second time', async () => {
      const a = await archiveInFlight({ state: 'archiving', captured: 'bkp-first', tenantStatus: 'archived' });
      await lock(a.opId, DEAD);
      await resume();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['quiesce', `delete claim ${a.namespace}-storage`]);
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'archived', storageLifecycleState: 'idle' });
    });

    it('fails the capture the dead process was in the middle of, removes its Job, and touches no other bundle', async () => {
      const a = await archiveInFlight();
      const other = await seedTenant(db(), regionId, planId);
      const bundle = (id: string, tenantId: string, over: Partial<typeof backupJobs.$inferInsert> = {}) => db().insert(backupJobs).values({
        id, tenantId, initiator: 'system', systemTrigger: 'pre_resize', status: 'running',
        targetKind: 's3', targetUri: 's3://example.test/b', retentionDays: 90, createdAt: new Date(Date.now() - 20 * 60_000), ...over,
      });
      await bundle('bkp-cut-off', a.tenantId);
      await bundle('bkp-before-the-archive', a.tenantId, { createdAt: new Date(Date.now() - 5 * 3_600_000) });
      await bundle('bkp-operators-own', a.tenantId, { initiator: 'admin', systemTrigger: null });
      await bundle('bkp-not-the-systems', a.tenantId, { initiator: 'admin' });       // same trigger, but nobody's archive
      await bundle('bkp-done', a.tenantId, { status: 'completed' });
      await bundle('bkp-another-tenant', other.id);
      await lock(a.opId, DEAD);
      await resume();
      await ended(a.opId);
      const rows = await db().select({ id: backupJobs.id, status: backupJobs.status, lastError: backupJobs.lastError }).from(backupJobs);
      const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      expect(status).toEqual({
        'bkp-cut-off': 'failed',
        'bkp-before-the-archive': 'running',
        'bkp-operators-own': 'running',
        'bkp-not-the-systems': 'running',
        'bkp-done': 'completed',
        'bkp-another-tenant': 'running',
      });
      expect(rows.find((r) => r.id === 'bkp-cut-off')?.lastError).toContain('the platform API restarted');
      expect(did.filter((d) => d.startsWith('delete job'))).toEqual(['delete job bk-files-bkp-cut-off']);
      expect(did.indexOf('delete job bk-files-bkp-cut-off')).toBeLessThan(did.indexOf('capture'));
    });

    it('refuses to remove the volume when the second archive is not complete either', async () => {
      const a = await archiveInFlight();
      await lock(a.opId, DEAD);
      captureOutcome = { status: 'partial' };
      await resume();
      const done = await ended(a.opId);
      expect(done.state).toBe('failed');
      expect(did.some((d) => d.startsWith('delete claim'))).toBe(false);
      expect(did).not.toContain('cascade');
    });

    it('leaves alone an archive that was picked up three times already', async () => {
      const a = await archiveInFlight({ params: { retentionDays: 90, resumes: ARCHIVE_MAX_RESUMES } });
      await lock(a.opId, DEAD);
      expect(await resume()).toEqual({ resumed: 0, leftAlone: 1 });
      expect(did).toEqual([]);
      expect((await op(a.opId)).state).toBe('snapshotting');
    });

    it('leaves it alone, and goes on to the next, when no archive can be taken right now', async () => {
      const a = await archiveInFlight({ hoursOld: 2 });
      const b = await archiveInFlight({ hoursOld: 1 });
      await lock(a.opId, DEAD);
      await lock(b.opId, DEAD);
      ctxFails = new ApiError('NO_SNAPSHOT_TARGET', 'No backup target is assigned to tenant snapshots', 409);
      expect(await resume()).toEqual({ resumed: 0, leftAlone: 2 });
      expect(log.every((l) => l.includes('No backup target is assigned to tenant snapshots'))).toBe(true);
      expect(did).toEqual([]);
    });

    it('does nothing at all when no archive is interrupted', async () => {
      await archiveInFlight();                       // in flight, never locked: not ours to judge
      expect(await resume()).toEqual({ resumed: 0, leftAlone: 0 });
      expect(log).toEqual([]);
    });
  });

  describe('a process that was only stalled, and wakes up after its archive was taken over', () => {
    /** Start an archive in this process and hold it inside its capture. */
    const heldInCapture = async () => {
      const a = await archiveInFlight();
      await lock(a.opId, DEAD);
      let finish: () => void = () => {};
      captureGate = new Promise<void>((resolve) => { finish = resolve; });
      await resume();
      for (let i = 0; i < 100 && !did.includes('capture'); i += 1) await new Promise((r) => { setTimeout(r, 20); });
      return { a, finish };
    };
    /** The run has left its lock alone once nothing more happens; give it time to do wrong. */
    const settle = () => new Promise((resolve) => { setTimeout(resolve, 400); });

    it('stops where it is: it deletes nothing, runs no cascade, and leaves the operation to its successor', async () => {
      const { a, finish } = await heldInCapture();
      await lock(a.opId, 90, 'replica-b');             // another replica took the archive over
      finish();                                        // …and the stalled capture comes back, complete
      await settle();
      expect(did).toEqual(['quiesce', 'capture']);     // no claim deleted, no cascade
      const row = await op(a.opId);
      expect(row).toMatchObject({ state: 'snapshotting', completedAt: null, lastError: null });
      expect(await snapshot(a.snapId)).toMatchObject({ status: 'creating', archivePath: 'bundle:pending' });
      expect(await tenantRow(a.tenantId)).toMatchObject({ status: 'suspended', storageLifecycleState: 'snapshotting', activeStorageOpId: a.opId });
      expect((await lockRow(a.opId))?.holder).toBe('replica-b');     // and it did not take the lock away either
    });

    it('does not fail the archive or bring the workloads back when its own capture fails under it', async () => {
      const { a, finish } = await heldInCapture();
      await lock(a.opId, 90, 'replica-b');
      captureOutcome = new Error('the capture Job was deleted');     // what the successor's clean-up does to it
      finish();
      await settle();
      expect(did).toEqual(['quiesce', 'capture']);     // above all: no unquiesce
      expect(await op(a.opId)).toMatchObject({ state: 'snapshotting', completedAt: null, lastError: null });
      expect((await tenantRow(a.tenantId)).storageLifecycleState).toBe('snapshotting');
    });

    it('stops as well when the watchdog has ended the archive and removed its lock', async () => {
      const { a, finish } = await heldInCapture();
      await db().execute(sql`DELETE FROM platform_settings WHERE setting_key = ${lockKey(a.opId)}`);
      finish();
      await settle();
      expect(did).toEqual(['quiesce', 'capture']);
      expect(await snapshot(a.snapId)).toMatchObject({ status: 'creating' });
    });

    it('carries on when its lock merely lapsed and nobody took it — it is still its own', async () => {
      const { a, finish } = await heldInCapture();
      await lock(a.opId, -30, REPLICA_ID);             // lapsed, under this process's own name
      finish();
      expect((await ended(a.opId)).state).toBe('idle');
      expect(did).toEqual(['quiesce', 'capture', `delete claim ${a.namespace}-storage`, 'cascade']);
    });

    it('a resume that finds the lock held starts nothing, and does not count as a resume', async () => {
      const a = await archiveInFlight();
      await lock(a.opId, 90, 'replica-b');
      const ctx = { db: db(), k8s, store: {}, platformNamespace: 'platform' } as never;
      const { resumeArchive } = await import('./service.js');
      expect(await resumeArchive(ctx, a.opId)).toBe(false);
      await settle();
      expect(did).toEqual([]);
      expect((await op(a.opId)).params).not.toHaveProperty('resumes');
    });
  });

  describe('locks left by processes long dead', () => {
    it('are removed once a day old — a tenant\'s as much as an archive\'s — and no other row is', async () => {
      const key = (name: string): string => `scheduler-lease:${name}`;
      const put = (name: string, seconds: number) => db().execute(sql`
        INSERT INTO platform_settings (setting_key, setting_value)
        VALUES (${key(name)}, json_build_object('holder', 'replica-that-died', 'until', now() + make_interval(secs => ${seconds}))::text)`);
      await put('tenant:11111111-1111-4111-8111-111111111111-run', -2 * 86_400);
      await put('storage-op:22222222-2222-4222-8222-222222222222-run', -2 * 86_400);
      await put('tenant:33333333-3333-4333-8333-333333333333-run', -3_600);        // lapsed an hour ago: may still be read
      await put('node-health-monitor-run', 60);                                    // held
      await put('storage-quiesce-watchdog', -2 * 86_400);                          // a job's own lease, not a run lock
      await db().execute(sql`INSERT INTO platform_settings (setting_key, setting_value) VALUES ('tenant_lifecycle.auto_notice_days', '7')`);
      await resume();
      const left = (await db().execute(sql`SELECT setting_key FROM platform_settings WHERE setting_key LIKE 'scheduler-lease:%' OR setting_key LIKE 'tenant_lifecycle.%' ORDER BY 1`) as unknown as { rows: Array<{ setting_key: string }> })
        .rows.map((r) => r.setting_key);
      expect(left).toEqual([
        key('node-health-monitor-run'),
        key('storage-quiesce-watchdog'),
        key('tenant:33333333-3333-4333-8333-333333333333-run'),
        'tenant_lifecycle.auto_notice_days',
      ]);
      await db().execute(sql`DELETE FROM platform_settings WHERE setting_key = 'tenant_lifecycle.auto_notice_days'`);
    });
  });

  describe('the watchdog\'s six-hour rule', () => {
    it('does not fail an old archive that a process is working on', async () => {
      const a = await archiveInFlight({ hoursOld: 7 });
      await lock(a.opId, 90, 'replica-b');
      expect((await sweepAbandonedQuiesce(db(), k8s)).abandonedOps).toBe(0);
      expect((await op(a.opId)).state).toBe('snapshotting');
    });

    it('fails an old archive nobody is working on, restores its workloads, and removes the lock its process left', async () => {
      const a = await archiveInFlight({ hoursOld: 7 });
      await lock(a.opId, DEAD);
      expect((await sweepAbandonedQuiesce(db(), k8s)).abandonedOps).toBe(1);
      expect(await op(a.opId)).toMatchObject({ state: 'failed' });
      expect(await tenantRow(a.tenantId)).toMatchObject({ storageLifecycleState: 'failed', activeStorageOpId: null });
      expect(did).toEqual(['unquiesce to web=2']);
      expect(await lockRow(a.opId)).toBeNull();
    });

    it('still fails an old operation of another kind, lock or no lock', async () => {
      const a = await archiveInFlight({ hoursOld: 7, opType: 'resize' });
      await lock(a.opId, 90, 'replica-b');
      expect((await sweepAbandonedQuiesce(db(), k8s)).abandonedOps).toBe(1);
      expect((await op(a.opId)).state).toBe('failed');
    });
  });
});
