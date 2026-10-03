import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the tasks service so finishRun's task-center mirror call is
// observable without spinning up a DB. The platformStorageApplyRuns
// update path is mocked via the db fake below.
vi.mock('../tasks/service.js', () => ({
  finishByRef: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db/schema.js', () => ({
  platformStorageApplyRuns: {
    id: 'platform_storage_apply_runs.id',
    status: 'platform_storage_apply_runs.status',
    finishedAt: 'platform_storage_apply_runs.finished_at',
    convergenceJson: 'platform_storage_apply_runs.convergence_json',
  },
}));

import { finishRun, type ConvergenceSnapshot } from './runs.js';
import * as tasks from '../tasks/service.js';
import type { Database } from '../../db/index.js';

function makeDb() {
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  const db = {
    update: vi.fn().mockReturnValue(updateChain),
  } as unknown as Database;
  return { db, updateChain };
}

function makeConv(overrides: Partial<ConvergenceSnapshot> = {}): ConvergenceSnapshot {
  return {
    volumesConverged: 0,
    volumesTotal: 0,
    volumesOffSystem: 0,
    cnpgConverged: 0,
    cnpgTotal: 0,
    deploymentsConverged: 0,
    deploymentsTotal: 0,
    lastObservedAt: new Date().toISOString(),
    elapsedMs: 0,
    stuckResources: [],
    ...overrides,
  };
}

describe('finishRun — task-center mirror', () => {
  beforeEach(() => {
    vi.mocked(tasks.finishByRef).mockClear();
  });

  it('flips the task chip to succeeded when the run succeeded', async () => {
    const { db } = makeDb();
    await finishRun(db, 'run-1', 'succeeded', makeConv());

    expect(tasks.finishByRef).toHaveBeenCalledTimes(1);
    expect(tasks.finishByRef).toHaveBeenCalledWith(
      db,
      'storage.tier-flip',
      'run-1',
      expect.objectContaining({ status: 'succeeded' }),
    );
  });

  it('treats partial as task=succeeded with a "still rebuilding" note', async () => {
    // Partial = patches succeeded but Longhorn/CNPG didn't fully
    // converge within 10 min. Operator can re-open the modal to see
    // what's still mid-rebuild — but the apply itself isn't a failure,
    // so the chip shouldn't fire the red-X.
    const { db } = makeDb();
    await finishRun(db, 'run-2', 'partial', makeConv({ stuckResources: [{ kind: 'volume', name: 'pf/x', observed: 1, desired: 3 }] }));

    expect(tasks.finishByRef).toHaveBeenCalledWith(
      db,
      'storage.tier-flip',
      'run-2',
      expect.objectContaining({
        status: 'succeeded',
        text: expect.stringContaining('still rebuilding'),
      }),
    );
  });

  it('flips the task chip to failed with a capacity message when capacity_blocked', async () => {
    const { db } = makeDb();
    await finishRun(db, 'run-3', 'capacity_blocked', null);

    expect(tasks.finishByRef).toHaveBeenCalledWith(
      db,
      'storage.tier-flip',
      'run-3',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('Insufficient storage capacity'),
      }),
    );
  });

  it('flips the task chip to failed with a generic message on failed', async () => {
    const { db } = makeDb();
    await finishRun(db, 'run-4', 'failed', null);

    expect(tasks.finishByRef).toHaveBeenCalledWith(
      db,
      'storage.tier-flip',
      'run-4',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('per-resource errors'),
      }),
    );
  });

  it('does not throw when the task-center finishByRef call rejects', async () => {
    // The run row is the source of truth; the task chip is a UX
    // convenience. A failure to mirror onto the chip must not roll
    // back the finishRun caller (watchConvergence).
    const { db } = makeDb();
    vi.mocked(tasks.finishByRef).mockRejectedValueOnce(new Error('db unreachable'));

    await expect(finishRun(db, 'run-5', 'succeeded', makeConv())).resolves.toBeUndefined();
  });
});

describe('volumeAtDesiredState', () => {
  const base = { currentReplicas: 3, desiredReplicas: 3, hasOffSystemReplica: false, healthy: true, phase: 'attached', kind: 'statefulset' as const };
  const orphan = { ...base, healthy: false, phase: 'detached' };

  it('an attached volume converges once it is healthy at the desired count', async () => {
    const { volumeAtDesiredState } = await import('./runs.js');
    expect(volumeAtDesiredState(base, true)).toBe(true);
    expect(volumeAtDesiredState({ ...base, healthy: false }, true)).toBe(false);
  });

  it('an ORPHAN — detached and used by nothing — converges at the desired count', async () => {
    const { volumeAtDesiredState } = await import('./runs.js');
    expect(volumeAtDesiredState(orphan, false)).toBe(true);
  });

  it('a volume a workload still uses is not converged while detached — a pod restart is not done', async () => {
    const { volumeAtDesiredState } = await import('./runs.js');
    expect(volumeAtDesiredState(orphan, true)).toBe(false);
  });

  it('a CNPG volume never takes the shortcut, even unreferenced', async () => {
    const { volumeAtDesiredState } = await import('./runs.js');
    expect(volumeAtDesiredState({ ...orphan, kind: 'cnpg' as const }, false)).toBe(false);
  });

  it('an orphan at the wrong count, or with a copy off the system nodes, has not converged', async () => {
    const { volumeAtDesiredState } = await import('./runs.js');
    expect(volumeAtDesiredState({ ...orphan, currentReplicas: 1 }, false)).toBe(false);
    expect(volumeAtDesiredState({ ...orphan, hasOffSystemReplica: true }, false)).toBe(false);
  });
});

describe('pvcsInUse', () => {
  const claim = (name: string) => ({ volumes: [{ name: 'data', persistentVolumeClaim: { claimName: name } }] });
  const k8s = (over: { failPods?: boolean } = {}) => ({
    apps: {
      listNamespacedDeployment: async ({ namespace }: { namespace: string }) => ({
        items: namespace === 'monitoring' ? [{ spec: { template: { spec: claim('vmsingle-storage') } } }] : [{ spec: { template: { spec: {} } } }],
      }),
      listNamespacedStatefulSet: async ({ namespace }: { namespace: string }) => ({
        items: namespace === 'mail'
          ? [{ metadata: { name: 'stalwart-mail' }, spec: { template: { spec: {} }, volumeClaimTemplates: [{ metadata: { name: 'data' } }] } }]
          : [],
      }),
    },
    core: {
      listNamespacedPod: async ({ namespace }: { namespace: string }) => {
        if (over.failPods) throw new Error('apiserver down');
        return {
          items: namespace === 'crowdsec'
            ? [{ status: { phase: 'Succeeded' }, spec: claim('crowdsec-data') }, { status: { phase: 'Running' }, spec: claim('scratch') }]
            : [],
        };
      },
    },
  }) as never;

  it('a template outlives a pod restart: a Deployment or StatefulSet that names the PVC keeps it in use', async () => {
    const { pvcsInUse } = await import('./runs.js');
    const inUse = await pvcsInUse(k8s(), ['monitoring', 'mail', 'crowdsec']);
    expect(inUse?.('monitoring', 'vmsingle-storage')).toBe(true);
    expect(inUse?.('mail', 'data-stalwart-mail-0')).toBe(true);
    expect(inUse?.('crowdsec', 'scratch')).toBe(true);
  });

  it('a PVC only a finished pod mounted, and no template names, is not in use', async () => {
    const { pvcsInUse } = await import('./runs.js');
    const inUse = await pvcsInUse(k8s(), ['crowdsec']);
    expect(inUse?.('crowdsec', 'crowdsec-data')).toBe(false);
  });

  it('a failed lookup answers null — callers then treat every volume as in use', async () => {
    const { pvcsInUse } = await import('./runs.js');
    expect(await pvcsInUse(k8s({ failPods: true }), ['crowdsec'])).toBeNull();
  });
});
