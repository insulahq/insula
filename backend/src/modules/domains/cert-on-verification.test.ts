/**
 * ACME issuance is gated on verification: `ensureDomainCertificate` refuses to
 * order for an unverified domain. That gate means something has to ask again
 * the moment a domain actually verifies.
 *
 * It did not, on the create path. `createDomain` calls ensureDomainCertificate
 * BEFORE its post-create verification runs, so the gate skipped, verification
 * then succeeded, and nothing re-asked — the domain waited for the hourly cron.
 * A domain whose DNS was already correct got no certificate for up to an hour,
 * which is the exact "certificates take unreasonably long" problem the gate was
 * introduced to solve.
 *
 * Found by integration-all on a real cluster:
 *   [ingress-reconcile] <host>: cert skipped (domain is 'unverified' —
 *   ACME issuance waits for verification)
 * followed by `cert-manager Certificate Ready=True — timeout after 600s`.
 *
 * The rule now lives in ONE predicate used by every caller that runs a
 * verification. These tests pin that predicate, because the failure mode was
 * precisely "the rule existed in one call site and not the other".
 */

import { describe, it, expect } from 'vitest';
import { shouldIssueCertificateAfter, type VerificationTransition } from './service.js';

describe('shouldIssueCertificateAfter', () => {
  it('issues on first_pass — a brand-new domain that verifies', () => {
    // The create path: this is the transition that was being dropped.
    expect(shouldIssueCertificateAfter('first_pass')).toBe(true);
  });

  it('issues on recovery — DNS was fixed after a regression', () => {
    expect(shouldIssueCertificateAfter('recovery')).toBe(true);
  });

  it('does NOT issue on no_change — an already-verified domain re-passing', () => {
    // Otherwise every hourly sweep would re-enter issuance for every healthy
    // domain on the platform.
    expect(shouldIssueCertificateAfter('no_change')).toBe(false);
  });

  it('does NOT issue on regression — the domain just stopped verifying', () => {
    expect(shouldIssueCertificateAfter('regression')).toBe(false);
  });

  it('does NOT issue on first_fail — a doomed order burns shared LE rate limits', () => {
    expect(shouldIssueCertificateAfter('first_fail')).toBe(false);
  });

  it('covers every transition the type allows', () => {
    // If a new transition is added, this forces a decision about issuance
    // rather than letting it default to "no cert" silently.
    const all: VerificationTransition[] = [
      'first_pass',
      'recovery',
      'regression',
      'first_fail',
      'no_change',
    ];
    const issuing = all.filter(shouldIssueCertificateAfter);
    expect(issuing).toEqual(['first_pass', 'recovery']);
  });
});

describe('every verification call site asks for a certificate', () => {
  it('createDomain re-asks after its post-create verification', async () => {
    // The regression was structural: the cert call sits BEFORE the verification
    // block, so the only way a newly-verified domain gets a cert promptly is a
    // second ask inside that block. Assert the source actually does it — a
    // behavioural test here would need the whole db+k8s surface mocked, and
    // would not have caught "the call site was never added".
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./service.ts', import.meta.url), 'utf-8');

    const verifyBlock = src.slice(src.indexOf('post-create DNS verification'));
    expect(verifyBlock).toContain('shouldIssueCertificateAfter');
    expect(verifyBlock).toContain('ensureDomainCertificate');
  });

  it('the verification cron re-asks too', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./verification-cron.ts', import.meta.url), 'utf-8');

    expect(src).toContain('shouldIssueCertificateAfter');
    expect(src).toContain('ensureDomainCertificate');
    // Both call sites must share the predicate rather than re-spelling the
    // transition list — re-spelling it is how they drifted apart.
    expect(src).not.toMatch(/transition === 'first_pass'\s*\|\|\s*transition === 'recovery'/);
  });
});
