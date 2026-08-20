import { describe, it, expect } from 'vitest';
import { withSoaExpire, SOA_EXPIRE_SECONDS } from './powerdns.js';

describe('withSoaExpire', () => {
  it('raises EXPIRE to 14 days and touches nothing else', () => {
    // PowerDNS's shipped default-soa-content shape.
    const before = 'a.misconfigured.dns.server.invalid hostmaster.example.com. 0 10800 3600 604800 3600';
    const after = withSoaExpire(before);
    expect(after).toBe('a.misconfigured.dns.server.invalid hostmaster.example.com. 0 10800 3600 1209600 3600');

    const [p, r, serial, refresh, retry, expire, minimum] = (after as string).split(/\s+/);
    const b = before.split(/\s+/);
    expect(expire).toBe(String(SOA_EXPIRE_SECONDS));
    // Everything else is byte-identical: inventing a serial would break AXFR,
    // and overriding refresh/retry would fight a deliberate server config.
    expect([p, r, serial, refresh, retry, minimum]).toEqual([b[0], b[1], b[2], b[3], b[4], b[6]]);
  });

  it('preserves a real serial rather than resetting it', () => {
    const after = withSoaExpire('ns1.example.com. admin.example.com. 2024010101 3600 900 604800 86400');
    expect(after).toContain(' 2024010101 ');
    expect(after).toContain(' 1209600 ');
  });

  it('is a no-op when already at the target (idempotent reconcile)', () => {
    expect(withSoaExpire('ns1.example.com. admin.example.com. 1 3600 900 1209600 86400')).toBeNull();
  });

  it('refuses malformed rdata instead of writing a corrupted apex SOA', () => {
    expect(withSoaExpire('too few fields here')).toBeNull();
    expect(withSoaExpire('')).toBeNull();
  });
});
