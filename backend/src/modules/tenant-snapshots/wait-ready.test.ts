import { describe, it, expect } from 'vitest';
import { waitForSnapshotReady } from './service.js';
import type { Deps } from './service.js';

// waitForSnapshotReady polls an injectable list fn + clock. We drive the
// snapshot through states without touching k8s/db.
const deps = {} as unknown as Deps;
const snap = (status: string, lastError: string | null = null) => ({
  id: 's1', tenantId: 't1', label: null, status, sizeBytes: 0,
  lastError, createdAt: '', readyAt: null, expiresAt: '',
});

describe('waitForSnapshotReady', () => {
  it('returns the snapshot once it reaches ready', async () => {
    const seq = ['creating', 'creating', 'ready'];
    let i = 0;
    const list = async () => ({ snapshots: [snap(seq[Math.min(i++, seq.length - 1)]!)] });
    const r = await waitForSnapshotReady(deps, 't1', 's1', { intervalMs: 0, list });
    expect(r.status).toBe('ready');
    expect(i).toBe(3);
  });

  it('throws SNAPSHOT_FAILED when the snapshot errors', async () => {
    const list = async () => ({ snapshots: [snap('error', 'volume detached')] });
    await expect(waitForSnapshotReady(deps, 't1', 's1', { intervalMs: 0, list }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_FAILED' });
  });

  it('throws SNAPSHOT_NOT_FOUND when the row vanishes', async () => {
    const list = async () => ({ snapshots: [] as ReturnType<typeof snap>[] });
    await expect(waitForSnapshotReady(deps, 't1', 's1', { intervalMs: 0, list }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_NOT_FOUND' });
  });

  it('throws SNAPSHOT_TIMEOUT when it never becomes ready', async () => {
    const list = async () => ({ snapshots: [snap('creating')] });
    let t = 0;
    const now = () => (t += 50_000); // jumps past the 120s default after a few ticks
    await expect(waitForSnapshotReady(deps, 't1', 's1', { intervalMs: 0, list, now }))
      .rejects.toMatchObject({ code: 'SNAPSHOT_TIMEOUT' });
  });
});
