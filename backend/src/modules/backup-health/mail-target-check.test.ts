/**
 * The mail target check lists the mail restic repository in a Job. It ran on
 * every freshness tick (5 min) on every platform-api replica: three listing
 * Jobs every five minutes on a three-replica cluster. It now follows the mail
 * snapshot schedule — once after each snapshot has had time to run — bounded
 * to at most every 15 minutes and at least every 6 hours.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  startFreshnessSweep,
  createMailCheckGate,
  lastScheduledFire,
  mailCheckDue,
  MAIL_CHECK_MAX_SPACING_MS,
  MAIL_CHECK_MIN_SPACING_MS,
  MAIL_CHECK_UNALIGNED_MS,
  FRESHNESS_TICK_MS,
  type MailSnapshotSchedule,
} from './freshness-sweep.js';

const at = (iso: string) => new Date(iso);
const MIN = 60_000;
const log = { warn: vi.fn() };

/** Drive the gate the way the sweep does: one tick every FRESHNESS_TICK_MS. Returns the check times. */
async function simulate(schedule: MailSnapshotSchedule | null | 'throws', fromIso: string, hours: number): Promise<Date[]> {
  const gate = createMailCheckGate({
    mailSchedule: async () => {
      if (schedule === 'throws') throw new Error('db down');
      return schedule;
    },
    log,
  });
  const checks: Date[] = [];
  const start = at(fromIso).getTime();
  for (let t = start; t <= start + hours * 60 * MIN; t += FRESHNESS_TICK_MS) {
    const now = new Date(t);
    if (await gate.due(now)) { gate.ran(now); checks.push(now); }
  }
  return checks;
}

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

describe('lastScheduledFire', () => {
  it('the most recent matching minute at or before the instant', () => {
    expect(lastScheduledFire('37 * * * *', at('2026-10-09T22:41:30Z'), null, 6 * 60 * MIN)?.toISOString()).toBe('2026-10-09T22:37:00.000Z');
    expect(lastScheduledFire('37 * * * *', at('2026-10-09T22:37:00Z'), null, 6 * 60 * MIN)?.toISOString()).toBe('2026-10-09T22:37:00.000Z');
    expect(lastScheduledFire('37 * * * *', at('2026-10-09T22:36:59Z'), null, 6 * 60 * MIN)?.toISOString()).toBe('2026-10-09T21:37:00.000Z');
  });

  it('reads the cron in the platform zone (a 03:00 Berlin snapshot is 01:00 UTC in summer)', () => {
    expect(lastScheduledFire('0 3 * * *', at('2026-07-01T02:00:00Z'), 'Europe/Berlin', 6 * 60 * MIN)?.toISOString()).toBe('2026-07-01T01:00:00.000Z');
  });

  it('nothing within the lookback is null, not a guess', () => {
    expect(lastScheduledFire('0 3 * * *', at('2026-07-01T12:00:00Z'), null, 6 * 60 * MIN)).toBeNull();
  });
});

describe('mailCheckDue', () => {
  const now = at('2026-10-09T23:00:00Z');
  it('the first check after starting (or taking the lease over) runs at once', () => {
    expect(mailCheckDue({ now, lastCheckAt: null, lastSettledFire: null, aligned: true })).toBe(true);
  });
  it('never sooner than the minimum spacing, even after a newer snapshot', () => {
    const lastCheckAt = new Date(now.getTime() - MAIL_CHECK_MIN_SPACING_MS + MIN);
    expect(mailCheckDue({ now, lastCheckAt, lastSettledFire: new Date(now.getTime() - MIN), aligned: true })).toBe(false);
  });
  it('after a snapshot newer than the last check: due; none since: not due', () => {
    const lastCheckAt = at('2026-10-09T22:00:00Z');
    expect(mailCheckDue({ now, lastCheckAt, lastSettledFire: at('2026-10-09T22:37:00Z'), aligned: true })).toBe(true);
    expect(mailCheckDue({ now, lastCheckAt, lastSettledFire: at('2026-10-09T21:37:00Z'), aligned: true })).toBe(false);
  });
  it('at least every 6 hours whatever the schedule; hourly without one', () => {
    expect(mailCheckDue({ now, lastCheckAt: new Date(now.getTime() - MAIL_CHECK_MAX_SPACING_MS), lastSettledFire: null, aligned: true })).toBe(true);
    expect(mailCheckDue({ now, lastCheckAt: new Date(now.getTime() - MAIL_CHECK_UNALIGNED_MS), lastSettledFire: null, aligned: false })).toBe(true);
    expect(mailCheckDue({ now, lastCheckAt: new Date(now.getTime() - MAIL_CHECK_UNALIGNED_MS + MIN), lastSettledFire: null, aligned: false })).toBe(false);
  });
});

describe('the check follows the mail snapshot schedule (simulated sweep ticks)', () => {
  it('hourly snapshots at :37 → one check an hour, 5–10 minutes after each snapshot (was 12 an hour per replica)', async () => {
    const checks = await simulate({ cron: '37 * * * *', enabled: true, timeZone: null }, '2026-10-09T20:00:00Z', 4);
    // The start-up check, then one per hour after each :37 snapshot has settled.
    expect(checks.map(hhmm)).toEqual(['20:00', '20:45', '21:45', '22:45', '23:45']);
  });

  it('every 30 minutes → every 30 minutes', async () => {
    const checks = await simulate({ cron: '*/30 * * * *', enabled: true, timeZone: null }, '2026-10-09T20:00:00Z', 2.25);
    expect(checks.map(hhmm)).toEqual(['20:00', '20:35', '21:05', '21:35', '22:05']);
  });

  it('a schedule firing every 2 minutes is still checked only every 15 minutes', async () => {
    const checks = await simulate({ cron: '*/2 * * * *', enabled: true, timeZone: null }, '2026-10-09T20:00:00Z', 1);
    expect(checks.map(hhmm)).toEqual(['20:00', '20:15', '20:30', '20:45', '21:00']);
  });

  it('a daily snapshot is followed, and still checked at least every 6 hours', async () => {
    const checks = await simulate({ cron: '0 3 * * *', enabled: true, timeZone: null }, '2026-10-09T00:00:00Z', 24);
    expect(checks.map(hhmm)).toEqual(['00:00', '03:05', '09:05', '15:05', '21:05']);
  });

  it('a disabled or unreadable schedule falls back to hourly', async () => {
    for (const schedule of [{ cron: '37 * * * *', enabled: false, timeZone: null }, null, 'throws'] as const) {
      const checks = await simulate(schedule, '2026-10-09T20:00:00Z', 3);
      expect(checks.map(hhmm)).toEqual(['20:00', '21:00', '22:00', '23:00']);
    }
  });
});

describe('the sweep on a replica (lease + mail check wiring)', () => {
  const HOUR = 60 * MIN;
  /** A database that only answers the lease claim: `held` decides whether this replica gets it. */
  const leaseDb = (held: () => boolean) => ({ execute: vi.fn(async () => ({ rows: held() ? [{}] : [] })) });
  const reachable = { repoReachable: true, unreachableCause: null, reason: null, targetName: 'mail' } as const;

  function start(over: { held?: () => boolean; listing?: () => Promise<unknown> } = {}) {
    let now = at('2026-10-09T20:00:00Z');
    const batch = { listCronJobForAllNamespaces: vi.fn(async () => ({ items: [] })) };
    const listMailBackups = vi.fn(over.listing ?? (async () => reachable));
    const stop = startFreshnessSweep({
      db: leaseDb(over.held ?? (() => true)) as never,
      batch: batch as never,
      tickMs: 10,
      logger: { warn: () => {}, info: () => {} },
      listMailBackups: listMailBackups as never,
      now: () => now,
    });
    return { batch, listMailBackups, stop, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
  }
  const sweeps = (s: ReturnType<typeof start>) => s.batch.listCronJobForAllNamespaces.mock.calls.length;

  it('a replica without the lease neither sweeps nor lists the mail repository', async () => {
    const s = start({ held: () => false });
    try {
      await new Promise((r) => setTimeout(r, 80));
      expect(sweeps(s)).toBe(0);
      expect(s.listMailBackups).not.toHaveBeenCalled();
    } finally { s.stop(); }
  });

  it('the holder sweeps every tick but lists the mail repository once, then again when the next check is due', async () => {
    const s = start();
    try {
      await vi.waitFor(() => expect(sweeps(s)).toBeGreaterThanOrEqual(4));
      expect(s.listMailBackups).toHaveBeenCalledTimes(1);
      s.advance(HOUR);
      const before = sweeps(s);
      await vi.waitFor(() => expect(sweeps(s)).toBeGreaterThanOrEqual(before + 3));
      expect(s.listMailBackups).toHaveBeenCalledTimes(2);
    } finally { s.stop(); }
  });

  it('a sweep still waiting on a slow listing is not joined by the next tick', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => { release = r; });
    const s = start({ listing: async () => { await slow; return reachable; } });
    try {
      await vi.waitFor(() => expect(s.listMailBackups).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 80)); // eight more ticks come due meanwhile
      expect(sweeps(s)).toBe(1);
      expect(s.listMailBackups).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(sweeps(s)).toBeGreaterThanOrEqual(3));
      expect(s.listMailBackups).toHaveBeenCalledTimes(1);
    } finally { release(); s.stop(); }
  });

  it('the composition root hands the sweep the mail snapshot schedule (without it the check is only hourly)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const app = readFileSync(join(import.meta.dirname, '..', '..', 'app.ts'), 'utf8');
    expect(app).toMatch(/startFreshnessSweep\(\{[\s\S]{0,1500}?mailSchedule:\s*async/);
  });

  it('a check without a verdict (listing threw, target still being set up) is asked again on the next tick', async () => {
    for (const listing of [
      async () => { throw new Error('apiserver unavailable'); },
      async () => ({ ...reachable, repoReachable: false, unreachableCause: 'provisioning' }),
    ]) {
      const s = start({ listing });
      try {
        await vi.waitFor(() => expect(s.listMailBackups.mock.calls.length).toBeGreaterThanOrEqual(3));
      } finally { s.stop(); }
    }
  });
});
