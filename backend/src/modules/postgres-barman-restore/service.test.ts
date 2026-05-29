import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createBarmanRestore,
  getBarmanRestoreStatus,
  deleteBarmanRestore,
  BarmanRestoreError,
} from './service.js';
import type * as k8s from '@kubernetes/client-node';

interface MockState {
  source?: unknown;
  newCluster?: unknown;
  sourceNotFound?: boolean;
  newClusterExists?: boolean;
  createFails?: boolean;
}

function makeCustom(state: MockState = {}): {
  api: k8s.CustomObjectsApi;
  created: unknown[];
  deleted: Array<{ namespace: string; name: string }>;
} {
  const created: unknown[] = [];
  const deleted: Array<{ namespace: string; name: string }> = [];
  const api = {
    getNamespacedCustomObject: vi.fn().mockImplementation(async (args: { name: string; plural: string }) => {
      if (args.plural !== 'clusters') return null;
      if (state.newClusterExists === false && args.name !== 'system-db') {
        const e = new Error('not found'); (e as Error & { code?: number }).code = 404; throw e;
      }
      if (args.name === 'system-db') {
        if (state.sourceNotFound) {
          const e = new Error('not found'); (e as Error & { code?: number }).code = 404; throw e;
        }
        return state.source ?? null;
      }
      // Any other name: by default it's the new cluster name and we want it to NOT exist
      if (state.newClusterExists) return state.newCluster ?? { metadata: { name: args.name } };
      const e = new Error('not found'); (e as Error & { code?: number }).code = 404; throw e;
    }),
    createNamespacedCustomObject: vi.fn().mockImplementation(async (args: { body: { metadata?: { name?: string } } }) => {
      if (state.createFails) {
        const e = new Error('AlreadyExists'); (e as Error & { code?: number }).code = 409; throw e;
      }
      created.push(args.body);
      return { metadata: { ...(args.body.metadata ?? {}), uid: 'uid-test-1234' } };
    }),
    deleteNamespacedCustomObject: vi.fn().mockImplementation(async (args: { namespace: string; name: string }) => {
      deleted.push({ namespace: args.namespace, name: args.name });
      return {};
    }),
  } as unknown as k8s.CustomObjectsApi;
  return { api, created, deleted };
}

const sourceCluster = {
  metadata: { name: 'system-db', namespace: 'platform', uid: 'src-uid' },
  spec: {
    instances: 3,
    imageName: 'ghcr.io/cloudnative-pg/postgresql:18.3-minimal-trixie',
    storage: { storageClass: 'longhorn-r3', size: '10Gi' },
    bootstrap: { initdb: { database: 'app', owner: 'app' } },
    plugins: [
      {
        name: 'barman-cloud.cloudnative-pg.io',
        enabled: true,
        parameters: { barmanObjectName: 'system-postgres-objectstore' },
      },
    ],
  },
};

describe('createBarmanRestore', () => {
  // Skip the WAL-gap fresh-backup mitigation in tests — those tests
  // don't mock the Backup CR's status.phase='completed' transition so
  // the poll would loop until timeout. Explicit BARMAN_RESTORE_SKIP_
  // FRESH_BACKUP=true keeps the existing happy-path tests fast +
  // focused on the Cluster CR shape. Dedicated tests for the
  // mitigation live below in `describe('fresh-backup mitigation')`.
  beforeEach(() => {
    process.env.BARMAN_RESTORE_SKIP_FRESH_BACKUP = 'true';
  });

  it('validates that newClusterName differs from sourceClusterName', async () => {
    const { api } = makeCustom();
    await expect(createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'system-db',
      recoveryTargetTime: null,
    })).rejects.toThrow(/MUST differ/);
  });

  it('rejects unparseable recoveryTargetTime', async () => {
    const { api } = makeCustom();
    await expect(createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-1',
      recoveryTargetTime: 'not-an-iso-date',
    })).rejects.toThrow(/parseable ISO/);
  });

  it('rejects invalid instances count', async () => {
    const { api } = makeCustom();
    await expect(createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-1',
      recoveryTargetTime: null, instances: 0,
    })).rejects.toThrow(/instances/);
    await expect(createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-1',
      recoveryTargetTime: null, instances: 10,
    })).rejects.toThrow(/instances/);
  });

  it('404 source returns BarmanRestoreError 404', async () => {
    const { api } = makeCustom({ sourceNotFound: true });
    await expect(createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-1',
      recoveryTargetTime: null,
    })).rejects.toMatchObject({ code: 404 });
  });

  it('refuses when source does not have a barman-cloud plugin', async () => {
    const noPluginSource = {
      ...sourceCluster,
      spec: { ...sourceCluster.spec, plugins: [] },
    };
    const { api } = makeCustom({ source: noPluginSource });
    await expect(createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-1',
      recoveryTargetTime: null,
    })).rejects.toThrow(/does not use the barman-cloud plugin/);
  });

  it('happy path: builds CR with bootstrap.recovery + externalClusters + plugins', async () => {
    const { api, created } = makeCustom({ source: sourceCluster });
    const r = await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-1',
      recoveryTargetTime: '2026-05-22T03:00:00Z',
    });
    expect(r.newClusterName).toBe('restored-1');
    expect(r.objectStoreName).toBe('system-postgres-objectstore');
    expect(r.recoveryTargetTime).toBe('2026-05-22T03:00:00Z');
    expect(r.clusterUid).toBe('uid-test-1234');
    expect(created).toHaveLength(1);
    const cr = created[0] as Record<string, unknown>;
    expect((cr.metadata as { name: string }).name).toBe('restored-1');
    expect((cr.metadata as { labels: Record<string, string> }).labels['app.kubernetes.io/managed-by']).toBe('platform-api-postgres-barman-restore');
    const spec = cr.spec as {
      instances: number;
      bootstrap: { recovery: { source: string; recoveryTarget?: { targetTime: string } } };
      externalClusters: Array<{ name: string; plugin: { name: string; parameters: Record<string, unknown> } }>;
    };
    // P4a (2026-05-22): default inherits source.spec.instances when caller
    // doesn't pass explicit instances. Source has instances=3 (HA), so the
    // restore creates a 3-replica side-by-side cluster matching that.
    expect(spec.instances).toBe(3);
    expect(spec.bootstrap.recovery.source).toBe('system-postgres-objectstore-recovery-source');
    expect(spec.bootstrap.recovery.recoveryTarget?.targetTime).toBe('2026-05-22T03:00:00Z');
    expect(spec.externalClusters[0].name).toBe('system-postgres-objectstore-recovery-source');
    expect(spec.externalClusters[0].plugin.name).toBe('barman-cloud.cloudnative-pg.io');
    expect(spec.externalClusters[0].plugin.parameters.barmanObjectName).toBe('system-postgres-objectstore');
    // The plugin needs serverName=source so it resolves backups
    // against the correct path in the archive. Without this the
    // CNPG plugin defaults serverName to the NEW cluster name and
    // can't find any backups (verified on staging 2026-05-22).
    expect((spec.externalClusters[0].plugin.parameters as { serverName?: string }).serverName).toBe('system-db');
  });

  it('happy path without recoveryTargetTime omits recoveryTarget (restores to latest)', async () => {
    const { api, created } = makeCustom({ source: sourceCluster });
    await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-latest',
      recoveryTargetTime: null,
    });
    const spec = (created[0] as { spec: { bootstrap: { recovery: Record<string, unknown> } } }).spec;
    expect(spec.bootstrap.recovery.recoveryTarget).toBeUndefined();
  });

  it('inherits affinity/nodeSelector/tolerations from source — restored pods schedule on the same node class', async () => {
    const withScheduling = {
      ...sourceCluster,
      spec: {
        ...sourceCluster.spec,
        affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: {} } },
        nodeSelector: { 'insula.host/node-role': 'server' },
        tolerations: [{ key: 'insula.host/server-only', operator: 'Exists', effect: 'NoSchedule' }],
      },
    };
    const { api, created } = makeCustom({ source: withScheduling });
    await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-sched',
      recoveryTargetTime: null,
    });
    const spec = (created[0] as { spec: Record<string, unknown> }).spec;
    expect(spec.affinity).toEqual(withScheduling.spec.affinity);
    expect(spec.nodeSelector).toEqual(withScheduling.spec.nodeSelector);
    expect(spec.tolerations).toEqual(withScheduling.spec.tolerations);
  });

  it('does NOT propagate source.spec.plugins to the new cluster — verify cluster never archives back', async () => {
    const { api, created } = makeCustom({ source: sourceCluster });
    await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-noplugin',
      recoveryTargetTime: null,
    });
    const spec = (created[0] as { spec: Record<string, unknown> }).spec;
    // The new cluster MUST NOT carry `plugins` — that would archive its
    // own WAL into the same ObjectStore as source, confusing operators
    // and wasting bytes on a verify-and-discard cluster.
    expect(spec.plugins).toBeUndefined();
  });

  it('P4a: explicit instances still overrides source.spec.instances inheritance', async () => {
    const { api, created } = makeCustom({ source: sourceCluster });
    await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-override',
      recoveryTargetTime: null, instances: 1,
    });
    expect((created[0] as { spec: { instances: number } }).spec.instances).toBe(1);
  });

  it('P4a: single-instance source → restore defaults to 1 (no upgrade)', async () => {
    const singleSource = { ...sourceCluster, spec: { ...sourceCluster.spec, instances: 1 } };
    const { api, created } = makeCustom({ source: singleSource });
    await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-single',
      recoveryTargetTime: null,
    });
    expect((created[0] as { spec: { instances: number } }).spec.instances).toBe(1);
  });

  it('refuses when newClusterName already exists (returns 409)', async () => {
    const { api } = makeCustom({ source: sourceCluster, newClusterExists: true });
    await expect(createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-1',
      recoveryTargetTime: null,
    })).rejects.toMatchObject({ code: 409 });
  });

  // ── Unit C DR overrides ──────────────────────────────────────────────
  // The DR flow points at the OLD cluster's archive (recorded in the
  // bundle) — which may have a different serverName + objectStore from
  // the freshly-bootstrapped source. The overrides let DR pass the
  // bundle values verbatim. These tests pin the wiring: without them
  // a future refactor that drops the override would silently misroute
  // bootstrap.recovery to the wrong (empty) archive.

  it('serverNameOverride wins over sourceClusterName in externalClusters[]', async () => {
    const { api, created } = makeCustom({ source: sourceCluster });
    await createBarmanRestore(api, {
      namespace: 'platform',
      sourceClusterName: 'system-db',
      newClusterName: 'restored-dr',
      recoveryTargetTime: null,
      serverNameOverride: 'old-cluster-archive',
    });
    expect(created).toHaveLength(1);
    const params = (created[0] as any).spec.externalClusters[0].plugin.parameters;
    expect(params.serverName).toBe('old-cluster-archive');
  });

  it('objectStoreOverride wins over source plugin parameter', async () => {
    const { api, created } = makeCustom({ source: sourceCluster });
    await createBarmanRestore(api, {
      namespace: 'platform',
      sourceClusterName: 'system-db',
      newClusterName: 'restored-dr-2',
      recoveryTargetTime: null,
      objectStoreOverride: 'old-cluster-objectstore',
    });
    expect(created).toHaveLength(1);
    const params = (created[0] as any).spec.externalClusters[0].plugin.parameters;
    expect(params.barmanObjectName).toBe('old-cluster-objectstore');
  });

  it('skipFreshBackup honours per-call flag even without the env var', async () => {
    // Re-disable the env-driven skip so the per-call flag is the only
    // signal that suppresses the fresh-backup mitigation.
    delete process.env.BARMAN_RESTORE_SKIP_FRESH_BACKUP;
    const { api, created } = makeCustom({ source: sourceCluster });
    const result = await createBarmanRestore(api, {
      namespace: 'platform',
      sourceClusterName: 'system-db',
      newClusterName: 'restored-dr-3',
      recoveryTargetTime: '2026-05-22T12:00:00Z',
      skipFreshBackup: true,
    });
    // With skipFreshBackup=true, NO Backup CR was created (only the
    // restored Cluster CR). The mock collects every createNamespacedCustomObject
    // call into `created`; a non-skipped run would have a Backup + a Cluster.
    expect(created.filter((c: any) => c.kind === 'Backup')).toHaveLength(0);
    expect(result.freshBackupTriggered).toBe(false);
    expect(result.freshBackupId).toBeNull();
    // Restore the test default for downstream tests.
    process.env.BARMAN_RESTORE_SKIP_FRESH_BACKUP = 'true';
  });
});

describe('getBarmanRestoreStatus', () => {
  it('returns 404 when cluster missing', async () => {
    const { api } = makeCustom({ newClusterExists: false });
    await expect(getBarmanRestoreStatus(api, 'platform', 'gone')).rejects.toMatchObject({ code: 404 });
  });

  it('refuses unmanaged clusters (403)', async () => {
    const { api } = makeCustom({
      newClusterExists: true,
      newCluster: { metadata: { name: 'foreign', namespace: 'platform', labels: {} } },
    });
    await expect(getBarmanRestoreStatus(api, 'platform', 'foreign')).rejects.toMatchObject({ code: 403 });
  });

  it('happy path: returns status with conditions + ready', async () => {
    const { api } = makeCustom({
      newClusterExists: true,
      newCluster: {
        metadata: { name: 'restored-1', namespace: 'platform', labels: { 'app.kubernetes.io/managed-by': 'platform-api-postgres-barman-restore' } },
        spec: { instances: 1 },
        status: {
          phase: 'Cluster in healthy state',
          readyInstances: 1,
          instances: 1,
          currentPrimary: 'restored-1-1',
          conditions: [{ type: 'Ready', status: 'True', reason: 'ClusterReady', message: 'OK', lastTransitionTime: '2026-05-22T16:00:00Z' }],
        },
      },
    });
    const r = await getBarmanRestoreStatus(api, 'platform', 'restored-1');
    expect(r.phase).toMatch(/healthy/);
    expect(r.ready).toBe(true);
    expect(r.conditions).toHaveLength(1);
  });

  it('ready=false during bootstrap', async () => {
    const { api } = makeCustom({
      newClusterExists: true,
      newCluster: {
        metadata: { name: 'restored-1', namespace: 'platform', labels: { 'app.kubernetes.io/managed-by': 'platform-api-postgres-barman-restore' } },
        spec: { instances: 1 },
        status: { phase: 'Setting up primary', readyInstances: 0, instances: 1 },
      },
    });
    const r = await getBarmanRestoreStatus(api, 'platform', 'restored-1');
    expect(r.ready).toBe(false);
  });
});

describe('createBarmanRestore — fresh-backup mitigation (WAL-gap mitigation 2026-05-23)', () => {
  // Re-enable the mitigation for these tests; the suite-default beforeEach
  // above disabled it. Use a TIGHT timeout so the test fails fast if the
  // wait-loop misbehaves instead of stalling for minutes.
  beforeEach(() => {
    delete process.env.BARMAN_RESTORE_SKIP_FRESH_BACKUP;
    process.env.BARMAN_FRESH_BACKUP_TIMEOUT_MS = '2000'; // 2s for tests
  });

  function makeCustomWithBackup(state: MockState & {
    backupPhase?: 'pending' | 'running' | 'completed' | 'failed';
    backupError?: string;
    backupCreateFails?: boolean;
  }): {
    api: k8s.CustomObjectsApi;
    created: unknown[];
    backupsCreated: unknown[];
  } {
    const created: unknown[] = [];
    const backupsCreated: unknown[] = [];
    const api = {
      getNamespacedCustomObject: vi.fn().mockImplementation(async (args: { name: string; plural: string }) => {
        if (args.plural === 'clusters') {
          if (args.name === 'system-db') return state.source ?? null;
          const e = new Error('not found'); (e as Error & { code?: number }).code = 404; throw e;
        }
        if (args.plural === 'backups') {
          return {
            metadata: { name: args.name },
            status: {
              phase: state.backupPhase ?? 'pending',
              error: state.backupError,
            },
          };
        }
        return null;
      }),
      createNamespacedCustomObject: vi.fn().mockImplementation(async (args: { plural: string; body: unknown }) => {
        if (args.plural === 'backups') {
          if (state.backupCreateFails) {
            const e = new Error('Backup creation forbidden'); (e as Error & { code?: number }).code = 403; throw e;
          }
          backupsCreated.push(args.body);
          return { metadata: { name: (args.body as { metadata?: { name?: string } }).metadata?.name } };
        }
        created.push(args.body);
        return { metadata: { ...(args.body as { metadata?: Record<string, unknown> }).metadata, uid: 'uid-1' } };
      }),
    } as unknown as k8s.CustomObjectsApi;
    return { api, created, backupsCreated };
  }

  it('skips fresh-backup when recoveryTargetTime is null (no WAL replay needed)', async () => {
    const { api, backupsCreated } = makeCustomWithBackup({ source: sourceCluster });
    const r = await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-no-wal',
      recoveryTargetTime: null,
    });
    expect(r.freshBackupTriggered).toBe(false);
    expect(r.freshBackupId).toBeNull();
    expect(r.freshBackupWarning).toBeNull();
    expect(backupsCreated).toHaveLength(0);
  });

  it('triggers fresh-backup + reports completion when recoveryTargetTime is set + backup completes', async () => {
    const { api, backupsCreated } = makeCustomWithBackup({
      source: sourceCluster,
      backupPhase: 'completed',
    });
    const r = await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-wal-ok',
      recoveryTargetTime: '2026-05-23T12:00:00Z',
    });
    expect(r.freshBackupTriggered).toBe(true);
    expect(r.freshBackupId).toMatch(/^pre-restore-\d+$/);
    expect(r.freshBackupWarning).toBeNull();
    expect(backupsCreated).toHaveLength(1);
    const bk = backupsCreated[0] as { spec: { cluster: { name: string }; method: string } };
    expect(bk.spec.cluster.name).toBe('system-db');
    expect(bk.spec.method).toBe('plugin');
  });

  it('surfaces warning + continues when fresh-backup CREATE fails', async () => {
    const { api, created } = makeCustomWithBackup({
      source: sourceCluster,
      backupCreateFails: true,
    });
    const r = await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-bk-fail',
      recoveryTargetTime: '2026-05-23T12:00:00Z',
    });
    expect(r.freshBackupTriggered).toBe(true);
    expect(r.freshBackupId).toBeNull();
    expect(r.freshBackupWarning).toMatch(/Pre-restore backup could not be triggered/);
    // CRUCIAL: restore proceeded (Cluster CR was still created) — non-fatal warning.
    expect(created).toHaveLength(1);
  });

  it('surfaces warning + continues when fresh-backup TIMES OUT', async () => {
    const { api, created } = makeCustomWithBackup({
      source: sourceCluster,
      backupPhase: 'pending', // never transitions to completed within 2s timeout
    });
    const r = await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-bk-timeout',
      recoveryTargetTime: '2026-05-23T12:00:00Z',
    });
    expect(r.freshBackupTriggered).toBe(true);
    expect(r.freshBackupId).toBeNull();
    expect(r.freshBackupWarning).toMatch(/did not complete within/);
    expect(created).toHaveLength(1);
  });

  it('surfaces warning + continues when fresh-backup ENTERS failed phase', async () => {
    const { api, created } = makeCustomWithBackup({
      source: sourceCluster,
      backupPhase: 'failed',
      backupError: 'mocked: object store unreachable',
    });
    const r = await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-bk-failed',
      recoveryTargetTime: '2026-05-23T12:00:00Z',
    });
    expect(r.freshBackupTriggered).toBe(true);
    expect(r.freshBackupId).toBeNull();
    expect(r.freshBackupWarning).toMatch(/mocked: object store unreachable/);
    expect(created).toHaveLength(1);
  });

  it('honors BARMAN_RESTORE_SKIP_FRESH_BACKUP env override', async () => {
    process.env.BARMAN_RESTORE_SKIP_FRESH_BACKUP = 'true';
    const { api, backupsCreated } = makeCustomWithBackup({ source: sourceCluster });
    const r = await createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-skipped',
      recoveryTargetTime: '2026-05-23T12:00:00Z',
    });
    expect(r.freshBackupTriggered).toBe(false);
    expect(backupsCreated).toHaveLength(0);
  });
});

describe('deleteBarmanRestore', () => {
  it('returns deleted=false on 404 (idempotent)', async () => {
    const { api } = makeCustom({ newClusterExists: false });
    const r = await deleteBarmanRestore(api, 'platform', 'gone');
    expect(r.deleted).toBe(false);
  });

  it('refuses to delete unmanaged clusters (403)', async () => {
    const { api } = makeCustom({
      newClusterExists: true,
      newCluster: { metadata: { name: 'foreign', namespace: 'platform', labels: {} } },
    });
    await expect(deleteBarmanRestore(api, 'platform', 'foreign')).rejects.toMatchObject({ code: 403 });
  });

  it('deletes the cluster when managed-by label matches', async () => {
    const { api, deleted } = makeCustom({
      newClusterExists: true,
      newCluster: { metadata: { name: 'restored-1', namespace: 'platform', labels: { 'app.kubernetes.io/managed-by': 'platform-api-postgres-barman-restore' } } },
    });
    const r = await deleteBarmanRestore(api, 'platform', 'restored-1');
    expect(r.deleted).toBe(true);
    expect(deleted).toEqual([{ namespace: 'platform', name: 'restored-1' }]);
  });
});

// ─── Phase 3.1 (2026-05-23) — Promote ──────────────────────────────────────

import { promoteRestoredCluster } from './service.js';

// Mock the postgres-restore primitives used by promoteRestoredCluster.
// vi.hoisted is required to give the mock factories access to the
// module-scoped state these tests inspect (lock-acquire calls, etc.).
const promoteMocks = vi.hoisted(() => ({
  acquirePitrLockOrThrowSpy: vi.fn(),
  releasePitrLockSpy: vi.fn(),
  createPitrJobSpy: vi.fn(),
  getPlatformApiImageSpy: vi.fn(),
  isPostgresRestoreInProgressClusterWideSpy: vi.fn(),
}));
vi.mock('../postgres-restore/service.js', () => ({
  acquirePitrLockOrThrow: promoteMocks.acquirePitrLockOrThrowSpy,
  releasePitrLock: promoteMocks.releasePitrLockSpy,
  createPitrJob: promoteMocks.createPitrJobSpy,
  getPlatformApiImage: promoteMocks.getPlatformApiImageSpy,
  isPostgresRestoreInProgressClusterWide: promoteMocks.isPostgresRestoreInProgressClusterWideSpy,
}));

function defaultPromoteMocks(): void {
  promoteMocks.acquirePitrLockOrThrowSpy.mockReset().mockResolvedValue({ startedAt: new Date() });
  promoteMocks.releasePitrLockSpy.mockReset().mockResolvedValue(undefined);
  promoteMocks.createPitrJobSpy.mockReset().mockResolvedValue({
    jobName: 'pitr-system-db-12345', namespace: 'platform',
  });
  promoteMocks.getPlatformApiImageSpy.mockReset().mockResolvedValue('ghcr.io/test/backend:abc123');
  promoteMocks.isPostgresRestoreInProgressClusterWideSpy.mockReset().mockResolvedValue({ inProgress: false, source: 'none' });
}

interface PromoteMockOpts {
  readonly restoredManagedBy?: string;
  readonly restoredReadyInstances?: number;
  readonly restoredPrimary?: string;
  readonly restoredNotFound?: boolean;
  readonly sourceMissing?: boolean;
  readonly sourceBootstrap?: unknown;
  readonly pvcVolumeName?: string;
  readonly snapshotReady?: boolean;
  readonly snapshotCreateFails?: boolean;
}

interface PromoteDepsOut {
  readonly deps: Parameters<typeof promoteRestoredCluster>[0];
  readonly createdSnapshots: unknown[];
  readonly deletedSnapshots: string[];
}

function makePromoteDeps(opts: PromoteMockOpts = {}): PromoteDepsOut {
  const createdSnapshots: unknown[] = [];
  const deletedSnapshots: string[] = [];
  const custom = {
    getNamespacedCustomObject: vi.fn().mockImplementation(async (args: { name: string; plural: string }) => {
      if (args.plural === 'clusters') {
        if (args.name === 'restored-1') {
          if (opts.restoredNotFound) {
            const e = new Error('not found'); (e as Error & { code?: number }).code = 404; throw e;
          }
          return {
            metadata: { name: 'restored-1', labels: { 'app.kubernetes.io/managed-by': opts.restoredManagedBy ?? 'platform-api-postgres-barman-restore' } },
            status: { readyInstances: opts.restoredReadyInstances ?? 1, currentPrimary: opts.restoredPrimary ?? 'restored-1-1' },
          };
        }
        if (args.name === 'system-db') {
          if (opts.sourceMissing) {
            const e = new Error('not found'); (e as Error & { code?: number }).code = 404; throw e;
          }
          return {
            spec: { bootstrap: opts.sourceBootstrap ?? { initdb: { database: 'app', owner: 'app' } } },
          };
        }
      }
      if (args.plural === 'snapshots') {
        return { status: { readyToUse: opts.snapshotReady ?? true } };
      }
      return null;
    }),
    createNamespacedCustomObject: vi.fn().mockImplementation(async (args: { body: { metadata?: { name?: string } } }) => {
      if (opts.snapshotCreateFails) {
        throw new Error('Longhorn-side allocation failure');
      }
      createdSnapshots.push(args.body);
      return { metadata: { ...(args.body.metadata ?? {}), uid: 'snap-uid' } };
    }),
    deleteNamespacedCustomObject: vi.fn().mockImplementation(async (args: { name: string }) => {
      deletedSnapshots.push(args.name);
    }),
  } as unknown as k8s.CustomObjectsApi;

  const core = {
    readNamespacedPersistentVolumeClaim: vi.fn().mockImplementation(async () => ({
      spec: { volumeName: opts.pvcVolumeName ?? 'pvc-test-vol' },
    })),
  } as unknown as k8s.CoreV1Api;

  const apps = {} as unknown as k8s.AppsV1Api;
  const batch = {} as unknown as k8s.BatchV1Api;
  const networking = {} as unknown as k8s.NetworkingV1Api;
  const rbac = {} as unknown as k8s.RbacAuthorizationV1Api;
  const storage = {} as unknown as k8s.StorageV1Api;
  const db = {} as never;
  return {
    deps: { k8s: { custom, core, apps, batch, networking, rbac, storage }, db },
    createdSnapshots,
    deletedSnapshots,
  };
}

describe('promoteRestoredCluster', () => {
  beforeEach(() => {
    defaultPromoteMocks();
  });

  it('rejects when confirmSourceClusterName mismatches sourceClusterName', async () => {
    const { deps } = makePromoteDeps();
    await expect(promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'restored-1', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'wrong', actorUserId: null,
    })).rejects.toMatchObject({ code: 409, message: expect.stringMatching(/confirmSourceClusterName/) });
  });

  it('rejects when restored cluster lacks managed-by label', async () => {
    const { deps } = makePromoteDeps({ restoredManagedBy: 'some-other-controller' });
    await expect(promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'restored-1', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db', actorUserId: null,
    })).rejects.toMatchObject({ code: 403 });
  });

  it('rejects when restored cluster is not Ready', async () => {
    const { deps } = makePromoteDeps({ restoredReadyInstances: 0 });
    await expect(promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'restored-1', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db', actorUserId: null,
    })).rejects.toMatchObject({ code: 409, message: expect.stringMatching(/not Ready/) });
  });

  it('rejects when source cluster missing', async () => {
    const { deps } = makePromoteDeps({ sourceMissing: true });
    await expect(promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'restored-1', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db', actorUserId: null,
    })).rejects.toMatchObject({ code: 404 });
  });

  it('rejects when source cluster lacks spec.bootstrap.initdb', async () => {
    const { deps } = makePromoteDeps({ sourceBootstrap: { recovery: {} } });
    await expect(promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'restored-1', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db', actorUserId: null,
    })).rejects.toMatchObject({ code: 422, message: expect.stringMatching(/initdb/) });
  });

  it('rejects when PITR lock already held', async () => {
    promoteMocks.isPostgresRestoreInProgressClusterWideSpy.mockResolvedValue({
      inProgress: true, snapshot: 'other-pitr', source: 'db',
    });
    const { deps } = makePromoteDeps();
    await expect(promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'restored-1', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db', actorUserId: null,
    })).rejects.toMatchObject({ code: 409, message: expect.stringMatching(/already in progress/) });
  });

  it('releases lock when snapshot-take fails', async () => {
    const { deps } = makePromoteDeps({ snapshotCreateFails: true });
    await expect(promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'restored-1', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db', actorUserId: null,
    })).rejects.toThrow();
    expect(promoteMocks.releasePitrLockSpy).toHaveBeenCalledTimes(1);
    expect(promoteMocks.createPitrJobSpy).not.toHaveBeenCalled();
  });

  it('releases lock when createPitrJob fails', async () => {
    promoteMocks.createPitrJobSpy.mockRejectedValue(new Error('Job-create network failure'));
    const { deps } = makePromoteDeps();
    await expect(promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'restored-1', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db', actorUserId: null,
    })).rejects.toMatchObject({ code: 500 });
    expect(promoteMocks.releasePitrLockSpy).toHaveBeenCalledTimes(1);
  });

  it('happy path: takes snapshot + creates Job with BARMAN_PROMOTE env vars', async () => {
    const { deps, createdSnapshots } = makePromoteDeps();
    const r = await promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'restored-1', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db', actorUserId: 'op-user-id',
    });
    expect(r.snapshotName).toMatch(/^barman-promote-/);
    expect(r.jobName).toBe('pitr-system-db-12345');
    expect(r.sourceClusterName).toBe('system-db');
    expect(r.restoredClusterName).toBe('restored-1');
    // Longhorn snapshot CR was created with correct labels.
    expect(createdSnapshots).toHaveLength(1);
    const snap = createdSnapshots[0] as Record<string, unknown>;
    const metadata = snap.metadata as { labels?: Record<string, string>; name?: string };
    expect(metadata.labels?.['insula.host/pitr-restore']).toBe('true');
    expect(metadata.labels?.['insula.host/barman-promote']).toBe('true');
    // PITR Job was created with the source name + BARMAN_PROMOTE env vars.
    const createPitrCall = promoteMocks.createPitrJobSpy.mock.calls[0]?.[1] as { extraEnv?: ReadonlyArray<{ name: string; value: string }>; clusterName: string };
    expect(createPitrCall.clusterName).toBe('system-db');
    expect(createPitrCall.extraEnv).toContainEqual({ name: 'BARMAN_PROMOTE_MODE', value: 'true' });
    expect(createPitrCall.extraEnv).toContainEqual({ name: 'BARMAN_PROMOTE_RESTORED_CLUSTER', value: 'restored-1' });
    expect(promoteMocks.releasePitrLockSpy).not.toHaveBeenCalled();
  });

  it('rejects when restoredClusterName === sourceClusterName (defense-in-depth)', async () => {
    const { deps } = makePromoteDeps();
    await expect(promoteRestoredCluster(deps, {
      namespace: 'platform', restoredClusterName: 'system-db', sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db', actorUserId: null,
    })).rejects.toMatchObject({ code: 400 });
  });
});
