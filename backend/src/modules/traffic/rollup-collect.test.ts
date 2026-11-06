import { describe, it, expect } from 'vitest';
import type { TrafficFrame } from '@insula/api-contracts';
import { hourlyValues, identityFor, measuredHours, rollupAsks } from './rollup-collect.js';
import { MONTH_STEP_SECONDS, periodEnd, periodFor, periodTimeline } from './rollup-period.js';

const H = 3_600_000;
const T0 = Date.parse('2031-03-10T00:00:00Z');

function frame(points: Array<number | null>, stepSeconds = 300, from = T0): TrafficFrame {
  return {
    from: new Date(from).toISOString(), to: new Date(from + points.length * stepSeconds * 1000).toISOString(),
    stepSeconds,
    times: points.map((_, i) => new Date(from + i * stepSeconds * 1000).toISOString()),
    unit: 'bytes', resolution: 'fine', othersFolded: 0, clamped: false,
    series: [{ key: 'out:n1', name: 'Node one', kind: 'subject', points }],
  };
}

describe('hourlyValues', () => {
  it('gives each point to the hour its step ran in, and the point AT the start to the span before', () => {
    // Points at T0, T0+5m … T0+60m: the first is the previous span's last step,
    // the twelve after it are exactly the hour T0..T0+1h.
    const pts = Array.from({ length: 14 }, () => 10);
    const v = hourlyValues(frame(pts), T0, 'traffic').get('out:n1');
    expect([...(v ?? new Map()).keys()]).toEqual([T0, T0 + H]);
    expect(v?.get(T0)).toEqual({ sum: 10 * 300 * 12, n: 12 });
    expect(v?.get(T0 + H)).toEqual({ sum: 10 * 300, n: 1 });
  });

  it('skips unmeasured points rather than counting them as zero', () => {
    const v = hourlyValues(frame([1, null, null, 5]), T0, 'traffic').get('out:n1');
    expect(v?.get(T0)).toEqual({ sum: 5 * 300, n: 1 });
  });

  it('averages latency instead of integrating it', () => {
    const v = hourlyValues(frame([0, 20, 40]), T0, 'latency').get('out:n1');
    expect(v?.get(T0)).toEqual({ sum: 60, n: 2 });
  });
});

describe('measuredHours', () => {
  it('is the hours any series has a value in — an hour the store could not answer is not measured', () => {
    const f = frame([1, ...Array.from({ length: 12 }, () => null), 3]);
    expect([...measuredHours(f, T0)]).toEqual([T0 + H]);
  });
});

describe('identityFor', () => {
  const s = (key: string, name: string) => ({ key, name, kind: 'subject' as const, points: [] });

  it('keys a breakdown row by direction and subject, and keeps the subject to filter on', () => {
    expect(identityFor({ scope: 'route', metric: 'traffic', direction: 'in' }, s('in:tenant-a-fixture-web', 'web.example.test')))
      .toMatchObject({ seriesKey: 'in:tenant-a-fixture-web', subject: 'tenant-a-fixture-web', ref: 'tenant-a-fixture-web', namespace: null });
  });

  it('keys a pod row by its tenant and application, as the live frame folds every replica into one', () => {
    // The live frame keys the folded row by the application's name.
    const id = identityFor({ scope: 'pod', metric: 'traffic', direction: 'out', subject: 'tenant-example-0a1b2c3d' },
      s('website', 'website'));
    expect(id).toMatchObject({
      seriesKey: 'out:tenant-example-0a1b2c3d/website', subject: 'website',
      namespace: 'tenant-example-0a1b2c3d', ref: 'website',
    });
  });

  it('keeps a cluster row exactly as the live frame keys and groups it', () => {
    const id = identityFor({ scope: 'cluster', metric: 'traffic', direction: 'out' },
      { key: 'wire:n2n', name: 'Node-to-node', kind: 'direction', group: 'wire', points: [] });
    expect(id).toMatchObject({ seriesKey: 'wire:n2n', grp: 'wire', kind: 'direction', subject: null });
  });
});

describe('rollupAsks', () => {
  const asks = rollupAsks(['tenant-a-fixture', 'tenant-b-fixture']);

  it('covers every view in both directions, and every tenant’s pods', () => {
    for (const scope of ['cluster', 'node', 'route'] as const) {
      expect(asks.filter((a) => a.scope === scope && a.metric === 'traffic').map((a) => a.direction)).toEqual(['out', 'in']);
    }
    // A tenant's traffic past 30 days is the meter's billed egress, kept already.
    expect(asks.filter((a) => a.scope === 'tenant' && a.metric === 'traffic')).toEqual([]);
    expect(asks.filter((a) => a.scope === 'pod').map((a) => `${a.subject}:${a.direction}`))
      .toEqual(['tenant-a-fixture:out', 'tenant-a-fixture:in', 'tenant-b-fixture:out', 'tenant-b-fixture:in']);
  });

  it('asks for requests before latency in each view, so latency can be weighted by them', () => {
    for (const scope of ['cluster', 'node', 'tenant', 'route'] as const) {
      const i = asks.findIndex((a) => a.scope === scope && a.metric === 'requests');
      const j = asks.findIndex((a) => a.scope === scope && a.metric === 'latency');
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(j);
    }
  });
});

describe('rollup periods', () => {
  const now = new Date('2031-05-15T12:30:00Z');
  const yearAgo = now.getTime() - 365 * 86_400_000;

  it('draws a range within a year by day, and one reaching further back by month', () => {
    expect(periodFor(new Date(yearAgo), now)).toBe('daily');
    expect(periodFor(new Date(yearAgo - 3_600_000), now)).toBe('daily');
    expect(periodFor(new Date(yearAgo - 3_600_001), now)).toBe('monthly');
  });

  it('lists whole UTC months, leaving out a partial first one', () => {
    const t = periodTimeline('monthly', Date.parse('2030-11-20T00:00:00Z'), Date.parse('2031-02-10T00:00:00Z'));
    expect(t.map((x) => new Date(x).toISOString().slice(0, 10))).toEqual(['2030-12-01', '2031-01-01', '2031-02-01']);
  });

  it('ends a December in January', () => {
    expect(new Date(periodEnd('monthly', Date.parse('2030-12-01T00:00:00Z'))).toISOString()).toBe('2031-01-01T00:00:00.000Z');
  });

  it('steps a month by the mean month, so a month’s bytes add back up exactly', () => {
    expect(MONTH_STEP_SECONDS).toBe(Math.round(365.2425 * 86_400 / 12));
  });
});
