/**
 * A background recovery heartbeats its task row, so a new start can tell a
 * live run from one whose process died (./exclusive.ts reaps those).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../tasks/service.js', () => ({
  progress: vi.fn(async () => undefined),
}));
const taskService = await import('../tasks/service.js');
const { startHeartbeat, HEARTBEAT_MS, STALE_AFTER_SECONDS } = await import('./liveness.js');

const app = { db: {}, log: { warn: vi.fn() } } as unknown as FastifyInstance;

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(taskService.progress).mockClear();
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
    expect(STALE_AFTER_SECONDS * 1000).toBeGreaterThanOrEqual(HEARTBEAT_MS * 4);
  });

  it('a failed heartbeat write is logged, never thrown', async () => {
    vi.mocked(taskService.progress).mockRejectedValueOnce(new Error('db down'));
    const stop = startHeartbeat(app, 'task-1');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 10);
    stop();
    expect(app.log.warn).toHaveBeenCalled();
  });
});
