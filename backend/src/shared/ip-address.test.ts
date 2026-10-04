import { describe, it, expect } from 'vitest';
import { addressKey, canonicalAddress } from './ip-address.js';

describe('canonicalAddress', () => {
  it.each([
    ['AAAA', '2001:DB8:0::1', '2001:db8::1'],
    ['AAAA', '2001:db8:0:0:0:0:0:1', '2001:db8::1'],
    ['aaaa', ' 2001:db8::1 ', '2001:db8::1'],
    ['A', ' 203.0.113.1 ', '203.0.113.1'],
    ['AAAA', 'not-an-ip', 'not-an-ip'],
  ])('%s %s → %s', (type, raw, want) => {
    expect(canonicalAddress(type, raw)).toBe(want);
  });

  it('keys two spellings of one address alike, and the families apart', () => {
    expect(addressKey('AAAA', '2001:DB8:0::1')).toBe(addressKey('aaaa', '2001:db8::1'));
    expect(addressKey('A', '203.0.113.1')).not.toBe(addressKey('AAAA', '203.0.113.1'));
  });
});
