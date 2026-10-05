/**
 * The task reporter while the restore cart executes: `/execute` is one long
 * synchronous call, so the reporter reads the cart's items on a timer — that
 * is what tells the operator (chip + modal) WHICH item is applying.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../tasks/service.js', () => ({
  progress: vi.fn(async () => undefined),
  adoptChildByRef: vi.fn(async () => false),
}));
const taskService = await import('../tasks/service.js');
const { createTaskReporter, RESTORE_TICK_MS } = await import('./task-reporter.js');

function fakeApp(items: () => Array<{ type: string; status: string }>): FastifyInstance {
  const builder: Record<string, unknown> = {};
  for (const k of ['from', 'where', 'orderBy']) builder[k] = () => builder;
  builder.then = (resolve: (r: unknown[]) => void) => resolve(items());
  return {
    db: { select: () => builder },
    log: { warn: vi.fn() },
  } as unknown as FastifyInstance;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(taskService.progress).mockClear();
  vi.mocked(taskService.adoptChildByRef).mockClear().mockResolvedValue(false);
});
afterEach(() => vi.useRealTimers());

const texts = () => vi.mocked(taskService.progress).mock.calls.map((c) => c[2].text).filter(Boolean);

describe('task reporter — restore in flight', () => {
  it('says which item is applying, and how far along the cart is', async () => {
    let items = [
      { type: 'config-tables', status: 'done' },
      { type: 'files-paths', status: 'applying' },
      { type: 'databases-by-id', status: 'pending' },
    ];
    const reporter = createTaskReporter(fakeApp(() => items), 'task-1');
    await reporter.context({ cartId: 'cart-1' });
    await reporter.step('restore', 'running');

    await vi.advanceTimersByTimeAsync(RESTORE_TICK_MS + 10);
    expect(texts()).toContain('Restoring files (2 of 3)');

    items = [
      { type: 'config-tables', status: 'done' },
      { type: 'files-paths', status: 'done' },
      { type: 'databases-by-id', status: 'applying' },
    ];
    await vi.advanceTimersByTimeAsync(RESTORE_TICK_MS);
    expect(texts()).toContain('Restoring databases (3 of 3)');

    // Keeps trying to fold the cart's own row until it exists.
    expect(vi.mocked(taskService.adoptChildByRef)).toHaveBeenCalledWith(expect.anything(), 'restore.cart', 'cart-1', 'task-1');

    await reporter.step('restore', 'done');
    const writes = vi.mocked(taskService.progress).mock.calls.length;
    await vi.advanceTimersByTimeAsync(RESTORE_TICK_MS * 3);
    // Stopped with the step — no stale "Restoring …" after the restore is done.
    expect(vi.mocked(taskService.progress).mock.calls.length).toBe(writes);
    await reporter.dispose();
  });

  it('stops trying to fold a row once it has been adopted', async () => {
    vi.mocked(taskService.adoptChildByRef).mockResolvedValue(true);
    const reporter = createTaskReporter(fakeApp(() => []), 'task-1');
    await reporter.context({ provisioningTaskId: 'prov-1' });
    await reporter.dispose();
    expect(vi.mocked(taskService.adoptChildByRef)).toHaveBeenCalledTimes(1);
  });

  it('never throws when a progress write fails', async () => {
    vi.mocked(taskService.progress).mockRejectedValue(new Error('db down'));
    const reporter = createTaskReporter(fakeApp(() => []), 'task-1');
    await expect(reporter.step('bundle', 'running')).resolves.toBeUndefined();
    await expect(reporter.context({ bundleId: 'b-1' })).resolves.toBeUndefined();
    vi.mocked(taskService.progress).mockResolvedValue(undefined);
  });
});
