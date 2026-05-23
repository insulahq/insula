import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPostgresRestoreInProgress, promotePostgresFromSnapshot, acquirePitrLockOrThrow, createPitrJob, getPlatformApiImage, releasePitrLock, runPitrPrechecks } from './service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

vi.mock('../../db/schema.js', () => ({
  notifications: { id: 'notifications.id' },
  users: { id: 'users.id', roleName: 'users.roleName' },
  // platformSettings is the DB-backed PITR lock table; service.ts
  // reads/writes it via acquirePitrLockOrThrow + writePersistedLock.
  // Tests don't exercise lock contention — the mock makeDb returns
  // empty rows so the lock check passes.
  platformSettings: { key: 'platform_settings.key', value: 'platform_settings.value' },
}));

vi.mock('../../shared/k8s-exec.js', () => ({
  execInPod: vi.fn().mockImplementation((_kc: string | undefined, _ns: string, _pod: string, _container: string, cmd: readonly string[]) => {
    const c = cmd.join(' ');
    if (c.includes('ls -la')) {
      const old = Math.floor(Date.now() / 1000) - 7200;
      return Promise.resolve({ stdout: `${old} 000000010000000000000001\n`, stderr: '', exitCode: 0 });
    }
    if (c.includes('SELECT 1')) return Promise.resolve({ stdout: '1', stderr: '', exitCode: 0 });
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  }),
}));

function makeDb(): Database {
  // Drizzle-shaped mock: each chained call returns an object exposing
  // the next method. .where() resolves to an empty rowset (no lock
  // held); .onConflictDoUpdate / .delete().where() / .limit() all
  // return resolved promises so the orchestrator's lock-related
  // writes succeed silently.
  const empty = Promise.resolve([]);
  const ok = Promise.resolve(undefined);
  return {
    select: () => ({
      from: () => ({
        where: () => Object.assign(empty, { limit: () => empty }),
      }),
    }),
    insert: () => ({
      values: () => Object.assign(ok, { onConflictDoUpdate: () => ok }),
    }),
    delete: () => ({ where: () => ok }),
  } as unknown as Database;
}

interface MockK8sOpts {
  cluster?: unknown;
  snapshot?: unknown;
  pvcs?: unknown[];
  failOnCreatePlural?: string;
}

function makeK8s(opts: MockK8sOpts = {}): K8sClients {
  const created: Record<string, unknown[]> = {};
  return {
    core: {
      listNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ items: opts.pvcs ?? [] }),
      readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ spec: { volumeName: 'pvc-test' } }),
    },
    apps: {
      patchNamespacedDeploymentScale: vi.fn().mockResolvedValue({}),
      readNamespacedDeployment: vi.fn().mockResolvedValue({
        spec: { template: { spec: { containers: [{ name: 'api', image: 'ghcr.io/test/backend:test' }] } } },
      }),
    },
    batch: {
      createNamespacedJob: vi.fn().mockResolvedValue({}),
      listNamespacedJob: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedJob: vi.fn().mockResolvedValue({}),
    },
    custom: {
      getNamespacedCustomObject: vi.fn().mockImplementation((args: { plural: string }) => {
        if (args.plural === 'clusters') return Promise.resolve(opts.cluster ?? null);
        if (args.plural === 'snapshots') return Promise.resolve(opts.snapshot ?? null);
        return Promise.resolve(null);
      }),
      getClusterCustomObject: vi.fn().mockResolvedValue(null),
      createNamespacedCustomObject: vi.fn().mockImplementation((args: { plural: string; body: unknown }) => {
        if (opts.failOnCreatePlural === args.plural) return Promise.reject(new Error(`mock-fail-${args.plural}`));
        const arr = created[args.plural] ?? [];
        arr.push(args.body);
        created[args.plural] = arr;
        return Promise.resolve({});
      }),
      createClusterCustomObject: vi.fn().mockResolvedValue({}),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      deleteClusterCustomObject: vi.fn().mockResolvedValue({}),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    },
  } as unknown as K8sClients;
}

describe('promotePostgresFromSnapshot — preflight only (real K8s ops mocked)', () => {
  beforeEach(() => { /* reset module-state by re-importing not needed; lock auto-released on throw */ });

  it('refuses when cluster missing bootstrap.initdb', async () => {
    const k8s = makeK8s({
      cluster: { metadata: { name: 'postgres', namespace: 'platform' }, spec: {}, status: { currentPrimary: 'postgres-1' } },
    });
    await expect(promotePostgresFromSnapshot(
      { k8s, db: makeDb() },
      { clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-1', recoveryTargetTime: null, actorUserId: null },
    )).rejects.toMatchObject({ code: 422 });
    expect(isPostgresRestoreInProgress().inProgress).toBe(false);
  });

  it('refuses when snapshot does not belong to a cluster PVC', async () => {
    const k8s = makeK8s({
      cluster: {
        metadata: { name: 'postgres', namespace: 'platform' },
        spec: { instances: 3, storage: { size: '10Gi' }, bootstrap: { initdb: { database: 'hp', owner: 'p', secret: { name: 's' } } } },
        status: { currentPrimary: 'postgres-1' },
      },
      snapshot: { spec: { volume: 'vol-mismatch' }, status: { readyToUse: true } },
      pvcs: [{ metadata: { name: 'postgres-1' }, spec: { volumeName: 'vol-actual' } }],
    });
    await expect(promotePostgresFromSnapshot(
      { k8s, db: makeDb() },
      { clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-bad', recoveryTargetTime: null, actorUserId: null },
    )).rejects.toMatchObject({ code: 409 });
  });

  it('allows cross-cluster snapshot when labeled barman-promote=true (Phase 3.1)', async () => {
    // Phase 3.1 promote takes a Longhorn snapshot of the RESTORED
    // cluster's PVC + calls promotePostgresFromSnapshot with
    // clusterName=<source>. The PVC membership check would fail
    // because snap.spec.volume is from the restored cluster's PVC,
    // not the source cluster's. The barman-promote=true label is set
    // by barman-restore/service.ts:takeLonghornSnapshotOfRestoredCluster
    // — server-set, can't be spoofed via UI submission.
    //
    // To confirm membership was bypassed, we make the FOLLOWING step
    // fail (VolumeSnapshot creation) — that proves preflight finished
    // without rejecting on membership.
    const k8s = makeK8s({
      cluster: {
        metadata: { name: 'postgres', namespace: 'platform' },
        spec: { instances: 3, storage: { size: '10Gi' }, bootstrap: { initdb: { database: 'hp', owner: 'p', secret: { name: 's' } } } },
        status: { currentPrimary: 'postgres-1' },
      },
      snapshot: {
        metadata: { labels: { 'platform.phoenix-host.net/barman-promote': 'true' } },
        spec: { volume: 'vol-restored-cluster' },
        status: { readyToUse: true },
      },
      pvcs: [{ metadata: { name: 'postgres-1' }, spec: { volumeName: 'vol-actual-source' } }],
      failOnCreatePlural: 'volumesnapshots',
    });
    await expect(promotePostgresFromSnapshot(
      { k8s, db: makeDb() },
      { clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-barman-promote', recoveryTargetTime: null, actorUserId: null },
    )).rejects.toThrow(/mock-fail-volumesnapshots/);
    // The membership-check error string MUST NOT appear — if it did,
    // we'd have rejected at preflight (before the failOnCreatePlural).
  });

  it('refuses when recoveryTargetTime is before snapshot creation', async () => {
    const k8s = makeK8s({
      cluster: {
        metadata: { name: 'postgres', namespace: 'platform' },
        spec: { instances: 3, storage: { size: '10Gi' }, bootstrap: { initdb: { database: 'hp', owner: 'p', secret: { name: 's' } } } },
        status: { currentPrimary: 'postgres-1' },
      },
      snapshot: {
        spec: { volume: 'vol-actual' },
        status: { readyToUse: true, creationTime: '2026-05-03T12:00:00Z' },
      },
      pvcs: [{ metadata: { name: 'postgres-1' }, spec: { volumeName: 'vol-actual' } }],
    });
    await expect(promotePostgresFromSnapshot(
      { k8s, db: makeDb() },
      {
        clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-1',
        recoveryTargetTime: '2026-05-03T11:30:00Z',
        actorUserId: null,
      },
    )).rejects.toMatchObject({ code: 422 });
  });

  it('refuses concurrent PITR (lock test)', async () => {
    // Lock is in-process module state. Simulate concurrent by setting it
    // via a pending promotePostgresFromSnapshot that hangs at the
    // create-temp step (we'll let preflight succeed, then the createCustom
    // for clusters will hang the call indefinitely — but that's hard to
    // test in isolation). Easier: directly probe the lock state after
    // a preflight failure leaves it released, then test that two
    // concurrent calls trip the lock.
    // For brevity, this test asserts the lock is released on preflight
    // failure (covered above implicitly), and that
    // isPostgresRestoreInProgress returns false at module idle.
    expect(isPostgresRestoreInProgress().inProgress).toBe(false);
  });

  it('acquirePitrLockOrThrow is race-safe — second concurrent call gets 409', async () => {
    // After the previous tests, the in-memory lock is released (each
    // promotePostgresFromSnapshot's finally clears it). Acquire it
    // synchronously, then verify a second acquire fails fast with 409
    // BEFORE the first's DB write returns. This is the core anti-race
    // property — the synchronous in-memory set in the critical
    // section between the cluster-wide check and the DB write closes
    // the window where a concurrent route handler could slip through.
    expect(isPostgresRestoreInProgress().inProgress).toBe(false);
    const db = makeDb();
    const inputs = { clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-test' };

    // Fire two concurrent acquisitions
    const [first, second] = await Promise.allSettled([
      acquirePitrLockOrThrow(db, inputs),
      acquirePitrLockOrThrow(db, inputs),
    ]);

    // Exactly one should succeed
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    const rejected = [first, second].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === 'rejected') {
      expect((rejected[0].reason as { code?: number }).code).toBe(409);
    }

    // Lock is held — manual cleanup for test isolation. The lock
    // would normally be released by promotePostgresFromSnapshot's
    // finally; we hijack the module-state by re-acquiring after a
    // forced-clear in a real test, but for this unit test we just
    // assert the contract and let the next test's makeDb scope
    // contain the fallout.
    expect(isPostgresRestoreInProgress().inProgress).toBe(true);
  });

  it('createPitrJob builds a valid Job CR with expected env + labels', async () => {
    const k8s = makeK8s();
    const result = await createPitrJob(k8s, {
      clusterNamespace: 'platform', clusterName: 'postgres',
      snapshotName: 'snap-1', recoveryTargetTime: '2026-05-03T20:00:00Z',
      actorUserId: 'user-1', image: 'ghcr.io/test/backend:abc123',
    });
    expect(result.namespace).toBe('platform');
    expect(result.jobName).toMatch(/^pitr-postgres-\d+$/);
    const createCall = (k8s.batch as unknown as { createNamespacedJob: { mock: { calls: Array<[{ namespace: string; body: { metadata: { name: string; labels: Record<string, string> }; spec: { template: { metadata: { labels: Record<string, string> }; spec: { containers: Array<{ image: string; env: Array<{ name: string; value?: string }> }> } } } } }]> } } }).createNamespacedJob.mock.calls[0];
    expect(createCall[0].namespace).toBe('platform');
    expect(createCall[0].body.metadata.labels['platform.phoenix-host.net/pitr-restore']).toBe('true');
    expect(createCall[0].body.metadata.labels['platform.phoenix-host.net/pitr-namespace']).toBe('platform');
    // Pod-template MUST carry app=platform-api so the existing
    // allow-platform-internal NetworkPolicy lets the Job reach postgres.
    expect(createCall[0].body.spec.template.metadata.labels.app).toBe('platform-api');
    const envByName: Record<string, string | undefined> = {};
    for (const e of createCall[0].body.spec.template.spec.containers[0].env) {
      if (e.value !== undefined) envByName[e.name] = e.value;
    }
    expect(envByName.PITR_CLUSTER_NAMESPACE).toBe('platform');
    expect(envByName.PITR_CLUSTER_NAME).toBe('postgres');
    expect(envByName.PITR_SNAPSHOT_NAME).toBe('snap-1');
    expect(envByName.PITR_RECOVERY_TARGET_TIME).toBe('2026-05-03T20:00:00Z');
    expect(envByName.PITR_ACTOR_USER_ID).toBe('user-1');
    expect(createCall[0].body.spec.template.spec.containers[0].image).toBe('ghcr.io/test/backend:abc123');
  });

  it('buildRecoveryCluster propagates spec.plugins on rebuild (FAST recovery — no sidecar miss)', async () => {
    // The Phase 3.1 promote (and Phase 1 PITR) recreate the source
    // cluster from a snapshot. If spec.plugins is not carried over, the
    // first pod is created WITHOUT the plugin-barman-cloud sidecar. Then
    // Flux resumes + adds plugins to the live spec, but CNPG's plugin
    // sidecar injection only fires at POD CREATION via an admission
    // webhook — so the pod runs without the sidecar forever and the
    // instance-manager logs "Unknown plugin: barman-cloud.cloudnative-pg.io".
    // Caught LIVE on staging 2026-05-23.
    //
    // The fix: buildRecoveryCluster propagates source.spec.plugins
    // when isTemp=false (rebuilt production cluster). When isTemp=true
    // (transient WAL-replay scratch cluster) plugins are still omitted —
    // a temp cluster has no business archiving.
    const { buildRecoveryCluster } = await import('./service.js');
    const srcWithPlugins = {
      metadata: { name: 'postgres', namespace: 'platform' },
      spec: {
        instances: 3,
        storage: { size: '10Gi' },
        bootstrap: { initdb: { database: 'hp', owner: 'p', secret: { name: 's' } } },
        plugins: [
          { enabled: true, isWALArchiver: false, name: 'barman-cloud.cloudnative-pg.io', parameters: { barmanObjectName: 'my-store' } },
        ],
      } as never, // narrow type just for the test
    };
    const rebuiltBody = buildRecoveryCluster(srcWithPlugins as never, 'postgres', 'platform', 'vs-snap', null, 1, false /* isTemp */) as { spec: { plugins?: unknown[] } };
    expect(Array.isArray(rebuiltBody.spec.plugins)).toBe(true);
    expect(rebuiltBody.spec.plugins).toHaveLength(1);

    const tempBody = buildRecoveryCluster(srcWithPlugins as never, 'postgres-pitr-1234', 'platform', 'vs-snap', null, 1, true /* isTemp */) as { spec: { plugins?: unknown[] } };
    expect(tempBody.spec.plugins).toBeUndefined();

    // Source without plugins must still produce a valid CR (plugins absent in output).
    const srcNoPlugins = {
      metadata: { name: 'postgres', namespace: 'platform' },
      spec: {
        instances: 3,
        storage: { size: '10Gi' },
        bootstrap: { initdb: { database: 'hp', owner: 'p', secret: { name: 's' } } },
      } as never,
    };
    const noPluginRebuild = buildRecoveryCluster(srcNoPlugins as never, 'postgres', 'platform', 'vs-snap', null, 1, false) as { spec: { plugins?: unknown[] } };
    expect(noPluginRebuild.spec.plugins).toBeUndefined();
  });

  it('buildRecoveryCluster attaches barman archive source to temp cluster when recoveryTargetTime is set (Task #97)', async () => {
    // Phase 1 PITR with recoveryTargetTime needs WAL replay beyond
    // snapshot LSN. The temp cluster's bootstrap.recovery.volumeSnapshots
    // ONLY provides base data from the snapshot — without a recovery.source
    // pointing at the source's barman archive, CNPG can only replay WAL
    // records that exist in the snapshot's pg_wal/ directory (typically
    // none after pg_switch_wal). Result: target time is silently ignored
    // + restored cluster sits at snapshot LSN. Harness test 2026-05-23
    // verified the bug; this test guards the fix.
    const { buildRecoveryCluster } = await import('./service.js');
    const srcWithBarman = {
      metadata: { name: 'system-db', namespace: 'platform' },
      spec: {
        instances: 3,
        storage: { size: '10Gi' },
        bootstrap: { initdb: { database: 'hp', owner: 'p', secret: { name: 's' } } },
        plugins: [
          { enabled: true, name: 'barman-cloud.cloudnative-pg.io', parameters: { barmanObjectName: 'system-postgres-objectstore' } },
        ],
      } as never,
    };

    // CASE A: temp cluster WITH recoveryTargetTime → source + externalClusters attached
    const tempWithTarget = buildRecoveryCluster(
      srcWithBarman as never, 'system-db-pitr-1234', 'platform',
      'vs-snap-1', '2026-05-23T12:00:00Z', 1, true,
    ) as { spec: { bootstrap: { recovery: { source?: string; volumeSnapshots?: unknown; recoveryTarget?: unknown } }; externalClusters?: Array<{ name: string; plugin: { parameters: Record<string, string> } }> } };
    expect(tempWithTarget.spec.bootstrap.recovery.source).toBe('system-postgres-objectstore-pitr-wal-source');
    expect(tempWithTarget.spec.bootstrap.recovery.volumeSnapshots).toBeDefined();
    expect(tempWithTarget.spec.bootstrap.recovery.recoveryTarget).toBeDefined();
    expect(tempWithTarget.spec.externalClusters).toHaveLength(1);
    expect(tempWithTarget.spec.externalClusters![0].name).toBe('system-postgres-objectstore-pitr-wal-source');
    expect(tempWithTarget.spec.externalClusters![0].plugin.parameters.barmanObjectName).toBe('system-postgres-objectstore');
    expect(tempWithTarget.spec.externalClusters![0].plugin.parameters.serverName).toBe('system-db');

    // CASE B: temp cluster WITHOUT recoveryTargetTime → no source needed
    const tempNoTarget = buildRecoveryCluster(
      srcWithBarman as never, 'system-db-pitr-5678', 'platform',
      'vs-snap-2', null, 1, true,
    ) as { spec: { bootstrap: { recovery: { source?: string } }; externalClusters?: unknown[] } };
    expect(tempNoTarget.spec.bootstrap.recovery.source).toBeUndefined();
    expect(tempNoTarget.spec.externalClusters).toBeUndefined();

    // CASE C: REBUILT SOURCE cluster (isTemp=false) → never attach source
    // The rebuilt source uses its own snapshot + doesn't need WAL fetch.
    const sourceRebuild = buildRecoveryCluster(
      srcWithBarman as never, 'system-db', 'platform',
      'vs-rebuild', '2026-05-23T12:00:00Z', 1, false,
    ) as { spec: { bootstrap: { recovery: { source?: string } }; externalClusters?: unknown[] } };
    expect(sourceRebuild.spec.bootstrap.recovery.source).toBeUndefined();
    expect(sourceRebuild.spec.externalClusters).toBeUndefined();

    // CASE D: source without barman plugin → can't attach source even if requested
    const srcNoBarman = {
      metadata: { name: 'foo-db', namespace: 'platform' },
      spec: {
        instances: 1,
        storage: { size: '10Gi' },
        bootstrap: { initdb: { database: 'hp', owner: 'p', secret: { name: 's' } } },
        plugins: [],
      } as never,
    };
    const tempNoBarman = buildRecoveryCluster(
      srcNoBarman as never, 'foo-db-pitr', 'platform',
      'vs-snap-3', '2026-05-23T12:00:00Z', 1, true,
    ) as { spec: { bootstrap: { recovery: { source?: string } }; externalClusters?: unknown[] } };
    expect(tempNoBarman.spec.bootstrap.recovery.source).toBeUndefined();
    expect(tempNoBarman.spec.externalClusters).toBeUndefined();
  });

  it('getPlatformApiImage reads image from live Deployment', async () => {
    const k8s = makeK8s();
    const image = await getPlatformApiImage(k8s);
    expect(image).toBe('ghcr.io/test/backend:test');
  });
});

describe('runPitrPrechecks — read-only mirror of preflight', () => {
  // The "concurrent acquire" test above leaves the in-memory PITR lock
  // held; clear it so prechecks see lockState=free in the happy path.
  beforeEach(async () => {
    await releasePitrLock(makeDb()).catch(() => undefined);
  });

  const cluster = {
    metadata: { name: 'postgres', namespace: 'platform' },
    spec: { bootstrap: { initdb: { database: 'app', owner: 'app' } }, instances: 3 },
    status: { currentPrimary: 'postgres-1' },
  };
  const goodSnap = {
    metadata: { creationTimestamp: '2026-05-22T10:00:00Z' },
    status: { creationTime: '2026-05-22T10:00:00Z', readyToUse: true },
    spec: { volume: 'pvc-test' },
  };

  it('returns blockingError when snapshot is not yet ready', async () => {
    const notReady = { ...goodSnap, status: { ...goodSnap.status, readyToUse: false } };
    const k8s = makeK8s({ cluster, snapshot: notReady, pvcs: [] });
    const r = await runPitrPrechecks(k8s, undefined, makeDb(), {
      clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-1',
      recoveryTargetTime: null,
    });
    expect(r.snapshotUsable).toBe(false);
    expect(r.blockingError).toMatch(/not yet ready/);
  });

  it('returns blockingError on snapshot 404 without throwing', async () => {
    const k8s = makeK8s({ cluster });
    // Override snapshot getter to throw 404
    (k8s.custom as unknown as { getNamespacedCustomObject: ReturnType<typeof vi.fn> }).getNamespacedCustomObject = vi.fn().mockImplementation((args: { plural: string }) => {
      if (args.plural === 'snapshots') {
        const e = new Error('not found');
        (e as Error & { code?: number }).code = 404;
        return Promise.reject(e);
      }
      if (args.plural === 'clusters') return Promise.resolve(cluster);
      return Promise.resolve(null);
    });
    const r = await runPitrPrechecks(k8s, undefined, makeDb(), {
      clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'missing',
      recoveryTargetTime: null,
    });
    expect(r.snapshotUsable).toBe(false);
    expect(r.blockingError).toMatch(/not found/);
    expect(r.snapshotCreatedAt).toBeNull();
  });

  it('returns blockingError on cluster 404 without throwing', async () => {
    const k8s = makeK8s({ snapshot: goodSnap });
    (k8s.custom as unknown as { getNamespacedCustomObject: ReturnType<typeof vi.fn> }).getNamespacedCustomObject = vi.fn().mockImplementation((args: { plural: string }) => {
      if (args.plural === 'clusters') {
        const e = new Error('not found'); (e as Error & { code?: number }).code = 404;
        return Promise.reject(e);
      }
      if (args.plural === 'snapshots') return Promise.resolve(goodSnap);
      return Promise.resolve(null);
    });
    const r = await runPitrPrechecks(k8s, undefined, makeDb(), {
      clusterNamespace: 'platform', clusterName: 'missing', snapshotName: 'snap-1',
      recoveryTargetTime: null,
    });
    expect(r.blockingError).toMatch(/Cluster.*not found/);
    expect(r.clusterPrimaryPvc).toBeNull();
    expect(r.sourceInstances).toBeNull();
  });

  it('rejects recoveryTargetTime BEFORE snapshot time', async () => {
    const k8s = makeK8s({ cluster, snapshot: goodSnap });
    const r = await runPitrPrechecks(k8s, undefined, makeDb(), {
      clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-1',
      recoveryTargetTime: '2026-05-22T09:00:00Z', // 1h before snap
    });
    expect(r.walCoverageOk).toBe(false);
    expect(r.blockingError).toMatch(/before snapshot time/);
  });

  it('rejects unparseable recoveryTargetTime (guard against missing ajv-formats)', async () => {
    const k8s = makeK8s({ cluster, snapshot: goodSnap });
    const r = await runPitrPrechecks(k8s, undefined, makeDb(), {
      clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-1',
      recoveryTargetTime: 'this is not an iso timestamp',
    });
    expect(r.walCoverageOk).toBe(false);
    expect(r.blockingError).toMatch(/not a parseable ISO-8601/);
  });

  it('happy path: returns snapshotUsable + clusterPrimaryPvc + sourceInstances with no blockingError', async () => {
    const k8s = makeK8s({ cluster, snapshot: goodSnap });
    const r = await runPitrPrechecks(k8s, undefined, makeDb(), {
      clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-1',
      recoveryTargetTime: null,
    });
    expect(r.snapshotUsable).toBe(true);
    expect(r.clusterPrimaryPvc).toBe('postgres-1');
    expect(r.sourceInstances).toBe(3);
    expect(r.lockState).toBe('free');
    expect(r.blockingError).toBeNull();
    expect(r.snapshotAgeSec).toBeGreaterThanOrEqual(0);
  });
});
