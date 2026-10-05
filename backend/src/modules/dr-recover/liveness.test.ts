/**
 * A background recovery heartbeats its task row; a new start fails the rows
 * that stopped (their process died) instead of refusing for 24 hours.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../tasks/service.js', () => ({
  progress: vi.fn(async () => undefined),
  failStaleActive: vi.fn(async () => 1),
}));
const taskService = await import('../tasks/service.js');
const { startHeartbeat, clearAbandoned, HEARTBEAT_MS, STALE_AFTER_MS } = await import('./liveness.js');

const app = { db: {}, log: { warn: vi.fn() } } as unknown as FastifyInstance;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(taskService.progress).mockClear();
  vi.mocked(taskService.failStaleActive).mockClear();
});
afterEach(() => vi.useRealTimers());

describe('recovery liveness', () => {
  it('refreshes the row while the run is alive, and stops with it', async () => {
    const stop = startHeartbeat(app, 'task-1');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2 + 10);
    expect(vi.mocked(taskService.progress)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(taskService.progress)).toHaveBeenCalledWith(app.db, 'task-1', {});
    stop();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(vi.mocked(taskService.progress)).toHaveBeenCalledTimes(2);
  });

  it('calls a run abandoned only after several missed heartbeats', () => {
    expect(STALE_AFTER_MS).toBeGreaterThanOrEqual(HEARTBEAT_MS * 4);
  });

  it('a failure to clear abandoned runs never blocks the start', async () => {
    vi.mocked(taskService.failStaleActive).mockRejectedValueOnce(new Error('db down'));
    await expect(clearAbandoned(app, 'dr.recover', 't-1')).resolves.toBeUndefined();
  });
});
