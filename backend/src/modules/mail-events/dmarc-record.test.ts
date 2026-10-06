import { describe, it, expect } from 'vitest';
import { isTightening, policyOf, withPolicy } from './dmarc-record.js';

describe('DMARC record helpers', () => {
  it('reads p= and ignores sp= / pct= / garbage', () => {
    expect(policyOf('v=DMARC1; p=none; rua=mailto:dmarc@example.test')).toBe('none');
    expect(policyOf('v=DMARC1;p=Quarantine;sp=reject')).toBe('quarantine');
    expect(policyOf('v=DMARC1; sp=reject; rua=mailto:x@example.test')).toBeNull();
    expect(policyOf('v=DMARC1; p=bogus')).toBeNull();
    expect(policyOf(null)).toBeNull();
  });

  it('replaces only p=, keeping every other tag in order', () => {
    expect(withPolicy('v=DMARC1; p=none; sp=none; rua=mailto:dmarc@example.test', 'quarantine'))
      .toBe('v=DMARC1; p=quarantine; sp=none; rua=mailto:dmarc@example.test');
    expect(withPolicy('v=DMARC1;p=none;', 'reject')).toBe('v=DMARC1; p=reject');
  });

  it('inserts p= right after v=DMARC1 when the record has none', () => {
    expect(withPolicy('v=DMARC1; rua=mailto:dmarc@example.test', 'none'))
      .toBe('v=DMARC1; p=none; rua=mailto:dmarc@example.test');
  });

  it('orders policies none < quarantine < reject', () => {
    expect(isTightening('none', 'quarantine')).toBe(true);
    expect(isTightening(null, 'quarantine')).toBe(true);
    expect(isTightening('quarantine', 'none')).toBe(false);
    expect(isTightening('reject', 'quarantine')).toBe(false);
    expect(isTightening('quarantine', 'quarantine')).toBe(false);
  });
});
