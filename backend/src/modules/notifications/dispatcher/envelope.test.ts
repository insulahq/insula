import { describe, it, expect } from 'vitest';
import { formatOccurredAt, normaliseDateVariables } from './envelope.js';

describe('formatOccurredAt', () => {
  it('turns a raw ISO instant into something a customer can read', () => {
    // Production has been mailing customers `2026-09-21T00:00:00.000Z`.
    expect(formatOccurredAt('2026-09-21T00:00:00.000Z')).toBe('2026-09-21 00:00 UTC');
  });

  it('accepts a Date as well as a string', () => {
    expect(formatOccurredAt(new Date('2026-09-14T10:30:00Z'))).toBe('2026-09-14 10:30 UTC');
  });

  it('passes an unparseable string through rather than showing "Invalid Date"', () => {
    expect(formatOccurredAt('next Tuesday')).toBe('next Tuesday');
  });

  it('returns null for absent values so the caller can decide', () => {
    expect(formatOccurredAt(null)).toBeNull();
    expect(formatOccurredAt(undefined)).toBeNull();
  });
});

describe('normaliseDateVariables', () => {
  it('formats every date-shaped variable', () => {
    const out = normaliseDateVariables({
      expiresAt: '2026-09-21T00:00:00.000Z',
      newExpiresAt: '2026-10-01T12:00:00.000Z',
    });
    expect(out.expiresAt).toBe('2026-09-21 00:00 UTC');
    expect(out.newExpiresAt).toBe('2026-10-01 12:00 UTC');
  });

  it('leaves non-date variables untouched', () => {
    const out = normaliseDateVariables({ percent: '90', tenantName: 'Example Ltd' });
    expect(out).toEqual({ percent: '90', tenantName: 'Example Ltd' });
  });

  it('does not invent keys that were not supplied', () => {
    expect(Object.keys(normaliseDateVariables({ a: 1 }))).toEqual(['a']);
  });
});
