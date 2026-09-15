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
import {
  formatAge,
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
    // Created 2026-09-01, daily at 03:00 → 14 fires by the 15th.
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
