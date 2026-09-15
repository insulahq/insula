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

// These fan-outs now DISPATCH through the categorised path instead of writing a
// row per admin straight into the notifications table. The old assertions read
// the INSERT values, which is exactly the coupling that let a data-loss alert
// exist with no category, no template, no email and no delivery audit.
const notifyOperationalMock = vi.fn(async () => undefined);
vi.mock('../notifications/events.js', () => ({
  notifyAdminOperationalEvent: (...a: unknown[]) => notifyOperationalMock(...(a as [])),
}));
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
    const { db } = makeDb(['admin-1', 'admin-2']);
    await notifyAdminsMailDataLoss(db, 'run-xyz', 'staging1', '1 domain missing (ids: ce)');

    // ONE categorised event, not one row per admin. Recipient fan-out is the
    // dispatcher's job now, which is what gives this alert a template, an
    // email leg, a preference gate and a delivery audit it never had.
    expect(notifyOperationalMock).toHaveBeenCalledTimes(1);
    const [, subsystem, payload] = notifyOperationalMock.mock.calls[0] as unknown[];
    expect(subsystem).toBe('mail');
    const p = payload as Record<string, string>;
    expect(p.severityLabel.toLowerCase()).toContain('data loss');
    expect(p.objectLabel).toContain('run-xyz');
    expect(p.objectLabel).toContain('staging1');
    expect(p.detail).toContain('1 domain missing (ids: ce)');
  });

  it('is a no-op fan-out (never throws) when there are no admins', async () => {
    const { db } = makeDb([]);
    await expect(notifyAdminsMailDataLoss(db, 'run-xyz', 'staging1', 'reason')).resolves.toBeUndefined();
  });

  it('swallows a failing admin query (alert fan-out must never block the cutover)', async () => {
    const db = {
      select: () => ({ from: () => ({ where: async () => { throw new Error('db down'); } }) }),
      insert: () => ({ values: () => Promise.resolve() }),
    } as unknown as AnyDb;
    await expect(notifyAdminsMailDataLoss(db, 'run-xyz', 'staging1', 'reason')).resolves.toBeUndefined();
  });
});
