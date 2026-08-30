/**
 * The single threshold policy behind every usage bar.
 *
 * The bug this locks down: a tenant using 6 GB of a 10 GB plan saw an orange
 * "warning" bar at 60% on the dashboard and in the metrics modal, while the
 * Resource Usage page showed the same number as normal. The dashboard's colour
 * was not even a threshold — it was passed in per metric, so storage rendered
 * amber at any value.
 */
import { describe, it, expect } from 'vitest';
import {
  resourceRatio,
  resourceStatus,
  resourceBarColor,
  resourcePercent,
  formatCpu,
  formatGiB,
  RESOURCE_WARNING_RATIO,
  RESOURCE_CRITICAL_RATIO,
} from '@/lib/resource-usage';

describe('resourceStatus thresholds', () => {
  it('treats 60% of plan as normal, not a warning', () => {
    // The exact case the operator reported.
    expect(resourceStatus(resourceRatio(6, 10))).toBe('ok');
    expect(resourceBarColor(resourceRatio(6, 10))).toContain('brand');
    expect(resourceBarColor(resourceRatio(6, 10))).not.toContain('amber');
  });

  it('warns only from 80% of the plan limit', () => {
    expect(resourceStatus(0.79)).toBe('ok');
    expect(resourceStatus(RESOURCE_WARNING_RATIO)).toBe('warning');
    expect(resourceBarColor(0.85)).toContain('amber');
  });

  it('goes critical at the plan limit and beyond', () => {
    expect(resourceStatus(0.99)).toBe('warning');
    expect(resourceStatus(RESOURCE_CRITICAL_RATIO)).toBe('critical');
    expect(resourceStatus(3)).toBe('critical');
    expect(resourceBarColor(1)).toContain('red');
  });
});

describe('resourceRatio guards', () => {
  it('returns 0 for an unknown or zero limit instead of Infinity', () => {
    // x / 0 = Infinity would render every unknown-limit tile as critical red.
    expect(resourceRatio(5, 0)).toBe(0);
    expect(resourceStatus(resourceRatio(5, 0))).toBe('ok');
    expect(resourceRatio(5, Number.NaN)).toBe(0);
    expect(resourceRatio(Number.NaN, 10)).toBe(0);
    expect(resourceRatio(5, -1)).toBe(0);
  });
});

describe('resourcePercent', () => {
  it('clamps to [0, 100] so a bar cannot overflow its track', () => {
    expect(resourcePercent(5, 10)).toBe(50);
    expect(resourcePercent(30, 10)).toBe(100);
    expect(resourcePercent(-5, 10)).toBe(0);
    expect(resourcePercent(1, 0)).toBe(0);
  });
});

describe('shared formatters', () => {
  it('formats CPU with precision that shrinks as the number grows', () => {
    expect(formatCpu(0.25)).toBe('0.25');
    expect(formatCpu(1.5)).toBe('1.5');
    expect(formatCpu(12)).toBe('12');
  });

  it('formats sub-GiB values in MiB', () => {
    expect(formatGiB(0)).toBe('0');
    expect(formatGiB(0.5)).toBe('512 Mi');
    expect(formatGiB(0.05)).toBe('51.2 Mi');
    expect(formatGiB(6.03)).toBe('6.0');
    expect(formatGiB(99.9)).toBe('100');
  });
});
