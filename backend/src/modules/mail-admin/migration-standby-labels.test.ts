import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import { moveStandbyLabelsWithStack } from './migration.js';

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
