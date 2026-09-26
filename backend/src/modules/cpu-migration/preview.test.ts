import { describe, it, expect } from 'vitest';
import { customSpecPinsCpu, recommendedCores } from './preview.js';
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

describe('recommendedCores', () => {
  it('reads the manifest recommendation', () => {
    expect(recommendedCores({ recommended: { cpu: '0.50' } })).toBe(0.5);
  });

  // Silence must be distinguishable from zero: deriveTier sends null to
  // `high`, whereas 0 would fall into the `normal` band and starve the app.
  it('returns null when the manifest says nothing, never 0', () => {
    expect(recommendedCores(null)).toBeNull();
    expect(recommendedCores({})).toBeNull();
    expect(recommendedCores({ recommended: {} })).toBeNull();
    expect(recommendedCores({ recommended: { cpu: '' } })).toBeNull();
    expect(recommendedCores({ recommended: { cpu: 'abc' } })).toBeNull();
  });
});

describe('recommendedCores — millicore notation', () => {
  /**
   * Found in review. `Number('50m')` is NaN, so a bare parse returned null —
   * which deriveTier reads as "the manifest said nothing" and answers `high`.
   * A 50m entry (normal) would be forced six tiers up and a 2000m entry
   * (highest) forced down, silently and in both directions.
   *
   * No Official catalog entry uses the notation today, so this was latent
   * there — but catalog/service.ts:toCpuMilli parses exactly this field with
   * an 'm' suffix, and the community and third-party catalogs the tier model
   * supports are not ours to constrain.
   */
  it.each([
    ['50m', 0.05],
    ['250m', 0.25],
    ['2000m', 2],
  ])('parses %s as %s cores', (input, want) => {
    expect(recommendedCores({ recommended: { cpu: input } })).toBeCloseTo(want as number, 6);
  });

  it('tiers a millicore manifest the same as its decimal equivalent', () => {
    expect(deriveTier(recommendedCores({ recommended: { cpu: '50m' } })))
      .toBe(deriveTier(recommendedCores({ recommended: { cpu: '0.05' } })));
    expect(deriveTier(recommendedCores({ recommended: { cpu: '2000m' } }))).toBe('highest');
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
