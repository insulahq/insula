import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { reconcilePitrJobsOnce, STUCK_THRESHOLD_MS } from './watchdog.js';

// Mock tasks/service.finalizeByRef + postgres-restore/service.releasePitrLock
// so the watchdog's downstream calls are observable + don't try to hit a DB.
vi.mock('../tasks/service.js', () => ({
  finalizeByRef: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./service.js', () => ({
  releasePitrLock: vi.fn().mockResolvedValue(undefined),
}));

const fakeDb = { __mock: true } as unknown as Parameters<typeof reconcilePitrJobsOnce>[0]['db'];

function makeK8s(opts: {
  jobs?: Parameters<typeof reconcilePitrJobsOnce>[0]['k8s']['batch']['listNamespacedJob'] extends (...a: never[]) => infer R
    ? Awaited<R> extends { items?: infer I } ? I : never
    : never;
  events?: ReadonlyArray<{ reason?: string; message?: string }>;
  deleteJobs?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    batch: {
      listNamespacedJob: vi.fn().mockResolvedValue({ items: opts.jobs ?? [] }),
      deleteNamespacedJob: opts.deleteJobs ?? vi.fn().mockResolvedValue({}),
    },
    core: {
      listNamespacedEvent: vi.fn().mockResolvedValue({ items: opts.events ?? [] }),
    },
  } as unknown as Parameters<typeof reconcilePitrJobsOnce>[0]['k8s'];
}

function makeJob(ageMs: number, opts: { active?: number; succeeded?: number; failed?: number; env?: Array<{ name: string; value: string }>; name?: string } = {}) {
  const created = new Date(Date.now() - ageMs).toISOString();
  return {
    metadata: {
      name: opts.name ?? `pitr-system-db-${Date.now()}`,
      namespace: 'platform',
      creationTimestamp: created,
      labels: { 'platform.phoenix-host.net/pitr-restore': 'true' },
    },
    spec: {
      template: { spec: { containers: [{ env: opts.env ?? [{ name: 'PITR_ACTOR_USER_ID', value: 'user-1' }] }] } },
    },
    status: {
      active: opts.active ?? 0,
      succeeded: opts.succeeded ?? 0,
      failed: opts.failed ?? 0,
    },
  };
}

describe('PITR Job watchdog — reconcilePitrJobsOnce', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('ignores Jobs younger than STUCK_THRESHOLD_MS', async () => {
    const youngJob = makeJob(STUCK_THRESHOLD_MS - 10_000); // 80s old
    const k8s = makeK8s({ jobs: [youngJob] });
    const result = await reconcilePitrJobsOnce({ db: fakeDb, k8s });
    expect(result).toHaveLength(0);
  });

  it('ignores healthy Jobs (active pod)', async () => {
    const job = makeJob(120_000, { active: 1 }); // 2min old, has active pod
    const k8s = makeK8s({ jobs: [job] });
    const result = await reconcilePitrJobsOnce({ db: fakeDb, k8s });
    expect(result).toHaveLength(0);
  });

  it('ignores healthy Jobs (succeeded)', async () => {
    const job = makeJob(120_000, { succeeded: 1 });
    const k8s = makeK8s({ jobs: [job] });
    const result = await reconcilePitrJobsOnce({ db: fakeDb, k8s });
    expect(result).toHaveLength(0);
  });

  it('ignores stale Jobs with NO FailedCreate events + no failed pods (insufficient evidence)', async () => {
    const job = makeJob(120_000); // 2min old, no pods at all, no events
    const k8s = makeK8s({ jobs: [job], events: [] });
    const result = await reconcilePitrJobsOnce({ db: fakeDb, k8s });
    expect(result).toHaveLength(0);
  });

  it('declares Job stuck when old enough AND has FailedCreate events', async () => {
    const job = makeJob(120_000, { name: 'pitr-system-db-stuck' });
    const k8s = makeK8s({
      jobs: [job],
      events: [{ reason: 'FailedCreate', message: 'forbidden: exceeded quota: platform-quota, requested: limits.memory=512Mi' }],
    });
    const result = await reconcilePitrJobsOnce({ db: fakeDb, k8s });
    expect(result).toHaveLength(1);
    expect(result[0].job.metadata?.name).toBe('pitr-system-db-stuck');
    expect(result[0].evidence).toContain('FailedCreate events');
    expect(result[0].evidence).toContain('exceeded quota');

    // finalizeByRef should have been called for chip 'postgres.pitr'.
    const tasksMod = await import('../tasks/service.js');
    expect(tasksMod.finalizeByRef).toHaveBeenCalledTimes(1);
    const finalizeCall = vi.mocked(tasksMod.finalizeByRef).mock.calls[0];
    expect(finalizeCall[1]).toBe('postgres.pitr');
    expect(finalizeCall[2]).toBe('pitr-system-db-stuck');
    expect((finalizeCall[3] as { status: string }).status).toBe('failed');

    // releasePitrLock called with taskKind=postgres.pitr.
    const restoreMod = await import('./service.js');
    expect(restoreMod.releasePitrLock).toHaveBeenCalledTimes(1);
    const releaseCall = vi.mocked(restoreMod.releasePitrLock).mock.calls[0];
    expect((releaseCall[1] as { taskKind: string }).taskKind).toBe('postgres.pitr');
  });

  it('detects barman-promote Job via env BARMAN_PROMOTE_MODE=true → chip kind is postgres.barman-promote', async () => {
    const job = makeJob(120_000, {
      name: 'pitr-system-db-promote-stuck',
      env: [
        { name: 'PITR_ACTOR_USER_ID', value: 'user-1' },
        { name: 'BARMAN_PROMOTE_MODE', value: 'true' },
      ],
    });
    const k8s = makeK8s({
      jobs: [job],
      events: [{ reason: 'FailedCreate', message: 'quota' }],
    });
    await reconcilePitrJobsOnce({ db: fakeDb, k8s });
    const tasksMod = await import('../tasks/service.js');
    expect(vi.mocked(tasksMod.finalizeByRef).mock.calls[0][1]).toBe('postgres.barman-promote');
    const restoreMod = await import('./service.js');
    expect((vi.mocked(restoreMod.releasePitrLock).mock.calls[0][1] as { taskKind: string }).taskKind).toBe('postgres.barman-promote');
  });

  it('skips finalizeByRef when actorUserId env var is absent (cannot recreate chip)', async () => {
    const job = makeJob(120_000, {
      name: 'pitr-no-actor',
      env: [{ name: 'PITR_CLUSTER_NAME', value: 'system-db' }], // no PITR_ACTOR_USER_ID
    });
    const k8s = makeK8s({
      jobs: [job],
      events: [{ reason: 'FailedCreate', message: 'quota' }],
    });
    await reconcilePitrJobsOnce({ db: fakeDb, k8s });
    const tasksMod = await import('../tasks/service.js');
    // finalizeByRef NOT called — no actorUserId to recreate the chip.
    expect(tasksMod.finalizeByRef).not.toHaveBeenCalled();
    // But the lock IS still released.
    const restoreMod = await import('./service.js');
    expect(restoreMod.releasePitrLock).toHaveBeenCalledTimes(1);
  });

  it('deletes stuck Job only when deleteStuckJobs=true', async () => {
    const job = makeJob(120_000, { name: 'pitr-delete-test' });
    const events = [{ reason: 'FailedCreate', message: 'quota' }];

    // First run: deleteStuckJobs=false (default) → no delete
    const k8sNoDelete = makeK8s({ jobs: [job], events });
    await reconcilePitrJobsOnce({ db: fakeDb, k8s: k8sNoDelete });
    expect(k8sNoDelete.batch.deleteNamespacedJob).not.toHaveBeenCalled();

    // Second run: deleteStuckJobs=true → deleteNamespacedJob called
    const k8sDelete = makeK8s({ jobs: [job], events });
    await reconcilePitrJobsOnce({ db: fakeDb, k8s: k8sDelete, deleteStuckJobs: true });
    expect(k8sDelete.batch.deleteNamespacedJob).toHaveBeenCalledTimes(1);
    const deleteCall = vi.mocked(k8sDelete.batch.deleteNamespacedJob).mock.calls[0][0];
    expect(deleteCall.name).toBe('pitr-delete-test');
    expect(deleteCall.propagationPolicy).toBe('Background');
  });

  it('survives finalizeByRef failure (best-effort, continues to releasePitrLock)', async () => {
    const job = makeJob(120_000, { name: 'pitr-finalize-fails' });
    const k8s = makeK8s({
      jobs: [job],
      events: [{ reason: 'FailedCreate', message: 'quota' }],
    });

    const tasksMod = await import('../tasks/service.js');
    vi.mocked(tasksMod.finalizeByRef).mockRejectedValueOnce(new Error('db connection refused'));

    await expect(reconcilePitrJobsOnce({ db: fakeDb, k8s })).resolves.not.toThrow();

    const restoreMod = await import('./service.js');
    expect(restoreMod.releasePitrLock).toHaveBeenCalledTimes(1);
  });
});
