import { describe, expect, it } from 'vitest';
import { MIN_WAVE_ALLOWANCE_MS, judgedRun, runsAtOrBefore, waveAllowanceMs } from './wave.js';

const H = 3_600_000;
const at = (iso: string) => new Date(iso);

describe('runsAtOrBefore', () => {
  it('lists the schedule\'s fires, newest first', () => {
    expect(runsAtOrBefore('30 1 * * *', 'UTC', at('2026-11-26T12:00:00Z'), 2))
      .toEqual([at('2026-11-26T01:30:00Z'), at('2026-11-25T01:30:00Z')]);
  });

  it('reads them in the platform time zone, across a daylight-saving change', () => {
    // 01:30 Berlin is 23:30 UTC in winter and 23:30 the day before in summer
    // time; the autumn change falls between these two runs.
    expect(runsAtOrBefore('30 1 * * *', 'Europe/Berlin', at('2026-10-26T12:00:00Z'), 2))
      .toEqual([at('2026-10-26T00:30:00Z'), at('2026-10-24T23:30:00Z')]);
  });

  it('finds a monthly run up to two months back, and nothing for a schedule that never fires', () => {
    expect(runsAtOrBefore('0 3 1 * *', 'UTC', at('2026-11-25T12:00:00Z'), 1)).toEqual([at('2026-11-01T03:00:00Z')]);
    expect(runsAtOrBefore('0 0 30 2 *', 'UTC', at('2026-11-25T12:00:00Z'), 1)).toEqual([]);
  });
});

describe('waveAllowanceMs', () => {
  it('is the last completed wave plus an hour, never under two hours', () => {
    expect(waveAllowanceMs(null)).toBe(MIN_WAVE_ALLOWANCE_MS);
    expect(waveAllowanceMs(20 * 60_000)).toBe(MIN_WAVE_ALLOWANCE_MS);
    expect(waveAllowanceMs(3 * H)).toBe(4 * H);
    expect(waveAllowanceMs(-5)).toBe(MIN_WAVE_ALLOWANCE_MS);
  });
});

describe('judgedRun', () => {
  const daily = '0 2 * * *';

  it('is the latest run that has had its allowance to finish', () => {
    // 03:30 with a 2 h allowance: tonight's 02:00 run is not judged yet.
    expect(judgedRun(daily, 'UTC', at('2026-11-26T03:30:00Z'), 2 * H)).toEqual(at('2026-11-25T02:00:00Z'));
    expect(judgedRun(daily, 'UTC', at('2026-11-26T04:00:00Z'), 2 * H)).toEqual(at('2026-11-26T02:00:00Z'));
  });

  it('a long wave moves the judgement later', () => {
    expect(judgedRun(daily, 'UTC', at('2026-11-26T05:00:00Z'), 4 * H)).toEqual(at('2026-11-25T02:00:00Z'));
  });

  it('never judges a run whose wave is still in progress', () => {
    expect(judgedRun(daily, 'UTC', at('2026-11-26T09:00:00Z'), 2 * H, at('2026-11-26T02:00:00Z')))
      .toEqual(at('2026-11-25T02:00:00Z'));
  });

  it('never judges a run the scheduler did not fire', () => {
    // Enabled at 10:00 today: this morning's 02:00 never ran, nor did any before it.
    expect(judgedRun(daily, 'UTC', at('2026-11-26T10:00:00Z'), 2 * H, null, null)).toBeNull();
    // Last fired yesterday, then switched off: yesterday's run is the one judged.
    expect(judgedRun(daily, 'UTC', at('2026-11-26T10:00:00Z'), 2 * H, null, at('2026-11-25T02:00:00Z')))
      .toEqual(at('2026-11-25T02:00:00Z'));
    expect(judgedRun(daily, 'UTC', at('2026-11-26T10:00:00Z'), 2 * H, null, at('2026-11-26T02:00:00Z')))
      .toEqual(at('2026-11-26T02:00:00Z'));
  });

  it('has nothing to judge without a schedule', () => {
    expect(judgedRun(null, 'UTC', at('2026-11-26T09:00:00Z'), 2 * H)).toBeNull();
    expect(judgedRun('', 'UTC', at('2026-11-26T09:00:00Z'), 2 * H)).toBeNull();
    expect(judgedRun('not a cron', 'UTC', at('2026-11-26T09:00:00Z'), 2 * H)).toBeNull();
  });

  it('a tenant done first one night and last the next is never overdue in between', () => {
    // Wave of 3 h: allowance 4 h. Good backups 02:01 one night and 04:58 the
    // next are 27 hours apart; at every instant some good backup is at or
    // after the judged run.
    const goodBackups = [at('2026-11-24T02:01:00Z'), at('2026-11-25T04:58:00Z')];
    for (let t = at('2026-11-25T02:00:00Z').getTime(); t <= at('2026-11-26T01:59:00Z').getTime(); t += 15 * 60_000) {
      const judged = judgedRun(daily, 'UTC', new Date(t), 4 * H)!;
      const lastGood = goodBackups.filter((g) => g.getTime() <= t).at(-1)!;
      expect(lastGood.getTime() >= judged.getTime(), `at ${new Date(t).toISOString()}`).toBe(true);
    }
  });
});
