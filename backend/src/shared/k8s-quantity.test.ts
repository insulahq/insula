import { describe, it, expect } from 'vitest';
import { parseK8sQuantity, compareK8sQuantities, quantityRatio } from './k8s-quantity.js';

describe('parseK8sQuantity', () => {
  it('parses bare numbers', () => {
    expect(parseK8sQuantity('0')).toBe(0);
    expect(parseK8sQuantity('33554432')).toBe(33554432);
    expect(parseK8sQuantity(' 42 ')).toBe(42);
  });

  it('parses binary suffixes', () => {
    expect(parseK8sQuantity('1Ki')).toBe(1024);
    expect(parseK8sQuantity('512Mi')).toBe(512 * 1024 ** 2);
    expect(parseK8sQuantity('2Gi')).toBe(2 * 1024 ** 3);
    expect(parseK8sQuantity('1Ti')).toBe(1024 ** 4);
  });

  it('parses decimal suffixes', () => {
    expect(parseK8sQuantity('1k')).toBe(1000);
    expect(parseK8sQuantity('1M')).toBe(1e6);
    expect(parseK8sQuantity('1G')).toBe(1e9);
  });

  it('parses CPU milli-units', () => {
    expect(parseK8sQuantity('100m')).toBeCloseTo(0.1);
    expect(parseK8sQuantity('1900m')).toBeCloseTo(1.9);
    expect(parseK8sQuantity('4')).toBe(4);
  });

  it('parses scientific notation', () => {
    expect(parseK8sQuantity('1e3')).toBe(1000);
    expect(parseK8sQuantity('1.5E3')).toBe(1500);
  });

  // The value that motivated writing a new parser: a live production tenant
  // quota carried memory in MILLI-bytes. mail-pvc's parseQuantity throws on
  // it; resource-parser would read it as 107374182400 Gi.
  it('parses memory expressed in milli-units (real production quota value)', () => {
    expect(parseK8sQuantity('107374182400m')).toBeCloseTo(107374182.4, 1);
  });

  it('returns null rather than throwing on junk', () => {
    expect(parseK8sQuantity('')).toBeNull();
    expect(parseK8sQuantity('abc')).toBeNull();
    expect(parseK8sQuantity('12Xi')).toBeNull();
    expect(parseK8sQuantity('1..2Gi')).toBeNull();
  });
});

describe('compareK8sQuantities', () => {
  it('compares across different suffixes of the same resource', () => {
    expect(compareK8sQuantities('1Gi', '1024Mi')).toBe(0);
    expect(compareK8sQuantities('2Gi', '512Mi')).toBe(1);
    expect(compareK8sQuantities('512Mi', '2Gi')).toBe(-1);
  });

  // The production case: PVC provisioned at 2Gi under a 512Mi plan.
  it('detects the over-quota storage case', () => {
    expect(compareK8sQuantities('2Gi', '512Mi')).toBeGreaterThan(0);
  });

  it('treats at-capacity as NOT exceeded', () => {
    expect(compareK8sQuantities('512Mi', '512Mi')).toBe(0);
    expect(compareK8sQuantities('100m', '100m')).toBe(0);
  });

  it('compares milli-byte memory against binary memory correctly', () => {
    // 33554432 bytes (32Mi) used against 107374182400m (~102Mi) hard.
    expect(compareK8sQuantities('33554432', '107374182400m')).toBe(-1);
  });

  it('returns null when either side is unparseable — never a false "fine"', () => {
    expect(compareK8sQuantities('nonsense', '1Gi')).toBeNull();
    expect(compareK8sQuantities('1Gi', 'nonsense')).toBeNull();
  });
});

describe('quantityRatio', () => {
  it('computes used/hard', () => {
    expect(quantityRatio('512Mi', '1Gi')).toBeCloseTo(0.5);
    expect(quantityRatio('2Gi', '512Mi')).toBeCloseTo(4);
  });

  it('returns null on a zero or unparseable denominator', () => {
    expect(quantityRatio('1Gi', '0')).toBeNull();
    expect(quantityRatio('1Gi', 'junk')).toBeNull();
  });
});
