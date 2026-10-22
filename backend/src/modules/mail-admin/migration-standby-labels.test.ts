import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import { moveStandbyLabelsWithStack } from './migration.js';

const enroll = vi.hoisted(() => vi.fn(async () => []));
vi.mock('./standby-prepare-task.js', () => ({ enrollStandbyPrepareTasks: enroll }));

/**
 * Step 8a: a finished migration moves the standby labels with the stack. A VM
 * failover drill ended with the label on the node that had just become active
 * and none on the secondary — the next failure would have restored from a stale
 * copy or restic.
 */
const STANDBY = 'insula.host/mail-standby';

function dbWithPlacement(row: Record<string, string | null> | Error): Database {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: row instanceof Error ? vi.fn().mockRejectedValue(row) : vi.fn().mockResolvedValue([row]),
      })),
    })),
  } as unknown as Database;
}

function clients(labelled: readonly string[]) {
  const patchNode = vi.fn(async (_req: { name: string; body: Array<{ op: string }> }) => undefined);
  const core = {
    listNode: vi.fn(async () => ({
      items: ['s1', 's2'].map((name) => ({
        metadata: { name, labels: labelled.includes(name) ? { [STANDBY]: 'true' } : {} },
      })),
    })),
    patchNode,
  };
  const batch = { createNamespacedJob: vi.fn(async () => undefined) };
  return { core, batch, patchNode };
}

describe('moveStandbyLabelsWithStack', () => {
  it('after a failback to the primary, stages the copy on the secondary instead', async () => {
    const { core, batch, patchNode } = clients(['s1']);
    const log = { warn: vi.fn(), info: vi.fn() };
    await moveStandbyLabelsWithStack(
      {
        db: dbWithPlacement({ mailPrimaryNode: 's1', mailSecondaryNode: 's2', mailTertiaryNode: null }),
        core: core as never,
        batch: batch as never,
      },
      's1',
      log,
    );
    expect(patchNode.mock.calls.map(([req]) => [req.name, req.body[0].op])).toEqual([['s1', 'remove'], ['s2', 'add']]);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('s2'));
  });

  // The node left as standby copies the whole store first: its own task, in the
  // chip of whoever started the migration (a DR failover has no one).
  it('gives the node it made a standby a first-copy task', async () => {
    enroll.mockClear();
    const { core, batch } = clients(['s1']);
    const db = dbWithPlacement({ mailPrimaryNode: 's1', mailSecondaryNode: 's2', mailTertiaryNode: null });
    await moveStandbyLabelsWithStack({ db, core: core as never, batch: batch as never, userId: 'u1' }, 's1', { warn: vi.fn(), info: vi.fn() });
    expect(enroll).toHaveBeenCalledWith(db, [{ node: 's2', since: expect.any(String) }], { userId: 'u1' }, expect.anything());

    enroll.mockClear();
    const again = clients(['s2']);
    await moveStandbyLabelsWithStack({ db, core: again.core as never, batch: again.batch as never }, 's1', { warn: vi.fn(), info: vi.fn() });
    expect(enroll).not.toHaveBeenCalled();
  });

  it('never fails the migration: an unreadable placement is logged, nothing is patched', async () => {
    const { core, batch, patchNode } = clients(['s1']);
    const log = { warn: vi.fn(), info: vi.fn() };
    await expect(
      moveStandbyLabelsWithStack(
        { db: dbWithPlacement(new Error('db down')), core: core as never, batch: batch as never },
        's1',
        log,
      ),
    ).resolves.toBeUndefined();
    expect(patchNode).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('standby labels'), expect.any(Error));
  });
});
