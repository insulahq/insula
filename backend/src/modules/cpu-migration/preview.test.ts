import { describe, it, expect } from 'vitest';
import { customSpecPinsCpu } from './preview.js';
import { deriveTier } from './tiers.js';
import { cpuToMillis } from '../dashboard/cpu-reservation.js';

describe('customSpecPinsCpu', () => {
  // ADR-036: a bring-your-own image that pins its own CPU has the operator's
  // numbers in it. A tier would overwrite a deliberate decision.
  it('detects a services array that pins cpuRequest', () => {
    expect(customSpecPinsCpu({ services: [{ resources: { cpuRequest: '500m' } }] })).toBe(true);
  });

  it('detects a services MAP that pins cpu', () => {
    expect(customSpecPinsCpu({ services: { web: { resources: { cpu: '0.5' } } } })).toBe(true);
  });

  it('is false when the spec leaves sizing to the platform', () => {
    expect(customSpecPinsCpu({ services: [{ image: 'nginx' }] })).toBe(false);
    expect(customSpecPinsCpu({ services: [{ resources: { memory: '256Mi' } }] })).toBe(false);
  });

  // A catalog deployment has custom_spec NULL. Throwing here would take the
  // whole report down over the ordinary case.
  it('survives null, undefined and a non-object', () => {
    expect(customSpecPinsCpu(null)).toBe(false);
    expect(customSpecPinsCpu(undefined)).toBe(false);
    expect(customSpecPinsCpu('nonsense')).toBe(false);
    expect(customSpecPinsCpu({})).toBe(false);
  });
});



describe('cpu_request parsing', () => {
  /**
   * Production stores SIX spellings of the same field across 37 rows:
   * "0.10", "0.1", "0.25", "0.2", "0.50" and "100m". A parser that handled
   * only the decimal form would read 100m as 100 CORES and report a tenant
   * reserving a thousand times what it does — and the report is the thing an
   * operator is being asked to trust before migrating.
   */
  it.each([
    ['0.10', 100], ['0.1', 100], ['0.25', 250],
    ['0.2', 200], ['0.50', 500], ['100m', 100],
  ])('%s -> %sm', (input, want) => {
    expect(cpuToMillis(input as string)).toBe(want);
  });

  it('treats an absent request as zero rather than NaN', () => {
    expect(cpuToMillis(undefined)).toBe(0);
    expect(cpuToMillis('')).toBe(0);
  });
});
