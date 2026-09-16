import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prunePods, podFinishedAt, isTerminalPod } from './service.js';

/**
 * Pruning dead pod records.
 *
 * Two properties carry all the risk, and both fail silently if wrong:
 *
 *   - a RUNNING pod must never be deleted. The sweep runs unattended on a
 *     6-hour timer, so a phase-matching slip takes production down quietly.
 *   - a pod belonging to an UNFINISHED Job must never be deleted. A Job counts
 *     its succeeded pods; remove one and the Job does the work AGAIN. For a
 *     backup or a migration that is a real side effect, not tidy-up.
 */

const NOW = new Date('2026-09-15T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function pod(o: {
  name: string; phase: string; finished?: string;
  ns?: string; owner?: { kind: string; name: string };
}) {
  return {
    metadata: {
      name: o.name,
      namespace: o.ns ?? 'platform',
      creationTimestamp: o.finished,
      ...(o.owner ? { ownerReferences: [o.owner] } : {}),
    },
    status: {
      phase: o.phase,
      containerStatuses: o.finished ? [{ state: { terminated: { finishedAt: o.finished } } }] : [],
    },
  };
}

function k8s(pods: unknown[], jobs: Record<string, { active?: number; completionTime?: string }> = {}) {
  const deleted: string[] = [];
  return {
    deleted,
    core: {
      listPodForAllNamespaces: vi.fn(async () => ({ items: pods })),
      deleteNamespacedPod: vi.fn(async (a: { name: string; namespace: string }) => {
        deleted.push(`${a.namespace}/${a.name}`);
        return {};
      }),
    } as never,
    batch: {
      readNamespacedJob: vi.fn(async (a: { name: string }) => {
        const j = jobs[a.name];
        if (!j) throw new Error('not found');
        return { status: j };
      }),
    } as never,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('prunePods: what must never be deleted', () => {
  it('never deletes a Running or Pending pod', async () => {
    const c = k8s([
      pod({ name: 'live', phase: 'Running', finished: daysAgo(90) }),
      pod({ name: 'waiting', phase: 'Pending', finished: daysAgo(90) }),
      pod({ name: 'dead', phase: 'Succeeded', finished: daysAgo(90) }),
    ]);
    const r = await prunePods({ core: c.core, batch: c.batch, olderThanDays: 0, now: NOW });
    expect(c.deleted).toEqual(['platform/dead']);
    expect(r.scanned).toBe(1);
  });

  it('never deletes a pod whose Job has not finished — that would re-run the work', async () => {
    const c = k8s(
      [pod({ name: 'bk-1', phase: 'Succeeded', finished: daysAgo(90), owner: { kind: 'Job', name: 'backup' } })],
      { backup: { active: 1 } },
    );
    const r = await prunePods({ core: c.core, batch: c.batch, olderThanDays: 0, now: NOW });
    expect(c.deleted).toEqual([]);
    expect(r.skipped[0]?.reason).toBe('job_still_active');
    expect(r.message).toMatch(/run the work again/);
  });

  it('DOES delete a pod whose Job has finished — nothing can recreate it', async () => {
    const c = k8s(
      [pod({ name: 'bk-2', phase: 'Succeeded', finished: daysAgo(90), owner: { kind: 'Job', name: 'done' } })],
      { done: { active: 0, completionTime: daysAgo(89) } },
    );
    await prunePods({ core: c.core, batch: c.batch, olderThanDays: 0, now: NOW });
    expect(c.deleted).toEqual(['platform/bk-2']);
  });

  it('treats a Job that no longer exists as safe to prune', async () => {
    const c = k8s([pod({ name: 'orphan', phase: 'Failed', finished: daysAgo(90), owner: { kind: 'Job', name: 'gone' } })]);
    await prunePods({ core: c.core, batch: c.batch, olderThanDays: 0, now: NOW });
    expect(c.deleted).toEqual(['platform/orphan']);
  });
});

describe('prunePods: the retention window', () => {
  it('keeps records younger than the window', async () => {
    const c = k8s([
      pod({ name: 'old', phase: 'Succeeded', finished: daysAgo(40) }),
      pod({ name: 'recent', phase: 'Succeeded', finished: daysAgo(5) }),
    ]);
    const r = await prunePods({ core: c.core, batch: c.batch, olderThanDays: 30, now: NOW });
    expect(c.deleted).toEqual(['platform/old']);
    expect(r.skipped[0]?.reason).toBe('too_young');
  });

  it('olderThanDays 0 means every dead record — what the manual button sends', async () => {
    const c = k8s([pod({ name: 'fresh-corpse', phase: 'Succeeded', finished: NOW.toISOString() })]);
    await prunePods({ core: c.core, batch: c.batch, olderThanDays: 0, now: NOW });
    expect(c.deleted).toEqual(['platform/fresh-corpse']);
  });

  it('keeps a record with no usable timestamp rather than guessing its age', async () => {
    // An evicted pod that never started a container has no finishedAt. Under a
    // non-zero window it survives; guessing would delete evidence.
    const c = k8s([{ metadata: { name: 'no-time', namespace: 'platform' }, status: { phase: 'Failed' } }]);
    const r = await prunePods({ core: c.core, batch: c.batch, olderThanDays: 30, now: NOW });
    expect(c.deleted).toEqual([]);
    expect(r.skipped[0]?.reason).toBe('too_young');
  });
});

describe('prunePods: reporting', () => {
  it('dry run deletes nothing but reports what it would take', async () => {
    const c = k8s([pod({ name: 'x', phase: 'Succeeded', finished: daysAgo(90) })]);
    const r = await prunePods({ core: c.core, batch: c.batch, olderThanDays: 0, dryRun: true, now: NOW });
    expect(c.deleted).toEqual([]);
    expect(r.pruned).toHaveLength(1);
    expect(r.message).toMatch(/Would remove/);
  });

  it('records a failed delete as skipped rather than pruned', async () => {
    // "Pruned" must mean gone. Counting a failure as success is how a surface
    // ends up claiming it cleaned something it did not.
    const c = k8s([pod({ name: 'stuck', phase: 'Succeeded', finished: daysAgo(90) })]);
    (c.core as unknown as { deleteNamespacedPod: unknown }).deleteNamespacedPod =
      vi.fn(async () => { throw new Error('forbidden'); });
    const r = await prunePods({ core: c.core, batch: c.batch, olderThanDays: 0, now: NOW });
    expect(r.pruned).toHaveLength(0);
    expect(r.skipped[0]?.reason).toBe('delete_failed');
    expect(r.message).toMatch(/could not be deleted/);
  });

  it('says so plainly when there is nothing to do', async () => {
    const c = k8s([pod({ name: 'live', phase: 'Running' })]);
    const r = await prunePods({ core: c.core, batch: c.batch, olderThanDays: 0, now: NOW });
    expect(r.message).toMatch(/No dead pod records/);
  });

  it('reproduces the production sweep: 43 records, one node shutdown', async () => {
    const pods = Array.from({ length: 43 }, (_, i) =>
      pod({ name: `corpse-${i}`, phase: 'Succeeded', finished: '2026-09-11T12:30:18Z', ns: 'tenant-x' }),
    );
    pods.push(pod({ name: 'running', phase: 'Running', ns: 'tenant-x' }) as never);
    const c = k8s(pods);
    const r = await prunePods({ core: c.core, batch: c.batch, olderThanDays: 0, now: NOW });
    expect(r.scanned).toBe(43);
    expect(r.pruned).toHaveLength(43);
    expect(c.deleted).not.toContain('tenant-x/running');
  });
});

describe('podFinishedAt', () => {
  it('prefers the latest container finish over creationTimestamp', () => {
    const p = {
      metadata: { creationTimestamp: daysAgo(90) },
      status: { containerStatuses: [
        { state: { terminated: { finishedAt: daysAgo(10) } } },
        { state: { terminated: { finishedAt: daysAgo(2) } } },
      ] },
    };
    expect(podFinishedAt(p)?.toISOString()).toBe(daysAgo(2));
  });

  it('falls back to creationTimestamp when no container reported a finish', () => {
    expect(podFinishedAt({ metadata: { creationTimestamp: daysAgo(3) }, status: {} })?.toISOString())
      .toBe(daysAgo(3));
  });

  it('returns null when there is nothing to go on', () => {
    expect(podFinishedAt({ status: {} })).toBeNull();
  });
});

describe('isTerminalPod', () => {
  it('matches only phases that can never run again', () => {
    expect(isTerminalPod({ status: { phase: 'Succeeded' } })).toBe(true);
    expect(isTerminalPod({ status: { phase: 'Failed' } })).toBe(true);
    for (const phase of ['Running', 'Pending', 'Unknown', '']) {
      expect(isTerminalPod({ status: { phase } }), phase).toBe(false);
    }
    expect(isTerminalPod({})).toBe(false);
  });
});
