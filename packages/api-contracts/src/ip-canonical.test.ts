import { describe, it, expect } from 'vitest';
import { canonicalIp } from './ip-canonical.js';
import { crowdsecDecisionAddressKey } from './crowdsec.js';

describe('canonicalIp', () => {
  it.each([
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:0db8::0:1', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],   // first of two equal runs
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'], // a single zero group stays
    ['::', '::'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['fe80:0:0:0:1:0:0:0', 'fe80::1:0:0:0'],          // equal runs: the first one is shortened
    ['::ffff:203.0.113.5', '203.0.113.5'],
    ['::FFFF:CB00:7105', '203.0.113.5'],
    ['2001:db8::/32', '2001:db8::/32'],
    ['2001:0DB8:0000::/48', '2001:db8::/48'],
    ['::ffff:203.0.113.0/120', '203.0.113.0/24'],
    ['203.0.113.5', '203.0.113.5'],
    [' 198.51.100.7 ', '198.51.100.7'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalIp(input)).toBe(expected);
  });

  it.each(['not-an-ip', '2001:db8::1::2', '1.2.3.256', '2001:db8:0:0:0:0:0:0:1', 'gggg::1'])(
    'leaves %s unchanged', (input) => { expect(canonicalIp(input)).toBe(input); });

  it('one host spelled two ways is one ban-list address', () => {
    expect(crowdsecDecisionAddressKey({ scope: 'Ip', value: '2001:DB8::0:1' }))
      .toBe(crowdsecDecisionAddressKey({ scope: 'Ip', value: '2001:db8:0:0::1' }));
  });
});
