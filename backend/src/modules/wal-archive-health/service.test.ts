import { describe, it, expect } from 'vitest';
import { parseStorageQuantity } from './service.js';

describe('parseStorageQuantity', () => {
  it('parses binary (Ki/Mi/Gi/Ti/Pi/Ei) units', () => {
    expect(parseStorageQuantity('20Gi')).toBe(20 * 1024 ** 3);
    expect(parseStorageQuantity('500Mi')).toBe(500 * 1024 ** 2);
    expect(parseStorageQuantity('1Ki')).toBe(1024);
    expect(parseStorageQuantity('1Ti')).toBe(1024 ** 4);
    expect(parseStorageQuantity('1Ei')).toBe(1024 ** 6);
  });

  it('parses decimal SI (K/M/G/T/P/E) units', () => {
    expect(parseStorageQuantity('1G')).toBe(1e9);
    expect(parseStorageQuantity('2T')).toBe(2e12);
    expect(parseStorageQuantity('1E')).toBe(1e18);
  });

  it('parses a bare byte count', () => {
    expect(parseStorageQuantity('1000000000')).toBe(1_000_000_000);
  });

  it('handles decimals', () => {
    expect(parseStorageQuantity('1.5Gi')).toBe(Math.round(1.5 * 1024 ** 3));
  });

  it('returns 0 for empty / undefined / malformed input', () => {
    expect(parseStorageQuantity(undefined)).toBe(0);
    expect(parseStorageQuantity('')).toBe(0);
    expect(parseStorageQuantity('garbage')).toBe(0);
    expect(parseStorageQuantity('20Zi')).toBe(0);
  });
});
