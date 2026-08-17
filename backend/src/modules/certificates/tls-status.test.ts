import { describe, it, expect } from 'vitest';
import { aggregateState, wildcardBlockedReason } from './tls-status.js';
import type { CertificateDetail } from '@insula/api-contracts';

function detail(state: CertificateDetail['state']): CertificateDetail {
  return {
    name: `cert-${state}`,
    state,
    dnsNames: ['example.test'],
    wildcard: false,
    secretName: 'example-test-tls',
    issuerName: 'letsencrypt-prod-http01',
    message: null,
    failedAttempts: 0,
    lastFailureAt: null,
    expiresAt: null,
  };
}

describe('aggregateState', () => {
  it('reports the worst state, not the average', () => {
    // One failing cert means some hostname is serving a browser warning.
    expect(aggregateState([detail('issued'), detail('failed')])).toBe('failed');
    expect(aggregateState([detail('issued'), detail('issuing')])).toBe('issuing');
    expect(aggregateState([detail('issued'), detail('issued')])).toBe('issued');
  });

  it('is unknown with no certificates at all', () => {
    expect(aggregateState([])).toBe('unknown');
  });
});

describe('wildcardBlockedReason', () => {
  const powerdns = { providerType: 'powerdns', enabled: 1, role: 'primary' };

  it('returns null when a wildcard is possible', () => {
    expect(wildcardBlockedReason('primary', [powerdns])).toBeNull();
  });

  it('names the customer-managed-DNS case specifically', () => {
    const reason = wildcardBlockedReason('cname', [powerdns]);
    expect(reason).toContain("'cname'");
    expect(reason).toContain('managed elsewhere');
  });

  it('distinguishes "no primary server" from "wrong DNS mode"', () => {
    const reason = wildcardBlockedReason('primary', []);
    expect(reason).toContain('no enabled primary DNS server');
  });

  it('names the provider types when none can write challenge records', () => {
    const reason = wildcardBlockedReason('primary', [
      { providerType: 'mock', enabled: 1, role: 'primary' },
    ]);
    expect(reason).toContain('mock');
    expect(reason).toContain('Supported:');
  });
});
