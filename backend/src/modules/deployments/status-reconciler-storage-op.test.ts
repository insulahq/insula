/**
 * "After restoring a snapshot, the tenant's workloads are reported STOPPED
 * although they are running — and their resource usage is unavailable."
 *
 * Reproduced on a test cluster: a snapshot restore quiesces the tenant (hold
 * annotation + replicas=0), and the 15-second status tick that lands inside
 * that window — it always does — wrote `stopped` four seconds in. The pods were
 * back a minute later, but a `stopped` row was not re-examined for ten minutes,
 * and every panel that reads per-app usage only for `running` apps showed none.
 *
 * These drive the real reconciler loop over a fake cluster + database, in the
 * shapes the restore actually passes through.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  reconcileDeploymentStatuses,
  stoppedRowMayChange,
  heldByInFlightStorageOp,
  STOPPED_RECHECK_MS,
} from './status-reconciler.js';
import { getDeploymentStatus } from './k8s-deployer.js';
import type { DeployComponentInput } from './k8s-deployer.js';
import { buildWorkloadSnapshot } from './workload-snapshot.js';
import { deployments, tenants, catalogEntries } from '../../db/schema.js';
import { STORAGE_QUIESCED_ANNOTATION } from '../../shared/scale-deployment.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

const NS = 'tenant-acme';
const TENANT = 't-1';
const APP = 'website';
const NOW = Date.now();

// ─── Fixtures ───────────────────────────────────────────────────────────────

interface FakeDeploy {
  metadata: { name: string; namespace: string; annotations?: Record<string, string> };
  spec: { replicas: number };
  status: { replicas: number; readyReplicas: number };
}
interface FakePod {
  metadata: { name: string; namespace: string; labels: Record<string, string>; creationTimestamp?: string | Date };
  spec?: { nodeName?: string };
  status: Record<string, unknown>;
}
interface FakeEvent {
  reason: string;
  message: string;
  involvedObject: { kind: string; name: string };
}

function deploy(replicas: number, ready: number, held: boolean): FakeDeploy {
  return {
    metadata: {
      name: APP,
      namespace: NS,
      ...(held ? { annotations: { [STORAGE_QUIESCED_ANNOTATION]: 'true', 'insula.host/pre-quiesce-replicas': '1' } } : {}),
    },
    spec: { replicas },
    status: { replicas, readyReplicas: ready },
  };
}

function readyPod(createdAt: string | Date): FakePod {
  return {
    metadata: { name: `${APP}-67798b6d47-lwdfh`, namespace: NS, labels: { app: APP }, creationTimestamp: createdAt },
    spec: { nodeName: 'node-a' },
    status: { phase: 'Running', containerStatuses: [{ name: 'web', ready: true, state: { running: {} } }] },
  };
}

/** The pod unquiesce creates, while Longhorn is still settling the re-attach. */
function attachingPod(): FakePod {
  return {
    metadata: { name: `${APP}-67798b6d47-qzb9v`, namespace: NS, labels: { app: APP }, creationTimestamp: new Date(NOW - 5_000) },
    spec: { nodeName: 'node-a' },
    status: { phase: 'Pending' },
  };
}

/** Kubelet's routine CSI attach backoff right after a quiesce — not a fault. */
const ATTACH_BACKOFF: FakeEvent = {
  reason: 'FailedAttachVolume',
  message: 'AttachVolume.Attach failed for volume "pvc-1" : rpc error: code = Aborted desc = volume pvc-1 is not ready for workloads',
  involvedObject: { kind: 'Pod', name: `${APP}-67798b6d47-qzb9v` },
};

interface Cluster {
  readonly deployments: FakeDeploy[];
  readonly pods: FakePod[];
  readonly events?: FakeEvent[];
}

function fakeK8s(cluster: Cluster): K8sClients {
  return {
    apps: {
      listDeploymentForAllNamespaces: vi.fn(async () => ({ items: cluster.deployments })),
      readNamespacedDeployment: vi.fn(async ({ name }: { name: string }) => {
        const d = cluster.deployments.find((x) => x.metadata.name === name);
        if (!d) throw new Error('HTTP-Code: 404');
        return d;
      }),
    },
    core: {
      listPodForAllNamespaces: vi.fn(async () => ({ items: cluster.pods })),
      listNamespacedPod: vi.fn(async () => ({ items: cluster.pods })),
      listNamespacedEvent: vi.fn(async () => ({ items: cluster.events ?? [] })),
    },
  } as unknown as K8sClients;
}

interface Row {
  readonly status: string;
  readonly updatedAt: Date;
  readonly source?: 'catalog' | 'custom';
}

/**
 * The reconciler's database: one deployment row, its tenant, its catalog entry.
 * Records every UPDATE so a test can assert what the reconciler WROTE — the
 * only thing the tenant ever sees.
 */
function fakeDb(row: Row, tenantHasActiveStorageOp: boolean) {
  const writes: Array<Record<string, unknown>> = [];
  const deploymentRow = {
    id: 'd-1',
    tenantId: TENANT,
    name: APP,
    source: row.source ?? 'catalog',
    catalogEntryId: row.source === 'custom' ? null : 'ce-1',
    status: row.status,
    statusMessage: null,
    lastError: null,
    currentNodeName: row.status === 'running' ? 'node-a' : null,
    updatedAt: row.updatedAt,
  };
  const rowsFor = (table: unknown): unknown[] => {
    if (table === deployments) return [deploymentRow];
    if (table === tenants) {
      return [{ id: TENANT, kubernetesNamespace: NS, activeStorageOpId: tenantHasActiveStorageOp ? 'op-1' : null, name: 'Acme' }];
    }
    if (table === catalogEntries) {
      return [{
        id: 'ce-1', code: 'static-nginx', image: null,
        components: [{ name: 'web', type: 'deployment', image: 'static-nginx:1', ports: [] }],
      }];
    }
    return [];
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const result = Promise.resolve(rowsFor(table));
        return Object.assign(result, {
          limit: async () => rowsFor(table),
          where: () => Object.assign(Promise.resolve(rowsFor(table)), { limit: async () => rowsFor(table) }),
        });
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { writes.push(values); },
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined, onConflictDoUpdate: async () => undefined }) }),
  } as never;
  return { db, writes };
}

// ─── The restore, step by step ──────────────────────────────────────────────

describe('a snapshot restore as the status reconciler sees it', () => {
  /**
   * ★ The bug. Quiesce has stamped the hold and scaled to 0; the tenant's
   * storage operation is in flight. This is not a stop — nobody asked for one.
   */
  it('does not record the quiesce as a stop', async () => {
    const { db, writes } = fakeDb({ status: 'running', updatedAt: new Date(NOW - 3_600_000) }, true);
    const k8s = fakeK8s({ deployments: [deploy(0, 0, true)], pods: [] });

    await reconcileDeploymentStatuses(db, k8s);

    expect(writes).toEqual([]);
  });

  /**
   * Unquiesce has scaled it back up and is waiting for it to become available,
   * while kubelet backs off against Longhorn's "not ready for workloads". That
   * is the operation's progress, not a faulted volume — the row must not be
   * failed with an "Operator action required" error in the middle of it.
   */
  it('does not report the re-attach backoff while the operation brings it back', async () => {
    const { db, writes } = fakeDb({ status: 'running', updatedAt: new Date(NOW - 3_600_000) }, true);
    const k8s = fakeK8s({ deployments: [deploy(1, 0, true)], pods: [attachingPod()], events: [ATTACH_BACKOFF] });

    await reconcileDeploymentStatuses(db, k8s);

    expect(writes).toEqual([]);
  });

  it('leaves the row running once the operation has released the workload', async () => {
    const { db, writes } = fakeDb({ status: 'running', updatedAt: new Date(NOW - 3_600_000) }, false);
    const k8s = fakeK8s({ deployments: [deploy(1, 1, false)], pods: [readyPod(new Date(NOW - 20_000))] });

    await reconcileDeploymentStatuses(db, k8s);

    expect(writes.map((w) => w.status)).not.toContain('stopped');
  });

  /**
   * A hold that OUTLIVES its operation (it failed; unquiesce keeps the hold so
   * quiesce-watchdog can find it) marks a workload that is really down. That
   * one is reported as it is — skipping it would freeze the row at "running".
   */
  it('still reports a workload left held at zero by a FAILED operation', async () => {
    const { db, writes } = fakeDb({ status: 'running', updatedAt: new Date(NOW - 3_600_000) }, false);
    const k8s = fakeK8s({ deployments: [deploy(0, 0, true)], pods: [] });

    await reconcileDeploymentStatuses(db, k8s);

    expect(writes.map((w) => w.status)).toEqual(['stopped']);
  });

  it('does not record the quiesce as a stop for a custom container either', async () => {
    const { db, writes } = fakeDb(
      { status: 'running', updatedAt: new Date(NOW - 3_600_000), source: 'custom' },
      true,
    );
    const k8s = fakeK8s({ deployments: [deploy(0, 0, true)], pods: [] });

    await reconcileDeploymentStatuses(db, k8s);

    expect(writes).toEqual([]);
  });
});

describe('a row already marked stopped by a restore converges from the cluster', () => {
  /**
   * The row was written `stopped` mid-restore (an older release, or a tick
   * without the workload snapshot). The restore is over and the restored pod —
   * created AFTER that write — is Ready. Waiting out ten minutes here is the
   * reported bug; the pods prove no stop is in progress.
   */
  it('moves to running as soon as the restored pods are ready', async () => {
    const { db, writes } = fakeDb({ status: 'stopped', updatedAt: new Date(NOW - 90_000) }, false);
    const k8s = fakeK8s({ deployments: [deploy(1, 1, false)], pods: [readyPod(new Date(NOW - 30_000))] });

    await reconcileDeploymentStatuses(db, k8s);

    expect(writes.map((w) => w.status)).toEqual(['running']);
  });

  it('accepts the timestamp as the RFC 3339 string a raw read returns', async () => {
    const { db, writes } = fakeDb({ status: 'stopped', updatedAt: new Date(NOW - 90_000) }, false);
    const k8s = fakeK8s({
      deployments: [deploy(1, 1, false)],
      pods: [readyPod(new Date(NOW - 30_000).toISOString())],
    });

    await reconcileDeploymentStatuses(db, k8s);

    expect(writes.map((w) => w.status)).toEqual(['running']);
  });

  /**
   * ★ What the old ten-minute bound protected, and must still be protected:
   * updateDeployment writes `stopped` BEFORE it scales down, so for a moment the
   * OLD pods are still Ready. Flipping the row back would undo the stop.
   */
  it('never undoes a stop in progress — the pods predate the stop', async () => {
    const { db, writes } = fakeDb({ status: 'stopped', updatedAt: new Date(NOW - 2_000) }, false);
    const k8s = fakeK8s({ deployments: [deploy(1, 1, false)], pods: [readyPod(new Date(NOW - 3_600_000))] });

    await reconcileDeploymentStatuses(db, k8s);

    expect(writes).toEqual([]);
  });
});

// ─── The decisions, in isolation ────────────────────────────────────────────

describe('stoppedRowMayChange', () => {
  const stoppedAt = new Date(NOW - 60_000);

  it('allows any move once the row is old enough', () => {
    expect(stoppedRowMayChange(new Date(NOW - STOPPED_RECHECK_MS), 'pending', [], NOW)).toBe(true);
  });

  it('allows running when every running component\'s pods are newer than the stop', () => {
    expect(stoppedRowMayChange(stoppedAt, 'running', [NOW - 20_000, NOW - 10_000], NOW)).toBe(true);
  });

  it('refuses when any component still runs a pod from before the stop', () => {
    expect(stoppedRowMayChange(stoppedAt, 'running', [NOW - 20_000, NOW - 120_000], NOW)).toBe(false);
  });

  it('refuses a pod created within the clock-skew allowance of the stop', () => {
    expect(stoppedRowMayChange(stoppedAt, 'running', [stoppedAt.getTime() + 1_000], NOW)).toBe(false);
  });

  it('refuses when a creation time is unknown', () => {
    expect(stoppedRowMayChange(stoppedAt, 'running', [undefined], NOW)).toBe(false);
    expect(stoppedRowMayChange(stoppedAt, 'running', [null], NOW)).toBe(false);
  });

  it('refuses with no running components to judge', () => {
    expect(stoppedRowMayChange(stoppedAt, 'running', [], NOW)).toBe(false);
  });

  it('takes the shortcut only to running — a fresh row may not move to pending or failed', () => {
    expect(stoppedRowMayChange(stoppedAt, 'pending', [NOW - 10_000], NOW)).toBe(false);
    expect(stoppedRowMayChange(stoppedAt, 'failed', [NOW - 10_000], NOW)).toBe(false);
  });
});

describe('heldByInFlightStorageOp', () => {
  it('is true only when a component is held AND the tenant has an operation in flight', () => {
    expect(heldByInFlightStorageOp([{ heldByStorageOp: true }], true)).toBe(true);
    expect(heldByInFlightStorageOp([{ heldByStorageOp: true }], false)).toBe(false);
    expect(heldByInFlightStorageOp([{ heldByStorageOp: false }, {}], true)).toBe(false);
  });
});

describe('getDeploymentStatus surfaces what the reconciler decides on', () => {
  const COMPONENTS: DeployComponentInput[] = [
    { name: 'web', type: 'deployment', image: 'static-nginx:1', ports: [], optional: false },
  ];

  it('flags a held Deployment the same way on the snapshot and the per-call path', async () => {
    const cluster: Cluster = { deployments: [deploy(0, 0, true)], pods: [] };
    const viaApi = await getDeploymentStatus(fakeK8s(cluster), NS, APP, COMPONENTS);
    const snap = await buildWorkloadSnapshot(fakeK8s(cluster));
    const viaSnapshot = await getDeploymentStatus(fakeK8s(cluster), NS, APP, COMPONENTS, snap);
    expect(viaApi.components[0]).toMatchObject({ phase: 'stopped', heldByStorageOp: true });
    expect(viaSnapshot).toEqual(viaApi);
  });

  it('does not flag a Deployment without the hold', async () => {
    const status = await getDeploymentStatus(fakeK8s({ deployments: [deploy(0, 0, false)], pods: [] }), NS, APP, COMPONENTS);
    expect(status.components[0].heldByStorageOp).toBeUndefined();
  });

  it('reports the oldest live pod\'s creation time on a running component', async () => {
    const older = new Date(NOW - 50_000);
    const newer = new Date(NOW - 10_000);
    const pods = [readyPod(newer), { ...readyPod(older), metadata: { ...readyPod(older).metadata, name: `${APP}-2` } }];
    const status = await getDeploymentStatus(fakeK8s({ deployments: [deploy(2, 2, false)], pods }), NS, APP, COMPONENTS);
    expect(status.components[0].oldestPodCreatedAtMs).toBe(older.getTime());
  });
});
