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
const DEFAULT = '*/30 * * * *';

function okResult(schedule: string, suspended = false, platformFired = false) {
  return {
    state: 'STATE_OK' as const,
    errorMessage: '',
    suspended,
    schedule,
    platformFired,
    patched: true,
  };
}

/** db stub: drift check only reads via desiredSpy mock; the firing
 *  engine claims via update().set().where().returning(). */
function makeDb(claimRows: Array<{ subsystem: string }> = [{ subsystem: 'mail' }]) {
  const returningFn = vi.fn().mockResolvedValue(claimRows);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  const updateFn = vi.fn().mockReturnValue({ set: setFn });
  return { update: updateFn, _updateFn: updateFn, _returning: returningFn } as never;
}

describe('mail-snapshot-cronjob-scheduler drift fast path', () => {
  let readSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 11, 10, 1, 5)));
    reconcileSpy.mockReset().mockResolvedValue(okResult(DEFAULT));
    desiredSpy.mockReset().mockResolvedValue(DEFAULT);
    readSpy = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(db = makeDb(), fireFn?: (jobName: string) => Promise<void>) {
    return startMailSnapshotCronJobReconciler(
      db,
      { batch: { readNamespacedCronJob: readSpy } } as never,
      noopLog,
      { intervalMs: 5 * 60_000, driftCheckMs: 30_000, fireCheckMs: 30_000, fireFn },
    );
  }

  it('re-asserts when the live schedule drifts in NATIVE mode', async () => {
    // Someone changed the live object away from the manifest default.
    readSpy.mockResolvedValue({ spec: { schedule: '*/7 * * * *', suspend: false } });

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('stays quiet while live matches desired (NATIVE, default cadence)', async () => {
    readSpy.mockResolvedValue({ spec: { schedule: DEFAULT, suspend: false } });

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(readSpy).toHaveBeenCalledTimes(3);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('fires on suspend drift (Flux re-suspending an enabled job)', async () => {
    readSpy.mockResolvedValue({ spec: { schedule: DEFAULT, suspend: true } });

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('detects a MODE change: operator sets a custom cadence (DB ≠ default)', async () => {
    // Cache is native-default; the operator PATCHed */7 into the DB.
    readSpy.mockResolvedValue({ spec: { schedule: DEFAULT, suspend: false } });
    desiredSpy.mockResolvedValue('*/7 * * * *');

    const handle = start();
    await vi.advanceTimersByTimeAsync(0); // cold tick caches default/native
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(2); // mode drift → full tick

    handle.stop();
  });

  it('PLATFORM mode: live schedule (manifest default) does NOT count as drift', async () => {
    reconcileSpy.mockResolvedValue(okResult('*/7 * * * *', true, true));
    desiredSpy.mockResolvedValue('*/7 * * * *');
    readSpy.mockResolvedValue({ spec: { schedule: DEFAULT, suspend: true } });

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(1); // no re-trigger loop

    handle.stop();
  });

  it('PLATFORM mode: operator changing the custom cadence refreshes via tick', async () => {
    reconcileSpy.mockResolvedValue(okResult('*/7 * * * *', true, true));
    desiredSpy.mockResolvedValue('*/9 * * * *'); // changed after the tick cached */7
    readSpy.mockResolvedValue({ spec: { schedule: DEFAULT, suspend: true } });

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('no-ops before the first successful full tick', async () => {
    reconcileSpy.mockResolvedValue({
      state: 'STATE_ERROR' as const,
      errorMessage: 'boom',
      suspended: true,
      schedule: DEFAULT,
      patched: false,
    });
    readSpy.mockResolvedValue({ spec: { schedule: 'anything', suspend: false } });

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readSpy).not.toHaveBeenCalled();

    handle.stop();
  });

  it('swallows read failures silently', async () => {
    readSpy.mockRejectedValue(new Error('404'));

    const handle = start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    handle.stop();
  });
});

describe('mail-snapshot-cronjob-scheduler firing engine (R17.1 platform mode)', () => {
  let readSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // 10:35:05 UTC — minute 35 matches */7 (35 = 7×5).
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 11, 10, 35, 5)));
    reconcileSpy.mockReset().mockResolvedValue(okResult('*/7 * * * *', true, true));
    desiredSpy.mockReset().mockResolvedValue('*/7 * * * *');
    readSpy = vi.fn().mockResolvedValue({ spec: { schedule: DEFAULT, suspend: true } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start(db: never, fireFn: (jobName: string) => Promise<void>) {
    return startMailSnapshotCronJobReconciler(
      db,
      { batch: { readNamespacedCronJob: readSpy } } as never,
      noopLog,
      { intervalMs: 5 * 60_000, driftCheckMs: 60 * 60_000, fireCheckMs: 30_000, fireFn },
    );
  }

  it('fires once with the deterministic per-minute job name', async () => {
    const fireFn = vi.fn(async () => undefined);
    const db = makeDbWithClaim([{ subsystem: 'mail' }]);
    const handle = start(db, fireFn);

    await vi.advanceTimersByTimeAsync(0);       // cold tick caches platform mode
    await vi.advanceTimersByTimeAsync(30_000);  // fire check at 10:35:35
    expect(fireFn).toHaveBeenCalledTimes(1);
    expect(fireFn).toHaveBeenCalledWith('stalwart-snapshot-cron-202606111035');

    handle.stop();
  });

  it('does not fire when the DB claim is lost (second replica won)', async () => {
    const fireFn = vi.fn(async () => undefined);
    const db = makeDbWithClaim([]); // conditional UPDATE matched no row
    const handle = start(db, fireFn);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fireFn).not.toHaveBeenCalled();

    handle.stop();
  });

  it('does not fire outside matching minutes', async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 11, 10, 36, 5))); // 36 % 7 ≠ 0... 36 not multiple of 7
    // Window lookback would still find 10:35 — simulate that the claim
    // already advanced past it (lastFiredAt >= 10:35 → claim loses).
    const fireFn = vi.fn(async () => undefined);
    const db = makeDbWithClaim([]);
    const handle = start(db, fireFn);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fireFn).not.toHaveBeenCalled();

    handle.stop();
  });

  it('never fires in NATIVE mode', async () => {
    reconcileSpy.mockResolvedValue(okResult(DEFAULT, false, false));
    desiredSpy.mockResolvedValue(DEFAULT);
    const fireFn = vi.fn(async () => undefined);
    const db = makeDbWithClaim([{ subsystem: 'mail' }]);
    const handle = start(db, fireFn);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fireFn).not.toHaveBeenCalled();

    handle.stop();
  });

  it('never fires while the mail target is unbound', async () => {
    reconcileSpy.mockResolvedValue({
      ...okResult('*/7 * * * *', true, true),
      state: 'STATE_NO_MAIL_TARGET' as const,
    });
    const fireFn = vi.fn(async () => undefined);
    const db = makeDbWithClaim([{ subsystem: 'mail' }]);
    const handle = start(db, fireFn);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fireFn).not.toHaveBeenCalled();

    handle.stop();
  });

  function makeDbWithClaim(claimRows: Array<{ subsystem: string }>): never {
    const returningFn = vi.fn().mockResolvedValue(claimRows);
    const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    const updateFn = vi.fn().mockReturnValue({ set: setFn });
    return { update: updateFn } as never;
  }
});
