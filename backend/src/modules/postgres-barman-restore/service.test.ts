import { describe, it, expect, vi } from 'vitest';
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
    expect(spec.instances).toBe(1); // default
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
        nodeSelector: { 'platform.phoenix-host.net/node-role': 'server' },
        tolerations: [{ key: 'platform.phoenix-host.net/server-only', operator: 'Exists', effect: 'NoSchedule' }],
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

  it('refuses when newClusterName already exists (returns 409)', async () => {
    const { api } = makeCustom({ source: sourceCluster, newClusterExists: true });
    await expect(createBarmanRestore(api, {
      namespace: 'platform', sourceClusterName: 'system-db', newClusterName: 'restored-1',
      recoveryTargetTime: null,
    })).rejects.toMatchObject({ code: 409 });
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
