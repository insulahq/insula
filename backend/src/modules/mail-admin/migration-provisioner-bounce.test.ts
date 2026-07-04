/**
 * Unit tests for the failback provisioner-bounce fix (TRUE failback root cause,
 * found on the rc.7 destructive run 2026-07-04).
 *
 * When the failover target's k3s restarts, the single-replica local-path
 * provisioner goes stale toward that node and its helper-pod-create times out,
 * so the fresh target PVC never binds → pod Pending → 600s scaling-up timeout.
 * Bouncing the provisioner pod (ReplicaSet recreates it) re-establishes the
 * connection and the PVC binds within seconds. ensureTargetPvcProvisions
 * automates that: poll the PVC and, if still unbound past a grace window, bounce
 * the provisioner (bounded).
 */

import { describe, expect, it, vi } from 'vitest';
import { bounceLocalPathProvisioner, ensureTargetPvcProvisions } from './migration.js';

const SILENT = { warn: () => {}, info: () => {} };
type AnyCore = Parameters<typeof ensureTargetPvcProvisions>[0];

describe('bounceLocalPathProvisioner', () => {
  it('deletes every local-path-provisioner pod and returns true', async () => {
    const del = vi.fn().mockResolvedValue({});
    const core = {
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'local-path-provisioner-abc' } }] }),
      deleteNamespacedPod: del,
    } as unknown as AnyCore;
    const ok = await bounceLocalPathProvisioner(core, SILENT);
    expect(ok).toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
    expect((del.mock.calls[0][0] as { name: string; namespace: string }).name).toBe('local-path-provisioner-abc');
    expect((del.mock.calls[0][0] as { namespace: string }).namespace).toBe('kube-system');
  });

  it('returns false (no-op) when no provisioner pod exists (custom storage backend)', async () => {
    const del = vi.fn();
    const core = {
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedPod: del,
    } as unknown as AnyCore;
    expect(await bounceLocalPathProvisioner(core, SILENT)).toBe(false);
    expect(del).not.toHaveBeenCalled();
  });

  it('never throws when listing pods fails', async () => {
    const core = {
      listNamespacedPod: vi.fn().mockRejectedValue(new Error('apiserver down')),
      deleteNamespacedPod: vi.fn(),
    } as unknown as AnyCore;
    await expect(bounceLocalPathProvisioner(core, SILENT)).resolves.toBe(false);
  });
});

describe('ensureTargetPvcProvisions', () => {
  const FAST = { graceSeconds: 0, overallSeconds: 5, maxBounces: 2, pollMs: 2 };

  it('returns immediately without bouncing when the PVC is already Bound', async () => {
    const del = vi.fn();
    const core = {
      readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ status: { phase: 'Bound' } }),
      listNamespacedPod: vi.fn(),
      deleteNamespacedPod: del,
    } as unknown as AnyCore;
    await ensureTargetPvcProvisions(core, SILENT, FAST);
    expect(del).not.toHaveBeenCalled();
  });

  it('bounces the provisioner when the PVC is stuck Pending, then returns once it binds', async () => {
    // Pending, Pending, then Bound (after the bounce).
    const read = vi.fn()
      .mockResolvedValueOnce({ status: { phase: 'Pending' } })
      .mockResolvedValueOnce({ status: { phase: 'Pending' } })
      .mockResolvedValue({ status: { phase: 'Bound' } });
    const del = vi.fn().mockResolvedValue({});
    const core = {
      readNamespacedPersistentVolumeClaim: read,
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'local-path-provisioner-xyz' } }] }),
      deleteNamespacedPod: del,
    } as unknown as AnyCore;
    await ensureTargetPvcProvisions(core, SILENT, FAST);
    expect(del).toHaveBeenCalled(); // provisioner was bounced
    expect((del.mock.calls[0][0] as { name: string }).name).toBe('local-path-provisioner-xyz');
  });

  it('bounces at most maxBounces times when the PVC never binds, then defers (no throw)', async () => {
    const core = {
      readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ status: { phase: 'Pending' } }),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [{ metadata: { name: 'lpp' } }] }),
      deleteNamespacedPod: vi.fn().mockResolvedValue({}),
    } as unknown as AnyCore;
    await expect(ensureTargetPvcProvisions(core, SILENT, { graceSeconds: 0, overallSeconds: 1, maxBounces: 2, pollMs: 2 }))
      .resolves.toBeUndefined();
    const del = (core as unknown as { deleteNamespacedPod: ReturnType<typeof vi.fn> }).deleteNamespacedPod;
    // Never exceeds maxBounces (2) regardless of how many poll iterations run.
    expect(del.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
