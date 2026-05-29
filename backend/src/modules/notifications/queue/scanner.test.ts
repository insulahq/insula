import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reenqueueStuckDeliveries } from './scanner.js';

function buildDb(rows: Array<{ id: string; status: string; attempt: number }>) {
  const select = vi.fn().mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  }));
  return { select } as unknown as Parameters<typeof reenqueueStuckDeliveries>[0];
}

const enqueueMock = vi.fn();

beforeEach(() => {
  enqueueMock.mockReset();
});

describe('reenqueueStuckDeliveries', () => {
  it('returns zero counters when no candidates', async () => {
    const r = await reenqueueStuckDeliveries(buildDb([]), { enqueue: enqueueMock });
    expect(r).toEqual({ scanned: 0, reenqueued: 0, failed: 0 });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('re-enqueues one job per candidate row', async () => {
    enqueueMock.mockResolvedValue('job');
    const r = await reenqueueStuckDeliveries(
      buildDb([
        { id: 'd1', status: 'queued', attempt: 0 },
        { id: 'd2', status: 'failed', attempt: 2 },
      ]),
      { enqueue: enqueueMock },
    );
    expect(r.scanned).toBe(2);
    expect(r.reenqueued).toBe(2);
    expect(r.failed).toBe(0);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });

  it('counts failures from enqueue.send without aborting the batch', async () => {
    enqueueMock.mockResolvedValueOnce('job').mockRejectedValueOnce(new Error('boss down'));
    const r = await reenqueueStuckDeliveries(
      buildDb([
        { id: 'd1', status: 'queued', attempt: 0 },
        { id: 'd2', status: 'queued', attempt: 0 },
      ]),
      { enqueue: enqueueMock },
    );
    expect(r.scanned).toBe(2);
    expect(r.reenqueued).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('singletonKey includes the scan-tick suffix and attempt', async () => {
    enqueueMock.mockResolvedValue('job');
    const fixedNow = new Date('2026-05-28T20:00:00Z');
    await reenqueueStuckDeliveries(
      buildDb([{ id: 'd1', status: 'failed', attempt: 3 }]),
      { enqueue: enqueueMock, now: fixedNow },
    );
    const [, opts] = enqueueMock.mock.calls[0];
    expect(opts.singletonKey).toContain('delivery:d1:scan:');
    expect(opts.singletonKey).toContain(':attempt:3');
  });
});
