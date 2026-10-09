import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const claim = vi.fn(async (..._args: unknown[]) => true);
const release = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../../shared/scheduler-lease.js', () => ({
  claimSchedulerLease: (...a: unknown[]) => claim(...a),
  releaseSchedulerLease: (...a: unknown[]) => release(...a),
}));

const { withMailTaskLiveness, MAIL_TASK_LIVENESS_TTL_MS } = await import('./task-liveness.js');
const db = {} as never;
const names = (calls: unknown[][]) => calls.map((c) => c[1]);

describe('withMailTaskLiveness', () => {
  beforeEach(() => { claim.mockClear(); release.mockClear(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('holds a lease per id while the work runs, renews it, and releases it after', async () => {
    let finish!: () => void;
    const work = new Promise<void>((r) => { finish = r; });
    const run = withMailTaskLiveness(db, ['run-1', null, 'task-1'], () => work);
    await vi.advanceTimersByTimeAsync(0);
    expect(names(claim.mock.calls)).toEqual(['mail-task:run-1', 'mail-task:task-1']);
    expect(claim.mock.calls[0][2]).toBe(MAIL_TASK_LIVENESS_TTL_MS);

    await vi.advanceTimersByTimeAsync(MAIL_TASK_LIVENESS_TTL_MS / 3 + 1);
    expect(claim).toHaveBeenCalledTimes(4); // renewed both
    expect(release).not.toHaveBeenCalled();

    finish();
    await run;
    expect(names(release.mock.calls)).toEqual(['mail-task:run-1', 'mail-task:task-1']);
    await vi.advanceTimersByTimeAsync(MAIL_TASK_LIVENESS_TTL_MS);
    expect(claim).toHaveBeenCalledTimes(4); // no renewal after the work ended
  });

  it('releases the leases when the work throws, and rethrows', async () => {
    await expect(withMailTaskLiveness(db, ['run-2'], async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(names(release.mock.calls)).toEqual(['mail-task:run-2']);
  });

  it('never blocks the work: a lease that cannot be taken is logged and the work runs', async () => {
    claim.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.fn();
    await expect(withMailTaskLiveness(db, ['run-3'], async () => 'ran', { warn })).resolves.toBe('ran');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mail-task:run-3'), 'db down');
  });
});
