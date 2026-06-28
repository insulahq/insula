/**
 * Data-safety unit tests for the mail-migration PVC swap (2026-06-28).
 *
 * Regression guard for the data-loss incident: the swap deleted the
 * source local-path PVC (reclaimPolicy=Delete → wipes on-disk data)
 * BEFORE the destination was confirmed, with no rollback. The fix:
 *   - retainSourcePvBeforeDelete flips the bound PV to Retain so the
 *     data survives the PVC delete;
 *   - restoreMailOnSource re-binds the retained PV on any failure.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  retainSourcePvBeforeDelete,
  restoreMailOnSource,
} from './migration.js';

const SILENT = { warn: () => {}, info: () => {} };

function notFound(): Error {
  // Shape recognised by shared/k8s-errors.ts isNotFound (code + statusCode).
  return Object.assign(new Error('not found'), { code: 404, statusCode: 404 });
}

type AnyCore = Parameters<typeof retainSourcePvBeforeDelete>[0];
type AnyApps = Parameters<typeof restoreMailOnSource>[1];

describe('retainSourcePvBeforeDelete (data-safety: source PV survives the swap)', () => {
  it('patches the bound PV to reclaimPolicy=Retain and returns its name', async () => {
    const patchPersistentVolume = vi.fn().mockResolvedValue({});
    const core = {
      readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ spec: { volumeName: 'pvc-orig-123' } }),
      patchPersistentVolume,
    } as unknown as AnyCore;

    const pv = await retainSourcePvBeforeDelete(core, SILENT);

    expect(pv).toBe('pvc-orig-123');
    expect(patchPersistentVolume).toHaveBeenCalledTimes(1);
    const [arg] = patchPersistentVolume.mock.calls[0] as [{ name: string; body: { spec: { persistentVolumeReclaimPolicy: string } } }];
    expect(arg.name).toBe('pvc-orig-123');
    expect(arg.body.spec.persistentVolumeReclaimPolicy).toBe('Retain');
  });

  it('returns null (and never patches) when the PVC has no bound PV yet', async () => {
    const patchPersistentVolume = vi.fn();
    const core = {
      readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ spec: {} }),
      patchPersistentVolume,
    } as unknown as AnyCore;

    expect(await retainSourcePvBeforeDelete(core, SILENT)).toBeNull();
    expect(patchPersistentVolume).not.toHaveBeenCalled();
  });

  it('returns null when the source PVC is already gone (404)', async () => {
    const core = {
      readNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue(notFound()),
      patchPersistentVolume: vi.fn(),
    } as unknown as AnyCore;

    expect(await retainSourcePvBeforeDelete(core, SILENT)).toBeNull();
  });
});

describe('restoreMailOnSource (rollback re-binds the retained PV — no data loss)', () => {
  function appsStub(): { apps: AnyApps; patch: ReturnType<typeof vi.fn> } {
    const patch = vi.fn().mockResolvedValue({});
    // applyDeploymentAffinity + patchDeploymentReplicas both go through
    // apps.patchNamespacedDeployment; readNamespacedDeployment is used by
    // the affinity helper to merge existing spec.
    const apps = {
      patchNamespacedDeployment: patch,
      readNamespacedDeployment: vi.fn().mockResolvedValue({ spec: { template: { spec: {} } } }),
    } as unknown as AnyApps;
    return { apps, patch };
  }

  it('with no retained PV: scales Stalwart back up best-effort and never re-binds', async () => {
    const createNamespacedPersistentVolumeClaim = vi.fn();
    const core = { createNamespacedPersistentVolumeClaim, readNamespacedPersistentVolumeClaim: vi.fn() } as unknown as AnyCore;
    const { apps, patch } = appsStub();

    await restoreMailOnSource(core, apps, null, 'staging2', SILENT);

    expect(createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalled(); // affinity/scale-up best-effort
  });

  it('case A (delete failed, PVC still bound to the retained PV): does NOT mutate the PVC, just re-pins + scales up', async () => {
    const createNamespacedPersistentVolumeClaim = vi.fn();
    const deleteNamespacedPersistentVolumeClaim = vi.fn();
    const core = {
      readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ spec: { volumeName: 'pvc-orig-123' } }),
      createNamespacedPersistentVolumeClaim,
      deleteNamespacedPersistentVolumeClaim,
      patchPersistentVolume: vi.fn(),
    } as unknown as AnyCore;
    const { apps, patch } = appsStub();

    await restoreMailOnSource(core, apps, 'pvc-orig-123', 'staging2', SILENT);

    // PVC is already bound to the retained PV → no destructive re-create/delete.
    expect(deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalled();
  });

  it('case B (delete succeeded, empty replacement PVC): deletes it, clears claimRef, re-creates PVC pinned to the retained PV', async () => {
    const createNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({});
    const deleteNamespacedPersistentVolumeClaim = vi.fn().mockResolvedValue({});
    const patchPersistentVolume = vi.fn().mockResolvedValue({});
    // 1st read (restoreMailOnSource): empty replacement PVC bound to a DIFFERENT PV.
    // 2nd read (inside deletePvcAndWait loop): 404 → loop exits immediately.
    const readNamespacedPersistentVolumeClaim = vi.fn()
      .mockResolvedValueOnce({ spec: { volumeName: 'pvc-empty-999' } })
      .mockRejectedValue(notFound());
    const core = {
      readNamespacedPersistentVolumeClaim,
      createNamespacedPersistentVolumeClaim,
      deleteNamespacedPersistentVolumeClaim,
      patchPersistentVolume,
    } as unknown as AnyCore;
    const { apps } = appsStub();

    await restoreMailOnSource(core, apps, 'pvc-orig-123', 'staging2', SILENT);

    // Empty replacement deleted.
    expect(deleteNamespacedPersistentVolumeClaim).toHaveBeenCalled();
    // claimRef cleared on the retained PV (patch with claimRef: null).
    expect(patchPersistentVolume).toHaveBeenCalled();
    // PVC re-created PINNED (volumeName) to the original data PV.
    expect(createNamespacedPersistentVolumeClaim).toHaveBeenCalledTimes(1);
    const body = (createNamespacedPersistentVolumeClaim.mock.calls[0][0] as { body: { spec: { volumeName: string } } }).body;
    expect(body.spec.volumeName).toBe('pvc-orig-123');
  });
});
