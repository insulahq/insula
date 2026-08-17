/**
 * Certificate state classification + fallback decision.
 *
 * The behaviour under test is what made a broken wildcard invisible: a
 * Certificate with no Secret was previously indistinguishable from one
 * still being issued.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyCertificate,
  shouldFallBack,
  FALLBACK_GRACE_MS,
  type CertificateResource,
} from './status.js';
import { pickDomainCertificate } from './cert-reconciler.js';

function cert(status: CertificateResource['status'], dnsNames = ['example.test']): CertificateResource {
  return {
    metadata: { name: 'example-test-cert', labels: { 'insula.host/domain-id': 'd1' } },
    spec: { dnsNames, secretName: 'example-test-tls', issuerRef: { name: 'letsencrypt-prod-http01' } },
    status,
  };
}

describe('classifyCertificate', () => {
  it('reports issued when Ready is True', () => {
    const health = classifyCertificate(
      cert({ conditions: [{ type: 'Ready', status: 'True' }], notAfter: '2027-01-01T00:00:00Z' }),
    );
    expect(health.state).toBe('issued');
    expect(health.notAfter?.getUTCFullYear()).toBe(2027);
    expect(health.message).toBeUndefined();
  });

  it('reports issuing while an order is genuinely in flight', () => {
    const health = classifyCertificate(
      cert({
        conditions: [
          { type: 'Ready', status: 'False', message: 'Issuing certificate as Secret does not exist' },
          { type: 'Issuing', status: 'True', message: 'Requested' },
        ],
      }),
    );
    expect(health.state).toBe('issuing');
  });

  it('reports failed once cert-manager has recorded an attempt failure', () => {
    const health = classifyCertificate(
      cert({
        conditions: [
          { type: 'Ready', status: 'False', message: 'Issuing certificate as Secret does not exist' },
          { type: 'Issuing', status: 'True', message: 'no solver configured for "acme.powerdns.com"' },
        ],
        failedIssuanceAttempts: 3,
        lastFailureTime: '2026-08-17T10:00:00Z',
      }),
    );
    expect(health.state).toBe('failed');
    expect(health.failedAttempts).toBe(3);
    // The useful message is on Issuing; Ready carries boilerplate.
    expect(health.message).toContain('no solver configured');
  });

  it('reports unknown for a CR with no status at all', () => {
    // Not 'issuing' — a CR the API has not observed yet must not read as
    // healthy progress.
    expect(classifyCertificate(cert(undefined)).state).toBe('unknown');
  });

  it('detects a wildcard from the SANs', () => {
    expect(classifyCertificate(cert({}, ['example.test', '*.example.test'])).wildcard).toBe(true);
    expect(classifyCertificate(cert({}, ['www.example.test'])).wildcard).toBe(false);
  });
});

describe('shouldFallBack', () => {
  const now = new Date('2026-08-17T12:00:00Z');
  const failing = (agoMs: number, dnsNames = ['example.test', '*.example.test']) =>
    classifyCertificate(
      cert(
        {
          conditions: [{ type: 'Ready', status: 'False' }],
          failedIssuanceAttempts: 1,
          lastFailureTime: new Date(now.getTime() - agoMs).toISOString(),
        },
        dnsNames,
      ),
    );

  it('waits out the grace period before degrading', () => {
    expect(shouldFallBack(failing(FALLBACK_GRACE_MS - 60_000), now)).toBe(false);
    expect(shouldFallBack(failing(FALLBACK_GRACE_MS + 60_000), now)).toBe(true);
  });

  it('never falls back from a per-hostname cert — there is nothing to fall back to', () => {
    expect(shouldFallBack(failing(FALLBACK_GRACE_MS * 10, ['www.example.test']), now)).toBe(false);
  });

  it('never falls back from a healthy cert', () => {
    const healthy = classifyCertificate(
      cert({ conditions: [{ type: 'Ready', status: 'True' }] }, ['example.test', '*.example.test']),
    );
    expect(shouldFallBack(healthy, now)).toBe(false);
  });
});

describe('pickDomainCertificate', () => {
  const health = (name: string, dnsNames: string[], domainId?: string) =>
    classifyCertificate({
      metadata: { name, labels: domainId ? { 'insula.host/domain-id': domainId } : {} },
      spec: { dnsNames, secretName: `${name}-tls` },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    });

  it('prefers the wildcard covering the domain', () => {
    const certs = [
      health('www-cert', ['www.example.test'], 'd1'),
      health('wildcard-cert', ['example.test', '*.example.test'], 'd1'),
    ];
    expect(pickDomainCertificate(certs, 'd1', 'example.test')?.name).toBe('wildcard-cert');
  });

  it('falls back to any cert that covers the domain name', () => {
    const certs = [health('apex-cert', ['example.test'], 'd1')];
    expect(pickDomainCertificate(certs, 'd1', 'example.test')?.name).toBe('apex-cert');
  });

  it('ignores certificates belonging to another domain', () => {
    const certs = [health('other-cert', ['other.test', '*.other.test'], 'd2')];
    expect(pickDomainCertificate(certs, 'd1', 'example.test')).toBeNull();
  });

  it('matches legacy certs that predate the domain-id label', () => {
    const certs = [health('legacy-cert', ['example.test', '*.example.test'])];
    expect(pickDomainCertificate(certs, 'd1', 'example.test')?.name).toBe('legacy-cert');
  });
});
