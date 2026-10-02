/**
 * Per-step durations of a mail migration (step_timings, migration 0143). A DR
 * failover of an almost-empty store took ~4.5 min on a VM drill and the only
 * per-step evidence was in platform-api logs, lost with the pod.
 */
import { describe, it, expect } from 'vitest';
import { stepDurations, summarizeStepDurations } from './migration.js';

const raw = [
  { step: 'preflight', at: '2026-10-02T15:55:40.000Z' },
  { step: 'scaling-down', at: '2026-10-02T15:55:41.500Z' },
  { step: 'swapping-pvc', at: '2026-10-02T15:57:12.000Z' },
  { step: 'scaling-up', at: '2026-10-02T15:57:20.000Z' },
  { step: 'done', at: '2026-10-02T15:58:00.000Z' },
];

describe('stepDurations', () => {
  it('each step lasts until the next one began; the closing entry has none', () => {
    expect(stepDurations(raw).map((t) => [t.step, t.seconds])).toEqual([
      ['preflight', 1.5], ['scaling-down', 90.5], ['swapping-pvc', 8], ['scaling-up', 40], ['done', null],
    ]);
  });

  it('a run still in flight: the current step runs until "end" (now)', () => {
    const live = stepDurations(raw.slice(0, 2), new Date('2026-10-02T15:56:00.000Z'));
    expect(live[1]).toMatchObject({ step: 'scaling-down', seconds: 18.5 });
  });

  it('a failed run closes with "failed"', () => {
    const t = stepDurations([...raw.slice(0, 2), { step: 'failed', at: '2026-10-02T15:56:00.000Z' }]);
    expect(t.at(-1)).toMatchObject({ step: 'failed', seconds: null });
    expect(t[1].seconds).toBe(18.5);
  });

  it('a run from before migration 0143 (NULL) or junk entries → empty, never a throw', () => {
    expect(stepDurations(null)).toEqual([]);
    expect(stepDurations([{ step: 1 }, 'x', { at: 'y' }])).toEqual([]);
  });
});

describe('summarizeStepDurations', () => {
  it('names every timed step for the completion log line', () => {
    expect(summarizeStepDurations(stepDurations(raw))).toBe('preflight 1.5s · scaling-down 90.5s · swapping-pvc 8s · scaling-up 40s');
  });
});
