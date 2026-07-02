/**
 * Unit tests for the node-loss recovery helpers added 2026-07-02 (Gap A/B):
 * a failed restore-verify must be able to distinguish a live source (roll back)
 * from a dead one (availability cutover + data-loss alert). These guard the two
 * decision inputs — node liveness + the admin data-loss fan-out.
 *
 * The full escalation/cutover flow (restic re-restore → re-verify → cutover) is
 * validated end-to-end by scripts/integration-mail-dr-dataplane.sh's true
 * node-loss variant against a live cluster; the state machine has too many k8s
 * calls to exercise meaningfully in isolation.
 */

import { describe, expect, it, vi } from 'vitest';
import { isNodeReadyForRollback, notifyAdminsMailDataLoss } from './migration.js';

type AnyCore = Parameters<typeof isNodeReadyForRollback>[0];
type AnyDb = Parameters<typeof notifyAdminsMailDataLoss>[0];

describe('isNodeReadyForRollback (source-liveness gate for verify-fail)', () => {
  it('returns true when the node Ready condition is True', async () => {
    const core = {
      readNode: vi.fn().mockResolvedValue({ status: { conditions: [{ type: 'Ready', status: 'True' }] } }),
    } as unknown as AnyCore;
    expect(await isNodeReadyForRollback(core, 'staging1')).toBe(true);
  });

  it('returns false when the node is NotReady (Ready=False)', async () => {
    const core = {
      readNode: vi.fn().mockResolvedValue({ status: { conditions: [{ type: 'Ready', status: 'False' }] } }),
    } as unknown as AnyCore;
    expect(await isNodeReadyForRollback(core, 'staging1')).toBe(false);
  });

  it('returns false when the node is gone / API unreachable (readNode throws) — drives the availability cutover', async () => {
    const core = {
      readNode: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
    } as unknown as AnyCore;
    expect(await isNodeReadyForRollback(core, 'dead-node')).toBe(false);
  });

  it('returns false when the Ready condition is absent', async () => {
    const core = {
      readNode: vi.fn().mockResolvedValue({ status: { conditions: [{ type: 'MemoryPressure', status: 'False' }] } }),
    } as unknown as AnyCore;
    expect(await isNodeReadyForRollback(core, 'staging1')).toBe(false);
  });
});

describe('notifyAdminsMailDataLoss (loud alert on availability cutover)', () => {
  function makeDb(adminIds: string[]) {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({ from: () => ({ where: async () => adminIds.map((id) => ({ id })) }) }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return Promise.resolve();
        },
      }),
    } as unknown as AnyDb;
    return { db, inserted };
  }

  it('inserts an error-level notification for every admin, linked to the migration run', async () => {
    const { db, inserted } = makeDb(['admin-1', 'admin-2']);
    await notifyAdminsMailDataLoss(db, 'run-xyz', 'staging1', '1 domain missing (ids: ce)');
    expect(inserted).toHaveLength(2);
    for (const n of inserted) {
      expect(n.type).toBe('error');
      expect(n.resourceType).toBe('mail_migration');
      expect(n.resourceId).toBe('run-xyz');
      expect(String(n.title).toLowerCase()).toContain('data loss');
      expect(String(n.message)).toContain('staging1');
      expect(String(n.message)).toContain('1 domain missing (ids: ce)');
    }
    expect(new Set(inserted.map((n) => n.userId))).toEqual(new Set(['admin-1', 'admin-2']));
  });

  it('is a no-op fan-out (never throws) when there are no admins', async () => {
    const { db, inserted } = makeDb([]);
    await expect(notifyAdminsMailDataLoss(db, 'run-xyz', 'staging1', 'reason')).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });

  it('swallows a failing admin query (alert fan-out must never block the cutover)', async () => {
    const db = {
      select: () => ({ from: () => ({ where: async () => { throw new Error('db down'); } }) }),
      insert: () => ({ values: () => Promise.resolve() }),
    } as unknown as AnyDb;
    await expect(notifyAdminsMailDataLoss(db, 'run-xyz', 'staging1', 'reason')).resolves.toBeUndefined();
  });
});
