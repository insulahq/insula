/**
 * The manual reissue is the escape hatch for "issuance failed and I just fixed
 * the cause" — which means it is disproportionately clicked when DNS is BROKEN.
 * The previous flow deleted the still-valid certificate FIRST and then ordered
 * with force:true, explicitly bypassing verification. An operator with broken
 * DNS therefore destroyed their working certificate AND burned a doomed ACME
 * order; Let's Encrypt caps duplicate certificates at 5/week, so a few
 * desperate clicks locked the domain out of issuance for days, now with no
 * certificate at all.
 *
 * The gate: a FRESH DNS verification (not the up-to-24h-stale cache) runs
 * before anything is touched. Ordering is the contract these tests pin —
 * verify BEFORE delete — because a gate placed after the delete would protect
 * the rate limit but still destroy the working cert.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./reissue.ts', import.meta.url), 'utf-8');

// Bound the analysis to the background task body. `runReissue(` appears in the
// fire-and-forget call inside requestCertificateReissue too, so anchor on the
// function DECLARATION — an unbounded search would measure the wrong region
// (the same class of vacuity a mutation check caught twice on the sibling
// cert-on-verification test).
const body = src.slice(src.indexOf('async function runReissue('));

describe('reissue is gated on a fresh successful verification', () => {
  it('verifies BEFORE deleting the existing certificate', () => {
    const verifyIdx = body.indexOf('await verifyDomain(');
    const deleteIdx = body.indexOf('await deleteDomainCertificate(');
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    // THE contract: a failed verification must leave the working cert alone.
    expect(verifyIdx).toBeLessThan(deleteIdx);
  });

  it('a failed verification returns without touching anything', () => {
    const failBlock = body.slice(
      body.indexOf('if (!verification.verified)'),
      body.indexOf('await deleteDomainCertificate('),
    );
    // The refusal path finishes the task and RETURNS before the delete.
    expect(failBlock).toContain("status: 'failed'");
    expect(failBlock).toContain('return;');
    // And tells the operator the cert survived + why ordering anyway is harmful.
    expect(failBlock).toContain('left untouched');
    expect(failBlock).toContain('rate limits');
  });

  it('the fresh check is a REAL verification, not the cached result', () => {
    // verifyDomain() performs live DNS lookups; reading the cached
    // verification row would approve a doomed order on a stale pass and
    // refuse a just-fixed domain on a stale fail.
    expect(body).toContain('await verifyDomain(');
    expect(body).not.toContain('verificationCacheResult');
  });

  it('the verification result is persisted like any other check', () => {
    // The domain row must reflect this check — an operator watching the
    // domain page sees the same state the reissue acted on.
    expect(body).toContain('await setDomainVerificationStatus(');
  });

  it('the task step list names the gate first', () => {
    const stepsIdx = src.indexOf('const REISSUE_STEPS');
    const stepsBlock = src.slice(stepsIdx, src.indexOf(']', stepsIdx));
    const firstStep = stepsBlock.split('\n')[1] ?? '';
    expect(firstStep).toContain('Verify DNS');
  });
});
