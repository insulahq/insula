import { describe, it, expect, vi, beforeEach } from 'vitest';

const unreachableSpy = vi.fn();
vi.mock('../notifications/events.js', () => ({
  notifyAdminBackupStale: vi.fn(),
  notifyAdminBackupNeverRun: vi.fn(),
  notifyAdminBackupTargetUnreachable: (...args: unknown[]) => {
    unreachableSpy(...args);
    return Promise.resolve();
  },
}));
import { countScheduledFires } from './freshness.js';
import {
  formatAge,
  isRunInFlight,
  oldEnoughToJudgeNever,
  checkMailTargetReachable,
  type WatchedSchedule,
} from './freshness-sweep.js';

const log = { warn: () => {}, info: () => {} };

const sched = (over: Partial<WatchedSchedule> = {}): WatchedSchedule => ({
  uid: 'u1',
  namespace: 'platform',
  name: 'nightly-backup',
  schedule: '0 3 * * *',
  suspended: false,
  lastSuccessAt: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  timeZone: null,
  activeRuns: 0,
  lastScheduleAt: null,
  ...over,
});

describe('formatAge', () => {
  it('switches to days past 48h so a subject line stays readable', () => {
    expect(formatAge(3_600_000)).toBe('1.0h');
    expect(formatAge(47 * 3_600_000)).toBe('47.0h');
    expect(formatAge(96 * 3_600_000)).toBe('4.0d');
  });
});

describe('oldEnoughToJudgeNever', () => {
  const now = new Date('2026-09-15T12:00:00Z');

  it('refuses to call a BRAND-NEW schedule "never run"', () => {
    // evaluateFreshness returns 'never' the moment lastSuccessAt is null, which
    // for a CronJob created minutes ago is true and a false alarm.
    const justCreated = sched({ createdAt: new Date('2026-09-15T11:58:00Z') });
    expect(oldEnoughToJudgeNever(justCreated, now)).toBe(false);
  });

  it('judges one that has had its chances', () => {
    // Created, daily at 03:00 → 14 fires by the 15th.
    expect(oldEnoughToJudgeNever(sched(), now)).toBe(true);
  });

  it('cannot judge without a schedule or a creation time', () => {
    expect(oldEnoughToJudgeNever(sched({ schedule: null }), now)).toBe(false);
    expect(oldEnoughToJudgeNever(sched({ createdAt: null }), now)).toBe(false);
  });
});

describe('checkMailTargetReachable', () => {
  const db = {} as never;

  const listing = (over: Record<string, unknown> = {}) => () => Promise.resolve({
    repoReachable: false,
    unreachableCause: 'unreachable' as const,
    reason: 'Restic list failed: connection refused',
    targetName: 'offsite-1',
    ...over,
  } as never);

  it('says nothing when the repo is reachable', async () => {
    expect(await checkMailTargetReachable(db, listing({ repoReachable: true, unreachableCause: null }), log))
      .toBe('ok');
  });

  it('does NOT alert when no target is configured', async () => {
    // Would otherwise fire forever on a fresh install.
    expect(await checkMailTargetReachable(db, listing({ unreachableCause: 'not_configured' }), log))
      .toBe('skipped');
  });

  it('does NOT alert while credentials are still provisioning', async () => {
    // Resolves itself in about a minute.
    expect(await checkMailTargetReachable(db, listing({ unreachableCause: 'provisioning' }), log))
      .toBe('skipped');
  });

  it('reads the CAUSE, not the human reason text', async () => {
    // The same prose with a non-fault cause must not alert — proving the
    // decision is not a string match on `reason`, which gets reworded.
    expect(await checkMailTargetReachable(
      db,
      listing({ unreachableCause: 'provisioning', reason: 'Restic list failed: connection refused' }),
      log,
    )).toBe('skipped');
  });

  it('DOES alert on a genuine unreachable target', async () => {
    // Without this the suite would pass just as happily if the function never
    // notified at all — every other case here asserts silence.
    unreachableSpy.mockClear();
    expect(await checkMailTargetReachable(db, listing(), log)).toBe('notified');
    expect(unreachableSpy).toHaveBeenCalledOnce();
    const [, payload, dedupeKey] = unreachableSpy.mock.calls[0];
    expect(payload).toMatchObject({ targetName: 'offsite-1' });
    expect(dedupeKey).toContain('unreachable');
  });

  it('DOES alert on a timeout', async () => {
    unreachableSpy.mockClear();
    expect(await checkMailTargetReachable(db, listing({ unreachableCause: 'timed_out' }), log))
      .toBe('notified');
    expect(unreachableSpy).toHaveBeenCalledOnce();
  });

  it('treats a listing that throws as unknown, not as healthy', async () => {
    const thrower = () => Promise.reject(new Error('apiserver down'));
    expect(await checkMailTargetReachable(db, thrower as never, log)).toBe('skipped');
  });
});

describe('schedules fire in their own timezone, not the cluster\'s assumption', () => {
  // cron-match.ts evaluates purely in UTC and documents the assumption that
  // "the platform runs UTC everywhere". Kubernetes does not: it fires a
  // CronJob in spec.timeZone. Counting a Europe/Berlin schedule in UTC
  // mis-counts by the offset — phantom missed fires (a false "backups have
  // stopped"), or a real outage hidden.
  it('does not invent a missed fire for a Berlin daily job', () => {
    // 03:00 Berlin in winter = 02:00 UTC. At 02:30 UTC the 03:00 Berlin run
    // has ALREADY happened; counting in UTC would still be waiting for 03:00
    // UTC and would see the gap as a miss.
    const lastSuccess = new Date('2026-01-10T02:00:30Z'); // the Berlin 03:00 run
    const now = new Date('2026-01-10T02:30:00Z');

    const berlin = countScheduledFires('0 3 * * *', lastSuccess, now, undefined, 'Europe/Berlin');
    expect(berlin).toBe(0);
  });

  it('counts the SAME schedule differently once the zone is applied', () => {
    const lastSuccess = new Date('2026-01-10T02:00:30Z');
    const now = new Date('2026-01-10T03:30:00Z');

    // In UTC the 03:00 fire has passed -> 1 "missed" run.
    expect(countScheduledFires('0 3 * * *', lastSuccess, now)).toBe(1);
    // In Berlin the next fire is not until 03:00 local (02:00 UTC tomorrow).
    expect(countScheduledFires('0 3 * * *', lastSuccess, now, undefined, 'Europe/Berlin')).toBe(0);
  });

  it('is DST-correct rather than applying a fixed offset', () => {
    // Berlin is UTC+1 in January and UTC+2 in July. A fixed offset would get
    // one of these wrong.
    const winter = countScheduledFires(
      '0 3 * * *', new Date('2026-01-10T00:00:00Z'), new Date('2026-01-10T23:00:00Z'),
      undefined, 'Europe/Berlin',
    );
    const summer = countScheduledFires(
      '0 3 * * *', new Date('2026-07-10T00:00:00Z'), new Date('2026-07-10T23:00:00Z'),
      undefined, 'Europe/Berlin',
    );
    expect(winter).toBe(1);
    expect(summer).toBe(1);
  });

  it('falls back to UTC for an unknown zone instead of throwing', () => {
    // One bad spec.timeZone must not take the whole sweep down.
    expect(() => countScheduledFires(
      '0 3 * * *', new Date('2026-01-10T00:00:00Z'), new Date('2026-01-10T23:00:00Z'),
      undefined, 'Mars/Olympus_Mons',
    )).not.toThrow();
  });
});


describe('a run in flight is not a missed run', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const DAY = 24 * 3_600_000;

  it('treats an active, recently-scheduled run as in flight', () => {
    // Otherwise a daily backup that simply takes a while to finish gets
    // reported as stale while it is still running.
    const s = sched({ activeRuns: 1, lastScheduleAt: new Date('2026-09-15T11:50:00Z') });
    expect(isRunInFlight(s, now, DAY)).toBe(true);
  });

  it('does NOT hide a run that has been stuck longer than a full interval', () => {
    // A Job wedged Pending forever stays active indefinitely. That is the one
    // failure with no FAILED Job and no MISSING run — if "active" excused it
    // unconditionally, it would never be reported by anything.
    const s = sched({ activeRuns: 1, lastScheduleAt: new Date('2026-09-13T03:00:00Z') });
    expect(isRunInFlight(s, now, DAY)).toBe(false);
  });

  it('is not in flight when nothing is active', () => {
    expect(isRunInFlight(sched({ activeRuns: 0 }), now, DAY)).toBe(false);
  });
});
