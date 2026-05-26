/**
 * Unit tests for cnpg-recovery (Unit C.1).
 *
 * Real CNPG recovery requires a multi-node cluster with Longhorn +
 * barman-cloud + a populated WAL archive — that's staging E2E, not a
 * Vitest harness. These tests exercise the orchestrator's preflight +
 * sequencing + failure paths with mocked K8s clients.
 */

import { describe, it, expect, vi } from 'vitest';
import { runCnpgRecovery, CnpgRecoveryError } from './cnpg-recovery.js';
import type { CnpgRecoveryOpts } from './cnpg-recovery.js';
import type { CnpgRecoveryPointer } from '@k8s-hosting/api-contracts';

// Tiny stand-in for K8sClients — only the fields cnpg-recovery touches.
function makeK8sStub(opts: {
  clusterExists?: boolean;
  objectStoreExists?: boolean;
  sideBySideReady?: boolean;
  promoteJobSucceeds?: boolean;
}) {
  const custom = {
    getNamespacedCustomObject: vi.fn(async (req: { plural: string; name: string }) => {
      // Side-by-side cluster status poll: returns ready=true after one call
      if (req.plural === 'clusters' && req.name.includes('-dr-')) {
        return {
          metadata: { labels: { 'app.kubernetes.io/managed-by': 'platform-api-postgres-barman-restore' } },
          status: opts.sideBySideReady === false
            ? { phase: 'Setting up primary', readyInstances: 0, instances: 1 }
            : { phase: 'healthy', readyInstances: 1, instances: 1, currentPrimary: 'cluster-1' },
          spec: { instances: 1 },
        };
      }
      if (req.plural === 'clusters' && opts.clusterExists === false) {
        const e: { code?: number } & Error = new Error('not found');
        e.code = 404;
        throw e;
      }
      if (req.plural === 'objectstores' && opts.objectStoreExists === false) {
        const e: { code?: number } & Error = new Error('not found');
        e.code = 404;
        throw e;
      }
      return { metadata: { name: req.name }, spec: { plugins: [], instances: 1, imageName: 'pg:18.3', storage: { storageClass: 'longhorn' } } };
    }),
  };
  const batch = {
    readNamespacedJob: vi.fn(async () => ({
      status: opts.promoteJobSucceeds === false
        ? { failed: 1, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'too many failures' }] }
        : { succeeded: 1 },
    })),
  };
  return { custom, batch, core: {}, apps: {} };
}

const FAKE_POINTER: CnpgRecoveryPointer = {
  namespace: 'platform',
  clusterName: 'system-db',
  serverName: 'system-db',
  objectStoreName: 'system-postgres-objectstore',
};

const FAKE_DB = {} as never;

describe('runCnpgRecovery — preflight', () => {
  it('refuses if confirmClusterNames is empty', async () => {
    const k8s = makeK8sStub({});
    const opts: CnpgRecoveryOpts = {
      k8s: k8s as never,
      db: FAKE_DB,
      pointers: [FAKE_POINTER],
      confirmClusterNames: new Map(),
    };
    await expect(runCnpgRecovery(opts)).rejects.toThrow(/--confirm-cluster.*required/);
  });

  it('refuses if confirmation value does not match cluster name', async () => {
    const k8s = makeK8sStub({});
    const opts: CnpgRecoveryOpts = {
      k8s: k8s as never,
      db: FAKE_DB,
      pointers: [FAKE_POINTER],
      confirmClusterNames: new Map([['system-db', 'wrong-name']]),
    };
    await expect(runCnpgRecovery(opts)).rejects.toThrow(/must equal the cluster name verbatim/);
  });

  it('refuses if cluster CR not present (412)', async () => {
    const k8s = makeK8sStub({ clusterExists: false });
    const opts: CnpgRecoveryOpts = {
      k8s: k8s as never,
      db: FAKE_DB,
      pointers: [FAKE_POINTER],
      confirmClusterNames: new Map([['system-db', 'system-db']]),
    };
    await expect(runCnpgRecovery(opts)).rejects.toMatchObject({
      name: 'CnpgRecoveryError', code: 412,
    });
  });

  it('refuses if ObjectStore CR not present (412 — operator must run --mode=partial first)', async () => {
    const k8s = makeK8sStub({ objectStoreExists: false });
    const opts: CnpgRecoveryOpts = {
      k8s: k8s as never,
      db: FAKE_DB,
      pointers: [FAKE_POINTER],
      confirmClusterNames: new Map([['system-db', 'system-db']]),
    };
    await expect(runCnpgRecovery(opts)).rejects.toThrow(/--mode=partial.*first/);
  });
});

describe('runCnpgRecovery — orchestration', () => {
  it('refuses missing confirmation across multiple pointers', async () => {
    const k8s = makeK8sStub({});
    const second: CnpgRecoveryPointer = { ...FAKE_POINTER, clusterName: 'mail-db' };
    const opts: CnpgRecoveryOpts = {
      k8s: k8s as never,
      db: FAKE_DB,
      pointers: [FAKE_POINTER, second],
      confirmClusterNames: new Map([['system-db', 'system-db']]),
    };
    await expect(runCnpgRecovery(opts)).rejects.toThrow(/Missing: mail-db/);
  });

  it('completes happy path with one cluster (mocked side-by-side + promote)', async () => {
    const k8s = makeK8sStub({});
    const barmanStub = vi.fn(async () => ({
      newClusterName: 'system-db-dr-1',
      namespace: 'platform',
      objectStoreName: 'system-postgres-objectstore',
      recoveryTargetTime: null,
      clusterUid: 'uid-1',
      freshBackupTriggered: false,
      freshBackupId: null,
      freshBackupWarning: null,
    }));
    const promoteStub = vi.fn(async () => ({
      snapshotName: 'snap-1',
      jobName: 'pitr-job-1',
      jobNamespace: 'platform',
      sourceClusterName: 'system-db',
      restoredClusterName: 'system-db-dr-1',
      namespace: 'platform',
    }));
    const opts: CnpgRecoveryOpts = {
      k8s: k8s as never,
      db: FAKE_DB,
      pointers: [FAKE_POINTER],
      confirmClusterNames: new Map([['system-db', 'system-db']]),
      _barmanRestoreClient: barmanStub as never,
      _promoteClient: promoteStub as never,
    };
    const result = await runCnpgRecovery(opts);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.clusterName).toBe('system-db');
    expect(result.clusters[0]?.pitrJobName).toBe('pitr-job-1');
    expect(barmanStub).toHaveBeenCalledTimes(1);
    expect(promoteStub).toHaveBeenCalledTimes(1);
    // Verify Unit C passes the bundle's serverName + objectStoreName as overrides
    // (defensive — without these, bootstrap.recovery looks for the WRONG archive).
    const barmanCallArgs = barmanStub.mock.calls[0]?.[1];
    expect(barmanCallArgs).toMatchObject({
      serverNameOverride: 'system-db',
      objectStoreOverride: 'system-postgres-objectstore',
      skipFreshBackup: true,
    });
    // Promote receives the confirmation token verbatim — server-side enforcement
    // catches a missing/mismatched value with HTTP 409.
    const promoteCallArgs = promoteStub.mock.calls[0]?.[1];
    expect(promoteCallArgs).toMatchObject({
      sourceClusterName: 'system-db',
      confirmSourceClusterName: 'system-db',
    });
  });

  it('surfaces CnpgRecoveryError when promote Job fails', async () => {
    const k8s = makeK8sStub({ promoteJobSucceeds: false });
    const barmanStub = vi.fn(async () => ({
      newClusterName: 'system-db-dr-2', namespace: 'platform',
      objectStoreName: 'os', recoveryTargetTime: null, clusterUid: 'uid',
      freshBackupTriggered: false, freshBackupId: null, freshBackupWarning: null,
    }));
    const promoteStub = vi.fn(async () => ({
      snapshotName: 'snap', jobName: 'pitr-job-bad', jobNamespace: 'platform',
      sourceClusterName: 'system-db', restoredClusterName: 'system-db-dr-2',
      namespace: 'platform',
    }));
    const opts: CnpgRecoveryOpts = {
      k8s: k8s as never,
      db: FAKE_DB,
      pointers: [FAKE_POINTER],
      confirmClusterNames: new Map([['system-db', 'system-db']]),
      _barmanRestoreClient: barmanStub as never,
      _promoteClient: promoteStub as never,
      // Short timeout to avoid actually waiting 30 minutes.
      restoreTimeoutMs: 60_000,
      promoteTimeoutMs: 60_000,
    };
    await expect(runCnpgRecovery(opts)).rejects.toBeInstanceOf(CnpgRecoveryError);
  });

  it('runs pointers sequentially (no concurrent CNPG promotes)', async () => {
    const k8s = makeK8sStub({});
    const calls: string[] = [];
    const barmanStub = vi.fn(async (_c: unknown, input: { sourceClusterName: string }) => {
      calls.push(`barman:${input.sourceClusterName}`);
      return {
        newClusterName: `${input.sourceClusterName}-dr-x`, namespace: 'platform',
        objectStoreName: 'os', recoveryTargetTime: null, clusterUid: 'uid',
        freshBackupTriggered: false, freshBackupId: null, freshBackupWarning: null,
      };
    });
    const promoteStub = vi.fn(async (_d: unknown, input: { sourceClusterName: string }) => {
      calls.push(`promote:${input.sourceClusterName}`);
      return {
        snapshotName: 'snap', jobName: `job-${input.sourceClusterName}`,
        jobNamespace: 'platform', sourceClusterName: input.sourceClusterName,
        restoredClusterName: `${input.sourceClusterName}-dr-x`, namespace: 'platform',
      };
    });
    const second: CnpgRecoveryPointer = { ...FAKE_POINTER, clusterName: 'second-db', serverName: 'second-db' };
    const opts: CnpgRecoveryOpts = {
      k8s: k8s as never,
      db: FAKE_DB,
      pointers: [FAKE_POINTER, second],
      confirmClusterNames: new Map([['system-db', 'system-db'], ['second-db', 'second-db']]),
      _barmanRestoreClient: barmanStub as never,
      _promoteClient: promoteStub as never,
    };
    await runCnpgRecovery(opts);
    // Strict ordering: each pointer's barman+promote complete before
    // the next pointer's barman starts. Critical so a failure on
    // cluster N+1 doesn't leave the operator with two in-flight
    // destructive cutovers.
    expect(calls).toEqual([
      'barman:system-db', 'promote:system-db',
      'barman:second-db', 'promote:second-db',
    ]);
  });
});
