import { describe, it, expect } from 'vitest';
import { formatCurrency, COMMON_CURRENCIES } from '../format-currency';

const EN_US = 'en-US';

describe('formatCurrency', () => {
  it('formats a number with USD using en-US locale', () => {
    expect(formatCurrency(1234.5, 'USD', EN_US)).toBe('$1,234.50');
  });

  it('accepts a Drizzle numeric string and parses it', () => {
    expect(formatCurrency('5.00', 'USD', EN_US)).toBe('$5.00');
  });

  it('formats EUR with the correct symbol', () => {
    // de-DE uses comma as decimal separator and trailing symbol.
    const out = formatCurrency(15, 'EUR', 'de-DE');
    expect(out).toContain('15,00');
    expect(out).toContain('€');
  });

  it('returns the em-dash placeholder for non-finite values', () => {
    expect(formatCurrency(null, 'USD', EN_US)).toBe('—');
    expect(formatCurrency(undefined, 'USD', EN_US)).toBe('—');
    expect(formatCurrency('', 'USD', EN_US)).toBe('—');
    expect(formatCurrency('not-a-number', 'USD', EN_US)).toBe('—');
    expect(formatCurrency(Number.NaN, 'USD', EN_US)).toBe('—');
    expect(formatCurrency(Number.POSITIVE_INFINITY, 'USD', EN_US)).toBe('—');
  });

  it('falls back to "<CODE> <amount>" when Intl rejects the currency code', () => {
    // Intl.NumberFormat throws RangeError for malformed codes (not 3 alpha
    // chars). Three-letter synthetic codes like 'ZZZ' are accepted by ICU
    // and formatted literally — those bypass the fallback intentionally.
    expect(formatCurrency(10, 'XX', EN_US)).toBe('XX 10.00');
  });

  it('handles zero correctly (not coerced to em-dash)', () => {
    expect(formatCurrency(0, 'USD', EN_US)).toBe('$0.00');
  });

  it('COMMON_CURRENCIES contains USD as the first option (default)', () => {
    expect(COMMON_CURRENCIES[0]?.code).toBe('USD');
  });

  it('COMMON_CURRENCIES codes are all valid ISO 4217 shape (3 uppercase letters)', () => {
    for (const c of COMMON_CURRENCIES) {
      expect(c.code).toMatch(/^[A-Z]{3}$/);
    }
  });
});
