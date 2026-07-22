import { describe, it, expect } from 'vitest';
import { summarizeBandwidth } from './service.js';

describe('summarizeBandwidth', () => {
  it('uses the per-tenant override when set (source=override)', () => {
    const s = summarizeBandwidth({ usedGb: 125, override: 250, planLimit: 100, capped: false, cycleStart: null });
    expect(s.limitGb).toBe(250);
    expect(s.source).toBe('override');
    expect(s.usedPct).toBe(50);
  });

  it('falls back to the plan limit (source=plan)', () => {
    const s = summarizeBandwidth({ usedGb: 40, override: null, planLimit: 100, capped: false, cycleStart: null });
    expect(s.limitGb).toBe(100);
    expect(s.source).toBe('plan');
    expect(s.usedPct).toBe(40);
  });

  it('falls back to the 100 GB default (source=default)', () => {
    const s = summarizeBandwidth({ usedGb: 10, override: null, planLimit: null, capped: false, cycleStart: null });
    expect(s.limitGb).toBe(100);
    expect(s.source).toBe('default');
  });

  it('reports capped state and can exceed 100%', () => {
    const s = summarizeBandwidth({ usedGb: 110, override: null, planLimit: 100, capped: true, cycleStart: null });
    expect(s.capped).toBe(true);
    expect(s.usedPct).toBe(110);
  });

  it('serializes cycleStart to ISO', () => {
    const s = summarizeBandwidth({ usedGb: 1, override: null, planLimit: 100, capped: false, cycleStart: new Date('2026-07-01T00:00:00Z') });
    expect(s.cycleStart).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rounds usedGb to 3 dp and usedPct to 1 dp', () => {
    const s = summarizeBandwidth({ usedGb: 33.33333, override: null, planLimit: 100, capped: false, cycleStart: null });
    expect(s.usedGb).toBe(33.333);
    expect(s.usedPct).toBe(33.3);
  });
});
