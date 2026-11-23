import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_BALANCE_ANNOTATION, AUTO_BALANCE_SINGLE_COPY, applyAutoBalanceChanges, autoBalanceChanges, autoBalancePatch,
} from './auto-balance.js';
import type { VolumeFact } from '../tenant-health/service.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';

const vol = (volumeName: string, autoBalance?: VolumeFact['autoBalance']): VolumeFact => ({
  volumeName, namespace: 'tenant-acme', pvcName: 'tenant-acme-storage', robustness: 'healthy', attached: true,
  pvcRefLostAt: null, attachedNode: 'node-a', remountRequestedAt: null, scheduleFailure: null, autoBalance,
});

describe('autoBalanceChanges', () => {
  it('turns auto-balance off on a volume with one copy that follows the cluster setting', () => {
    expect(autoBalanceChanges([
      vol('pvc-ignored', { replicas: 1, mode: 'ignored', setByPlatform: false }),
      vol('pvc-empty', { replicas: 1, mode: null, setByPlatform: false }),
    ])).toEqual([
      { volumeName: 'pvc-ignored', mode: 'disabled' },
      { volumeName: 'pvc-empty', mode: 'disabled' },
    ]);
  });

  it('gives a volume back to the cluster setting once it has more than one copy — only if the platform turned it off', () => {
    expect(autoBalanceChanges([
      vol('pvc-now-ha', { replicas: 2, mode: 'disabled', setByPlatform: true }),
      vol('pvc-off-by-hand', { replicas: 2, mode: 'disabled', setByPlatform: false }),
    ])).toEqual([{ volumeName: 'pvc-now-ha', mode: 'ignored' }]);
  });

  it('leaves alone what is already right, what was set by hand, and what was not read', () => {
    expect(autoBalanceChanges([
      vol('pvc-done', { replicas: 1, mode: 'disabled', setByPlatform: true }),
      vol('pvc-hand-1', { replicas: 1, mode: 'best-effort', setByPlatform: false }),
      vol('pvc-ha', { replicas: 3, mode: 'ignored', setByPlatform: false }),
      vol('pvc-hand-ha', { replicas: 2, mode: 'least-effort', setByPlatform: false }),
      vol('pvc-no-count', { replicas: null, mode: 'ignored', setByPlatform: false }),
      vol('pvc-unread'),
    ])).toEqual([]);
  });
});

describe('autoBalancePatch', () => {
  it('marks a volume it turns off, and takes the mark away when it gives it back', () => {
    expect(autoBalancePatch({ volumeName: 'v', mode: 'disabled' })).toEqual({
      metadata: { annotations: { [AUTO_BALANCE_ANNOTATION]: AUTO_BALANCE_SINGLE_COPY } },
      spec: { replicaAutoBalance: 'disabled' },
    });
    expect(autoBalancePatch({ volumeName: 'v', mode: 'ignored' })).toEqual({
      metadata: { annotations: { [AUTO_BALANCE_ANNOTATION]: null } },
      spec: { replicaAutoBalance: 'ignored' },
    });
  });
});

describe('applyAutoBalanceChanges', () => {
  it('merge-patches each Longhorn volume, and one failure does not stop the rest', async () => {
    const patch = vi.fn(async (req: { name: string }) => {
      if (req.name === 'pvc-b') throw new Error('conflict');
      return {};
    });
    const k8s = { custom: { patchNamespacedCustomObject: patch } } as never;
    const r = await applyAutoBalanceChanges(k8s, [
      { volumeName: 'pvc-a', mode: 'disabled' },
      { volumeName: 'pvc-b', mode: 'disabled' },
      { volumeName: 'pvc-c', mode: 'ignored' },
    ]);
    expect(r.applied.map((c) => c.volumeName)).toEqual(['pvc-a', 'pvc-c']);
    expect(r.failed).toEqual([{ volumeName: 'pvc-b', error: 'conflict' }]);
    expect(patch).toHaveBeenCalledTimes(3);
    expect(patch.mock.calls[0]).toEqual([
      {
        group: 'longhorn.io', version: 'v1beta2', namespace: 'longhorn-system', plural: 'volumes',
        name: 'pvc-a', body: autoBalancePatch({ volumeName: 'pvc-a', mode: 'disabled' }),
      },
      MERGE_PATCH,
    ]);
  });
});
