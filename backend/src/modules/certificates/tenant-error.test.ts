import { describe, it, expect } from 'vitest';
import { tenantSafeCertError, stripResourceNames } from './tenant-error.js';

/** The exact string production sent to a customer. */
const REAL_LEAK = 'The certificate request has failed to complete and will be retried: '
  + 'Failed to wait for order resource "success-com-na-wildcard-cert-1-1573661536" to become ready';

describe('tenantSafeCertError', () => {
  it('never forwards a Kubernetes object name to a tenant', () => {
    const out = tenantSafeCertError(REAL_LEAK);
    expect(out).not.toContain('order resource');
    expect(out).not.toContain('success-com-na-wildcard-cert-1-1573661536');
    expect(out).not.toMatch(/"[a-z0-9-]{8,}"/);
  });

  it('says the request is still in flight, which is what that message means', () => {
    expect(tenantSafeCertError(REAL_LEAK)).toMatch(/has not completed yet/i);
    expect(tenantSafeCertError(REAL_LEAK)).toMatch(/retr/i);
  });

  it('names DNS when DNS is the cause — the only one the tenant can fix', () => {
    for (const raw of [
      'lookup blog.example.test: no such host',
      'DNS problem: NXDOMAIN looking up A for example.test',
      'Could not determine the zone for "example.test"',
    ]) {
      const out = tenantSafeCertError(raw);
      expect(out).toMatch(/DNS/i);
      expect(out).toMatch(/point at the platform/i);
    }
  });

  it('distinguishes a CAA refusal, which looks like a platform fault but is not', () => {
    expect(tenantSafeCertError('CAA record forbids issuance')).toMatch(/CAA record/i);
  });

  it('distinguishes rate limiting, so nobody retries into a longer ban', () => {
    expect(tenantSafeCertError('too many certificates already issued for exact set of domains'))
      .toMatch(/rate-limiting/i);
  });

  it('falls back to an honest sentence for an unrecognised message', () => {
    // A message nobody taught this function to translate is, by definition,
    // one we cannot vouch for as tenant-safe — so it is not forwarded.
    const out = tenantSafeCertError('segfault in frobnicator at 0xdeadbeef /var/run/secret-path');
    expect(out).not.toContain('frobnicator');
    expect(out).not.toContain('/var/run/secret-path');
    expect(out).toMatch(/could not be issued yet/i);
  });

  it('always returns a full sentence, so no template renders a dangling colon', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const out = tenantSafeCertError(raw);
      expect(out.length).toBeGreaterThan(20);
      expect(out.endsWith('.')).toBe(true);
    }
  });
});

describe('stripResourceNames', () => {
  it('removes a quoted object name from any other tenant-facing path', () => {
    expect(stripResourceNames('waiting on "my-cert-1-1573661536" now'))
      .toBe('waiting on the request now');
  });

  it('leaves ordinary quoted words alone', () => {
    expect(stripResourceNames('the "active" state')).toBe('the "active" state');
  });
});
