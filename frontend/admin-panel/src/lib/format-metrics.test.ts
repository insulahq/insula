import { describe, it, expect } from 'vitest';
import {
  formatMetricsCpu,
  formatMetricsBytes,
  formatMetricsGi,
  isMetricValue,
  METRIC_UNAVAILABLE,
} from './format-metrics';

/**
 * Regression cover for the admin Tenants page white-screen:
 * `Cannot read properties of null (reading 'toFixed')`.
 *
 * The API's declared type promised a number; a null arrived anyway and took
 * the entire page down rather than one cell. These formatters render inside a
 * table, so they must be total over anything the wire can carry.
 */
describe('metric formatters are total', () => {
  const unusable = [null, undefined, Number.NaN] as const;

  it('renders a dash instead of throwing on an unusable value', () => {
    for (const v of unusable) {
      expect(formatMetricsCpu(v)).toBe(METRIC_UNAVAILABLE);
      expect(formatMetricsBytes(v)).toBe(METRIC_UNAVAILABLE);
      expect(formatMetricsGi(v)).toBe(METRIC_UNAVAILABLE);
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const v of unusable) {
      expect(() => formatMetricsCpu(v)).not.toThrow();
      expect(() => formatMetricsBytes(v)).not.toThrow();
    }
  });

  it('does NOT report 0 as missing — zero usage is a real reading', () => {
    // The pre-fix bytes formatter survived null only because `null <= 0` was
    // true and it returned '0Mi'. Reporting "no data" as "0" is the inverse
    // mistake, and just as misleading on a usage table.
    expect(formatMetricsCpu(0)).toBe('0.00');
    expect(formatMetricsBytes(0)).toBe('0Mi');
    expect(formatMetricsGi(0)).toBe('0 Mi');
  });

  it('keeps the precision ladder for CPU', () => {
    expect(formatMetricsCpu(12.34)).toBe('12');
    expect(formatMetricsCpu(3.456)).toBe('3.5');
    expect(formatMetricsCpu(0.251)).toBe('0.25');
  });

  it('steps down to Mi below 1 Gi', () => {
    expect(formatMetricsBytes(0.5)).toBe('512Mi');
    expect(formatMetricsBytes(0.02)).toBe('20.5Mi');
    expect(formatMetricsBytes(0.002)).toBe('2.05Mi');
    expect(formatMetricsBytes(12.9)).toBe('13Gi');
    expect(formatMetricsBytes(1.25)).toBe('1.3Gi');
  });

  it('spaces the unit only for the Gi variant', () => {
    // The only real difference between the two copies this replaced.
    expect(formatMetricsBytes(2)).toBe('2.0Gi');
    expect(formatMetricsGi(2)).toBe('2.0 Gi');
  });

  it('isMetricValue accepts finite numbers and nothing else', () => {
    expect(isMetricValue(0)).toBe(true);
    expect(isMetricValue(-1.5)).toBe(true);
    expect(isMetricValue(null)).toBe(false);
    expect(isMetricValue(undefined)).toBe(false);
    expect(isMetricValue(Number.NaN)).toBe(false);
    expect(isMetricValue(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
