/**
 * A leased job that re-arms itself must keep doing so on a replica that does
 * NOT hold the lease — once per interval, no more.
 *
 * These loops are `setTimeout` chains: the tick runs, then arms the next one.
 * Putting the tick's work behind the lease moves it into a closure, and the
 * two ways to get that wrong are silent. Arm the next tick inside the closure
 * and a replica that is refused the lease never ticks again — when the holder
 * dies, nobody takes the job over. Leave an early-return re-arm in place as
 * well as the one after the closure and every tick arms two, doubling the
 * rate each interval. (`setInterval` jobs cannot fail either way.)
 *
 * So each loop is started against a database on which another replica holds
 * every lease, and its lease claims are counted over three equal windows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A database on which another replica holds every lease: a claim matches no row. Settings reads find nothing. */
function leasesHeldElsewhere(): { db: never; claims: () => number } {
  const execute = vi.fn(async () => ({ rows: [] }));
  const noRows = { from: () => ({ where: async () => [] }) };
  return { db: { execute, select: () => noRows } as never, claims: () => execute.mock.calls.length };
}

const k8s = { core: { listNamespacedSecret: async () => ({ items: [] }) } } as never;
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

/** Let work that is not a timer — a tick's `await import(…)` — finish before the clock moves on. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Advance the clock in steps no longer than the shortest interval, settling after each. */
async function advance(totalMs: number, stepMs: number): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await settle();
  }
}

interface Loop {
  readonly name: string;
  /** One claim is expected per interval. */
  readonly intervalMs: number;
  readonly start: (db: never) => Promise<() => void>;
}

const LOOPS: readonly Loop[] = [
  {
    name: 'longhorn-recurring-jobs',
    intervalMs: 15 * MIN,
    start: async (db) => {
      const { startLonghornRecurringJobReconciler } = await import('../modules/longhorn-recurring-jobs/scheduler.js');
      return startLonghornRecurringJobReconciler(db, quiet).stop;
    },
  },
  {
    name: 'monitoring-evaluator',
    intervalMs: MIN,
    start: async (db) => {
      const { startMonitoringEvaluator } = await import('../modules/monitoring/scheduler.js');
      return startMonitoringEvaluator(db, quiet).stop;
    },
  },
  {
    name: 'mailbox-usage-sync',
    intervalMs: 15 * MIN,
    start: async (db) => {
      const { startMailStatsScheduler, stopMailStatsScheduler } = await import('../modules/mail-stats/scheduler.js');
      const handle = startMailStatsScheduler(db);
      return () => stopMailStatsScheduler(handle);
    },
  },
  {
    name: 'storage-capacity-watch',
    intervalMs: 5 * MIN,
    start: async (db) => {
      const { startCapacityReconciler } = await import('../modules/platform-storage-policy/capacity-reconciler.js');
      return startCapacityReconciler(db, k8s).stop;
    },
  },
  {
    name: 'storage-policy-advisor',
    intervalMs: 5 * MIN,
    start: async (db) => {
      const { startStoragePolicyAdvisor } = await import('../modules/platform-storage-policy/scheduler.js');
      return startStoragePolicyAdvisor(db, k8s).stop;
    },
  },
  {
    name: 'released-pv-janitor',
    intervalMs: DAY,
    start: async (db) => {
      const { startReleasedPvJanitor } = await import('../modules/orphaned-volumes/janitor.js');
      return startReleasedPvJanitor(db, k8s).stop;
    },
  },
];

describe('a leased loop keeps ticking on a replica that does not hold the lease', () => {
  beforeEach(() => {
    // setImmediate stays real: `settle` uses it to let a tick's `await import()` finish.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(LOOPS)('$name claims once per interval — never stops, never doubles', async ({ intervalMs, start }) => {
    const { db, claims } = leasesHeldElsewhere();
    const stop = await start(db);
    try {
      const window = 12 * intervalMs;
      await advance(window, intervalMs);
      const first = claims();
      expect(first).toBeGreaterThanOrEqual(1);
      await advance(window, intervalMs);
      const second = claims();
      await advance(window, intervalMs);
      const third = claims();
      expect({ secondWindow: second - first, thirdWindow: third - second }).toEqual({ secondWindow: 12, thirdWindow: 12 });
    } finally {
      stop();
    }
  });

  it('storage-lifecycle: each of its seven leased loops claims at its own interval', { timeout: 60_000 }, async () => {
    const { startStorageLifecycleScheduler } = await import('../modules/storage-lifecycle/scheduler.js');
    const { db, claims } = leasesHeldElsewhere();
    const { stop } = startStorageLifecycleScheduler(db, k8s, {});
    try {
      // A week holds a whole number of every interval:
      //   operation pick-up 2 min → 5040, workload health 1 min → 10080, quiesce
      //   watchdog 15 min → 672, namespace integrity 30 min → 336, snapshot
      //   expiry 6 h → 28, auto-archive 6 h → 28, audit 7 d → 1. (The orphan
      //   Secret sweep takes no lease.)
      const perWeek = 5040 + 10080 + 672 + 336 + 28 + 28 + 1;
      await advance(7 * DAY, 5 * MIN);
      const first = claims();
      await advance(7 * DAY, 5 * MIN);
      const second = claims();
      await advance(7 * DAY, 5 * MIN);
      const third = claims();
      expect({ secondWeek: second - first, thirdWeek: third - second }).toEqual({ secondWeek: perWeek, thirdWeek: perWeek });
    } finally {
      stop();
    }
  });
});
