import { describe, it, expect } from 'vitest';
import {
  decimateMinMax, findSpikes, measuredRuns, niceTicks, paintOrder,
} from './chart-scale';

describe('niceTicks', () => {
  it('steps on 1 / 2 / 2.5 / 5 × 10^k, never on quarters of an odd ceiling', () => {
    // The old axis split a "nice" 7.5×10^k ceiling into quarters and
    // labelled gridlines 1.875, 3.75, 5.625 — numbers nobody writes.
    for (const max of [0.7, 3, 7.3, 13, 99, 434_000, 1_688_900, 5_000_000]) {
      const { ticks } = niceTicks(max);
      const step = ticks[1] - ticks[0];
      const mantissa = step / 10 ** Math.floor(Math.log10(step));
      expect([1, 2, 2.5, 5]).toContainEqual(Number(mantissa.toFixed(6)));
    }
  });

  it('starts at zero, ends at a ceiling above the peak, and stays close to it', () => {
    const { ticks, ceiling } = niceTicks(434_000);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(ceiling);
    expect(ceiling).toBeGreaterThan(434_000);
    // A 434 kB/s peak on a 600 kB/s axis wastes a third of the plot.
    expect(ceiling).toBeLessThanOrEqual(500_000);
  });

  it('honours a smaller tick budget for short plots', () => {
    expect(niceTicks(434_000, 2).ticks.length).toBeLessThanOrEqual(3);
  });

  it('draws a usable axis for an all-zero or empty series', () => {
    expect(niceTicks(0)).toEqual({ ticks: [0, 1], ceiling: 1 });
    expect(niceTicks(Number.NaN)).toEqual({ ticks: [0, 1], ceiling: 1 });
  });

  it('does not accumulate floating-point drift in labels', () => {
    for (const t of niceTicks(0.7).ticks) expect(String(t)).not.toMatch(/0000|9999/);
  });
});

describe('paintOrder', () => {
  const s = (key: string, points: Array<number | null>, emphasis?: 'total') => ({ key, points, emphasis });

  it('paints the lowest-traffic series first, so the highest ends up on top', () => {
    const order = paintOrder([s('big', [900, 900]), s('small', [5, 5]), s('mid', [50, null])], null);
    expect(order).toEqual(['small', 'mid', 'big']);
  });

  it('always paints the total last', () => {
    const order = paintOrder([s('total', [10, 10], 'total'), s('big', [900, 900]), s('small', [5, 5])], null);
    expect(order[order.length - 1]).toBe('total');
  });

  it('lifts the focused series above everything, the total included', () => {
    const order = paintOrder([s('total', [10, 10], 'total'), s('big', [900, 900]), s('small', [5, 5])], 'small');
    expect(order[order.length - 1]).toBe('small');
  });

  it('keeps the original order between equal volumes', () => {
    expect(paintOrder([s('a', [1]), s('b', [1])], null)).toEqual(['a', 'b']);
  });
});

describe('measuredRuns', () => {
  it('splits at gaps, so an unmeasured interval is never drawn as zero', () => {
    expect(measuredRuns([1, 2, null, null, 3, null, 4, 5])).toEqual([[0, 1], [4], [6, 7]]);
  });
});

describe('findSpikes', () => {
  it('flags a point well above the mean and ignores the edges', () => {
    const flat = Array.from({ length: 40 }, () => 10);
    flat[20] = 500;
    flat[0] = 500;
    expect(findSpikes(flat)).toEqual([20]);
  });
});

describe('decimateMinMax', () => {
  it('keeps a one-point spike that every-Nth-point sampling drops', () => {
    // 240 points, one spike at an index that `i % 4 === 0` sampling skips.
    const points: Array<number | null> = Array.from({ length: 240 }, () => 1);
    points[121] = 500;
    const out = decimateMinMax(points, 60);
    expect(Math.max(...out.map((p) => p.v ?? 0))).toBe(500);
    expect(out.find((p) => p.v === 500)?.i).toBe(121);
  });

  it('returns points in time order with their original index', () => {
    const points = [3, 9, 1, 7, 2, 8, 4, 6];
    const out = decimateMinMax(points, 2);
    const idx = out.map((p) => p.i);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    for (const p of out) expect(points[p.i]).toBe(p.v);
  });

  it('marks an all-null bucket as a gap', () => {
    const points = [1, 2, null, null, 3, 4];
    const out = decimateMinMax(points, 3);
    expect(out.some((p) => p.v === null)).toBe(true);
  });

  it('passes short series through untouched', () => {
    expect(decimateMinMax([1, null, 3], 60)).toEqual([
      { i: 0, v: 1 }, { i: 1, v: null }, { i: 2, v: 3 },
    ]);
  });
});
