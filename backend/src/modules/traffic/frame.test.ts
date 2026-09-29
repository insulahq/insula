import { describe, it, expect } from 'vitest';
import {
  alignToTimeline, buildTimeline, chooseStepSeconds, foldTail, integrate, meanOf, rankValue,
} from './frame.js';
import { TRAFFIC_MAX_POINTS, TRAFFIC_TOP_N } from '@insula/api-contracts';

const HOUR = 3_600_000;

describe('chooseStepSeconds', () => {
  it('keeps every range under the point cap', () => {
    for (const hours of [1, 6, 24, 24 * 7, 24 * 30, 24 * 365]) {
      const to = Date.UTC(2026, 8, 29, 12);
      const step = chooseStepSeconds(to - hours * HOUR, to);
      expect(Math.ceil((hours * 3600) / step), `${hours}h`).toBeLessThanOrEqual(TRAFFIC_MAX_POINTS);
    }
  });

  it('picks the finest step that fits, not the coarsest', () => {
    const to = Date.UTC(2026, 8, 29, 12);
    expect(chooseStepSeconds(to - 6 * HOUR, to)).toBe(60);
    expect(chooseStepSeconds(to - 24 * HOUR, to)).toBe(300);
  });
});

describe('buildTimeline', () => {
  it('lands on clock boundaries so two charts line up', () => {
    const from = Date.UTC(2026, 8, 29, 11, 43, 17);
    const times = buildTimeline(from, from + 2 * HOUR, 300);
    for (const t of times) expect(t % 300_000).toBe(0);
  });

  it('never exceeds the cap even for an absurd range', () => {
    const from = Date.UTC(2020, 0, 1);
    expect(buildTimeline(from, from + 4000 * 24 * HOUR, 60).length).toBeLessThanOrEqual(TRAFFIC_MAX_POINTS + 1);
  });
});

describe('alignToTimeline', () => {
  const timeline = [1_000_000_000_000, 1_000_000_300_000, 1_000_000_600_000];

  it('places samples on their own bucket', () => {
    const pts = timeline.map((t, i) => [t / 1000, (i + 1) * 10] as const);
    expect(alignToTimeline(pts, timeline, 300)).toEqual([10, 20, 30]);
  });

  it('reports an unmeasured bucket as null, NOT as zero', () => {
    // Zero draws a confident line along the axis and reads as "nothing
    // happened"; the truth is "nothing is known".
    const pts = [[timeline[0] / 1000, 5] as const];
    expect(alignToTimeline(pts, timeline, 300)).toEqual([5, null, null]);
  });

  it('tolerates a sample landing a few seconds off its bucket', () => {
    const pts = [[timeline[1] / 1000 + 7, 42] as const];
    expect(alignToTimeline(pts, timeline, 300)[1]).toBe(42);
  });

  it('ignores a NaN sample rather than charting it', () => {
    const pts = [[timeline[0] / 1000, Number.NaN] as const];
    expect(alignToTimeline(pts, timeline, 300)[0]).toBeNull();
  });
});

describe('integrate and mean skip gaps', () => {
  it('integrates a rate into a total over the step', () => {
    expect(integrate([1, 1, 1], 300)).toBe(900);
  });
  it('does not count a gap as zero in the mean', () => {
    expect(meanOf([10, null, 30])).toBe(20);
  });
  it('returns null when nothing at all was measured', () => {
    expect(meanOf([null, null])).toBeNull();
  });
});

describe('foldTail', () => {
  const mk = (key: string, v: number) => ({ key, name: key, points: [v, v, v] });

  it('keeps the top N and folds the rest into one row', () => {
    const input = [mk('a', 1), mk('b', 9), mk('c', 5), mk('d', 3), mk('e', 7), mk('f', 2)];
    const { series, othersFolded } = foldTail(input, 'bytes', 60);
    expect(series).toHaveLength(TRAFFIC_TOP_N + 1);
    expect(series.slice(0, TRAFFIC_TOP_N).map((s) => s.key)).toEqual(['b', 'e', 'c', 'd']);
    expect(series[TRAFFIC_TOP_N].key).toBe('__other__');
    expect(othersFolded).toBe(2);
    // Other = the tail summed, not dropped
    expect(series[TRAFFIC_TOP_N].points[0]).toBe(3);
  });

  it('adds nothing when there is no tail', () => {
    const { series, othersFolded } = foldTail([mk('a', 1), mk('b', 2)], 'bytes', 60);
    expect(series.map((s) => s.key)).toEqual(['b', 'a']);
    expect(othersFolded).toBe(0);
  });

  it('never invents an "Other" latency', () => {
    // "the other 30 services averaged 91 ms" is a fact about no service.
    const input = Array.from({ length: 9 }, (_, i) => mk(`s${i}`, i + 1));
    const { series, othersFolded } = foldTail(input, 'milliseconds', 60);
    expect(series.some((s) => s.key === '__other__')).toBe(false);
    expect(series).toHaveLength(TRAFFIC_TOP_N);
    expect(othersFolded).toBe(5); // still counted, so the UI can say so
  });

  it('ranks latency by mean and traffic by total', () => {
    const spiky = { key: 'spiky', name: 'spiky', points: [0, 0, 300] };
    const steady = { key: 'steady', name: 'steady', points: [40, 40, 40] };
    expect(rankValue(spiky.points, 'milliseconds', 60)).toBe(100);
    expect(rankValue(steady.points, 'milliseconds', 60)).toBe(40);
    expect(rankValue(spiky.points, 'bytes', 60)).toBe(18_000);
    expect(rankValue(steady.points, 'bytes', 60)).toBe(7_200);
  });

  it('folds a gap-only tail to null rather than zero', () => {
    const input = [mk('a', 5), mk('b', 4), mk('c', 3), mk('d', 2),
      { key: 'e', name: 'e', points: [null, null, null] as Array<number | null> }];
    const { series } = foldTail(input, 'bytes', 60);
    expect(series[TRAFFIC_TOP_N].points).toEqual([null, null, null]);
  });
});

describe('alignToTimeline never hands one sample to two buckets', () => {
  it('places a midpoint sample in exactly one bucket', () => {
    // Symmetric half-step windows overlap at the midpoint, so both
    // neighbouring buckets claimed the same measurement and integrate()
    // counted it twice.
    const step = 300;
    const t0 = 1_000_000_000;
    const timeline = [t0 * 1000, (t0 + step) * 1000];
    const midpoint = t0 + step / 2;
    const aligned = alignToTimeline([[midpoint, 99]], timeline, step);
    expect(aligned.filter((v) => v === 99)).toHaveLength(1);
  });

  it('holds at the daily step, where the window is twelve hours each side', () => {
    const step = 86_400;
    const t0 = 1_700_000_000 - (1_700_000_000 % step);
    const timeline = [t0 * 1000, (t0 + step) * 1000];
    const aligned = alignToTimeline([[t0 + step / 2, 7]], timeline, step);
    expect(aligned.filter((v) => v === 7)).toHaveLength(1);
  });

  it('does not inflate the total when a sample sits on a boundary', () => {
    const step = 600;
    const t0 = 1_000_000_200;
    const timeline = [t0 * 1000, (t0 + step) * 1000, (t0 + 2 * step) * 1000];
    const aligned = alignToTimeline([[t0 + step / 2, 10]], timeline, step);
    expect(integrate(aligned, step)).toBe(10 * step);
  });
});

describe('alignToTimeline edges the half-open window got wrong', () => {
  it('keeps a drifted sample in the LAST bucket, which has no neighbour', () => {
    // A per-bucket search that excluded its forward edge relied on the next
    // bucket catching it; the last bucket has no next, so the sample vanished.
    const step = 300; const t0 = 1_000_000_000;
    expect(alignToTimeline([[t0 + 149, 42]], [t0 * 1000], step)).toEqual([42]);
    expect(alignToTimeline([[t0 - 149, 42]], [t0 * 1000], step)).toEqual([42]);
  });

  it('treats exactly half a step PAST the last bucket as the next frame', () => {
    // Nearest-bucket with ties going later: `to + step/2` rounds to a bucket
    // this frame does not contain. Pulling it back would show the reader data
    // from beyond the window they asked for, so it is dropped — the frame's
    // coverage ends halfway past its last point.
    const step = 300; const t0 = 1_000_000_000;
    expect(alignToTimeline([[t0 + step / 2, 42]], [t0 * 1000], step)).toEqual([null]);
    // …and the same instant IS kept once a bucket exists there.
    expect(alignToTimeline([[t0 + step / 2, 42]], [t0 * 1000, (t0 + step) * 1000], step))
      .toEqual([null, 42]);
  });

  it('keeps a boundary sample when the step is ODD', () => {
    // With step 301 the neighbour's backward reach is 151 but its window is
    // 150, so a sample at +150 belonged to neither bucket.
    const step = 301; const t0 = 1_000_000_000;
    const timeline = [t0 * 1000, (t0 + step) * 1000, (t0 + 2 * step) * 1000];
    const aligned = alignToTimeline([[t0 + 150, 42]], timeline, step);
    expect(aligned.filter((v) => v === 42)).toHaveLength(1);
  });

  it('still refuses to put one sample in two buckets', () => {
    for (const step of [60, 300, 301, 86_400]) {
      const t0 = 1_000_000_000;
      const timeline = [t0 * 1000, (t0 + step) * 1000];
      const aligned = alignToTimeline([[t0 + step / 2, 7]], timeline, step);
      expect(aligned.filter((v) => v === 7), `step ${step}`).toHaveLength(1);
    }
  });

  it('gives a bucket the CLOSER of two competing samples, whatever the order', () => {
    const step = 300; const t0 = 1_000_000_000;
    const near: [number, number] = [t0 + 10, 1];
    const far: [number, number] = [t0 - 120, 2];
    expect(alignToTimeline([near, far], [t0 * 1000], step)).toEqual([1]);
    expect(alignToTimeline([far, near], [t0 * 1000], step)).toEqual([1]);
  });

  it('ignores a sample that belongs to no bucket at all', () => {
    const step = 300; const t0 = 1_000_000_000;
    const timeline = [t0 * 1000, (t0 + step) * 1000];
    expect(alignToTimeline([[t0 - 10 * step, 9], [t0 + 10 * step, 9]], timeline, step))
      .toEqual([null, null]);
  });

  it('survives an empty timeline without throwing', () => {
    expect(alignToTimeline([[1, 1]], [], 300)).toEqual([]);
  });
});
