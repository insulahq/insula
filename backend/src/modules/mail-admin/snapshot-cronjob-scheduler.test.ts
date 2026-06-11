import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { reconcileSpy, desiredSpy } = vi.hoisted(() => ({
  reconcileSpy: vi.fn(),
  desiredSpy: vi.fn(),
}));

vi.mock('./snapshot-cronjob-reconciler.js', async () => {
  const actual = await vi.importActual<typeof import('./snapshot-cronjob-reconciler.js')>(
    './snapshot-cronjob-reconciler.js',
  );
  return {
    ...actual,
    reconcileMailSnapshotCronJob: reconcileSpy,
    resolveDesiredSchedule: desiredSpy,
  };
});

import { startMailSnapshotCronJobReconciler } from './snapshot-cronjob-scheduler.js';

const noopLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function okResult(schedule: string, suspended = false) {
  return {
    state: 'STATE_OK' as const,
    errorMessage: '',
    suspended,
    schedule,
    patched: true,
  };
}

describe('mail-snapshot-cronjob-scheduler drift fast path', () => {
  let readSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    reconcileSpy.mockReset().mockResolvedValue(okResult('*/7 * * * *'));
    desiredSpy.mockReset().mockResolvedValue('*/7 * * * *');
    readSpy = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start() {
    return startMailSnapshotCronJobReconciler(
      {} as never,
      { batch: { readNamespacedCronJob: readSpy } } as never,
      noopLog,
      { intervalMs: 5 * 60_000, driftCheckMs: 30_000 },
    );
  }

  it('re-asserts immediately when the live schedule drifts from the last desired', async () => {
    // Live object reverted by Flux to the manifest default.
    readSpy.mockResolvedValue({ spec: { schedule: '*/30 * * * *', suspend: false } });

    const handle = start();
    // Cold-start tick (setImmediate) caches desired = */7.
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    // First drift check at +30s sees the revert and fires a full tick.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('stays quiet while the live object matches desired', async () => {
    readSpy.mockResolvedValue({ spec: { schedule: '*/7 * * * *', suspend: false } });

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    // Several drift checks pass without triggering a reconcile.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(readSpy).toHaveBeenCalledTimes(3);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('fires on suspend drift too (Flux re-suspending an enabled job)', async () => {
    reconcileSpy.mockResolvedValue(okResult('*/7 * * * *', false));
    readSpy.mockResolvedValue({ spec: { schedule: '*/7 * * * *', suspend: true } });

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('no-ops before the first successful full tick (no cached desired state)', async () => {
    reconcileSpy.mockResolvedValue({
      state: 'STATE_ERROR' as const,
      errorMessage: 'boom',
      suspended: true,
      schedule: '*/30 * * * *',
      patched: false,
    });
    readSpy.mockResolvedValue({ spec: { schedule: 'anything', suspend: false } });

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    // Drift checks ran but never read the live object — desired unknown.
    expect(readSpy).not.toHaveBeenCalled();

    handle.stop();
  });

  it('swallows read failures silently (fresh install without the CronJob)', async () => {
    readSpy.mockRejectedValue(new Error('404'));

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(1); // only the cold-start tick

    handle.stop();
  });

  it('catches a stale-tick overwrite: DB-desired wins over a matching live+cache pair', async () => {
    // Lost-update shape (testing 2026-06-11): a tick that started
    // before an operator PATCH re-applied the OLD schedule after the
    // route's apply — live AND the scheduler cache both say the stale
    // value, only the DB has the operator's new one. The drift check
    // must compare against the DB, not the cache.
    reconcileSpy.mockResolvedValue(okResult('*/30 * * * *')); // stale tick result → cache=*/30
    readSpy.mockResolvedValue({ spec: { schedule: '*/30 * * * *', suspend: false } }); // live=*/30
    desiredSpy.mockResolvedValue('*/7 * * * *'); // operator's PATCH landed in the DB

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    // Cache (*/30) == live (*/30) — the OLD comparison would see no
    // drift; the DB read (*/7) forces the re-assert.
    expect(reconcileSpy).toHaveBeenCalledTimes(2);

    handle.stop();
  });
});
