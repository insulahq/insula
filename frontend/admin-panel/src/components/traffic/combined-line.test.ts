import { describe, it, expect } from 'vitest';
import type { TrafficFrame, TrafficSeries } from '@insula/api-contracts';
import {
  combinedLine, TOTAL_KEY, totalLabel, totalState, trafficStats,
} from './combined-line';

function frameOf(series: TrafficSeries[], unit: TrafficFrame['unit'] = 'bytes'): TrafficFrame {
  return {
    from: '2026-09-30T00:00:00.000Z',
    to: '2026-09-30T00:15:00.000Z',
    stepSeconds: 300,
    times: ['2026-09-30T00:00:00.000Z', '2026-09-30T00:05:00.000Z', '2026-09-30T00:10:00.000Z'],
    unit,
    resolution: 'fine',
    othersFolded: 0,
    clamped: false,
    series,
  };
}

describe('combinedLine', () => {
  it('sums a breakdown across subjects', () => {
    const f = frameOf([
      { key: 'a', name: 'A', kind: 'subject', points: [100, 200, 300] },
      { key: 'b', name: 'B', kind: 'subject', points: [1, 2, null] },
    ]);
    expect(combinedLine(f, new Set())).toEqual([101, 202, 300]);
  });

  it('leaves out what is hidden', () => {
    const f = frameOf([
      { key: 'a', name: 'A', kind: 'subject', points: [100, 200, 300] },
      { key: 'b', name: 'B', kind: 'subject', points: [1, 2, 3] },
    ]);
    expect(combinedLine(f, new Set(['a']))).toEqual([1, 2, 3]);
  });

  it('does not add a subset of the wire into the wire total it is already inside', () => {
    // Node-to-node traffic rides over the NIC, so it is already in the wire
    // figure. The tiles used to add it on top.
    const f = frameOf([
      { key: 'wire:out', name: 'Outbound (wire)', kind: 'direction', group: 'wire', points: [1000, 1000, 1000] },
      { key: 'n2n:out', name: 'Node-to-node (out)', kind: 'direction', group: 'wire-subset', points: [400, 400, 400] },
    ]);
    expect(combinedLine(f, new Set())).toEqual([1000, 1000, 1000]);
  });

  it('falls back to the subset when the wire row itself is hidden', () => {
    const f = frameOf([
      { key: 'wire:out', name: 'Outbound (wire)', kind: 'direction', group: 'wire', points: [1000, 1000, 1000] },
      { key: 'n2n:out', name: 'Node-to-node (out)', kind: 'direction', group: 'wire-subset', points: [400, 400, 400] },
    ]);
    expect(combinedLine(f, new Set(['wire:out']))).toEqual([400, 400, 400]);
  });

  it('averages latency rather than adding it up', () => {
    // Four services at 50 ms are not a 200 ms service.
    const f = frameOf([
      { key: 'a', name: 'A', kind: 'subject', points: [50, 50, null] },
      { key: 'b', name: 'B', kind: 'subject', points: [50, 150, 30] },
    ], 'milliseconds');
    expect(combinedLine(f, new Set())).toEqual([50, 100, 30]);
  });

  it('is null where nothing shown was measured', () => {
    const f = frameOf([{ key: 'a', name: 'A', kind: 'subject', points: [null, 5, null] }]);
    expect(combinedLine(f, new Set())).toEqual([null, 5, null]);
  });
});

describe('trafficStats', () => {
  it('reads peak, average and total off the combined line', () => {
    const f = frameOf([
      { key: 'a', name: 'A', kind: 'subject', points: [100, 300, null] },
      { key: 'b', name: 'B', kind: 'subject', points: [100, 100, null] },
    ]);
    const s = trafficStats(f, new Set());
    expect(s).not.toBeNull();
    expect(s!.peak).toBe(400);
    expect(s!.peakAt).toBe(f.times[1]);
    // Averaged over MEASURED instants only — the gap is not an hour of zero.
    expect(s!.avg).toBe(300);
    expect(s!.total).toBe((200 + 400) * 300);
  });

  it('is null when every series is hidden', () => {
    const f = frameOf([{ key: 'a', name: 'A', kind: 'subject', points: [1, 2, 3] }]);
    expect(trafficStats(f, new Set(['a']))).toBeNull();
  });
});

describe('totalState', () => {
  const two = frameOf([
    { key: 'a', name: 'A', kind: 'subject', points: [1, 2, 3] },
    { key: 'b', name: 'B', kind: 'subject', points: [1, 2, 3] },
  ]);

  it('is offered on a breakdown of two or more rows, and off until asked for', () => {
    expect(totalState(two, new Set([TOTAL_KEY]), true)).toEqual({ offered: true, usable: true, drawn: false });
    expect(totalState(two, new Set(), true)).toEqual({ offered: true, usable: true, drawn: true });
  });

  it('is not offered outside a breakdown — a cluster view, one direction pair', () => {
    expect(totalState(two, new Set(), false).offered).toBe(false);
  });

  it('is not offered for a single row: it would be that row again', () => {
    const one = frameOf([{ key: 'a', name: 'A', kind: 'subject', points: [1, 2, 3] }]);
    expect(totalState(one, new Set(), true)).toEqual({ offered: false, usable: false, drawn: false });
  });

  it('greys out, and is not drawn, while fewer than two rows are shown', () => {
    expect(totalState(two, new Set(['a']), true)).toEqual({ offered: true, usable: false, drawn: false });
  });
});

describe('totalLabel', () => {
  it('calls the combined latency line an average, since latencies do not add up', () => {
    expect(totalLabel('bytes')).toBe('Total');
    expect(totalLabel('requests')).toBe('Total');
    expect(totalLabel('milliseconds')).toBe('Average');
  });
});
