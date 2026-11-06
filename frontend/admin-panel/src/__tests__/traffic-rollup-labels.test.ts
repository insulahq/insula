import { describe, it, expect } from 'vitest';
import { rollupFor } from '@/components/traffic/TrafficRangePicker';
import { stepLabel } from '@/components/traffic/TrafficChart';

describe('which rollup the picker says will draw a range', () => {
  const now = new Date('2031-05-15T12:30:00Z');
  const back = (days: number, extraMs = 0) => new Date(now.getTime() - days * 86_400_000 - extraMs);

  it('says nothing while the metrics store still has the range — "Last 30 days" included', () => {
    expect(rollupFor(back(30, 50), now)).toBeNull();
    expect(rollupFor(back(7), now)).toBeNull();
  });

  it('says daily past 30 days and monthly past a year, as the server decides', () => {
    expect(rollupFor(back(90), now)).toBe('daily');
    expect(rollupFor(back(365, 50), now)).toBe('daily');
    expect(rollupFor(back(400), now)).toBe('monthly');
  });

  it('goes by how far back a range starts, not how long it is: last year’s January is monthly', () => {
    expect(rollupFor(new Date('2030-01-01T00:00:00Z'), now)).toBe('monthly');
  });
});

describe('the steps pill', () => {
  it('names a monthly step a month, though it is no whole number of days', () => {
    expect(stepLabel(2_629_746)).toBe('1-month steps');
    expect(stepLabel(86_400)).toBe('1-day steps');
    expect(stepLabel(3_600)).toBe('1-hour steps');
  });
});
