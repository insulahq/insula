/**
 * Unit tests for the DKIM-rotation pure helpers (A/B selector scheme).
 *
 * Full E2E coverage (Stalwart JMAP round-trip + DNS provider push)
 * lives in the integration harness — the helpers here are the parts
 * that matter for correctness in isolation: the rotation plan (flip,
 * stale-target destroy, straggler sweep) and RSA key shape.
 */

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { planDkimRotation } from './rotate.js';
import { generateDkimKeyPair } from '../email-domains/dkim.js';
import type { StalwartDkimSignatureRow } from '../stalwart-jmap/client.js';

const row = (
  id: string,
  domainId: string,
  selector: string,
  type = 'Dkim1RsaSha256',
): StalwartDkimSignatureRow => ({ id, '@type': type, domainId, selector });

describe('email-dkim/rotate: key generation (shared RSA generator)', () => {
  it('returns PEM-encoded RSA key pair', () => {
    const { privateKey, publicKey } = generateDkimKeyPair();
    expect(privateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(privateKey).toMatch(/-----END PRIVATE KEY-----\s*$/);
    expect(publicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(publicKey).toMatch(/-----END PUBLIC KEY-----\s*$/);
  });

  it('two consecutive calls produce different keys', () => {
    const a = generateDkimKeyPair();
    const b = generateDkimKeyPair();
    expect(a.privateKey).not.toEqual(b.privateKey);
    expect(a.publicKey).not.toEqual(b.publicKey);
  });

  it('generates an RSA-2048 key (matches the k=rsa DNS tag + Dkim1RsaSha256 type)', () => {
    const { publicKey } = generateDkimKeyPair();
    const key = crypto.createPublicKey(publicKey);
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });
});

describe('email-dkim/rotate: planDkimRotation', () => {
  it('flips dkim-1 → dkim-2 keeping the current signature untouched', () => {
    const rows = [row('s1', 'd1', 'dkim-1')];
    const plan = planDkimRotation(rows, 'd1', 'dkim-1');
    expect(plan.target).toBe('dkim-2');
    expect(plan.previousSelector).toBe('dkim-1');
    expect(plan.staleTargetRows).toEqual([]);
    expect(plan.stragglerRows).toEqual([]);
  });

  it('flips dkim-2 → dkim-1 and destroys the stale dkim-1 key from two rotations ago', () => {
    const rows = [row('s1', 'd1', 'dkim-1'), row('s2', 'd1', 'dkim-2')];
    const plan = planDkimRotation(rows, 'd1', 'dkim-2');
    expect(plan.target).toBe('dkim-1');
    expect(plan.previousSelector).toBe('dkim-2');
    expect(plan.staleTargetRows.map((r) => r.id)).toEqual(['s1']);
    expect(plan.stragglerRows).toEqual([]);
  });

  it('legacy domain (null active selector) targets dkim-1 and does NOT sweep the auto signature', () => {
    // The Stalwart auto row may be the ONLY active signer — destroying
    // it would break verification of in-flight mail (its TXT gets
    // pruned by dns-sync once the signature disappears).
    const rows = [
      row('auto-rsa', 'd1', 'v1-rsa-20260101'),
      row('auto-ed', 'd1', 'v1-ed25519-20260101', 'Dkim1Ed25519Sha256'),
    ];
    const plan = planDkimRotation(rows, 'd1', null);
    expect(plan.target).toBe('dkim-1');
    expect(plan.previousSelector).toBeNull();
    expect(plan.staleTargetRows).toEqual([]);
    expect(plan.stragglerRows).toEqual([]);
  });

  it('legacy timestamped selector value is treated like null (targets dkim-1)', () => {
    const plan = planDkimRotation([], 'd1', 'dkim-20260506194233');
    expect(plan.target).toBe('dkim-1');
    expect(plan.previousSelector).toBeNull();
  });

  it('sweeps stragglers only when the current selector signature exists (dual-signed safety)', () => {
    // Straggler (auto rsa whose destroy soft-failed at enable) IS
    // swept when dkim-1 exists: recent mail carries both signatures,
    // so it keeps verifying via dkim-1 after the straggler TXT prunes.
    const withCurrent = [
      row('s1', 'd1', 'dkim-1'),
      row('auto', 'd1', 'v1-rsa-20260101'),
    ];
    const planA = planDkimRotation(withCurrent, 'd1', 'dkim-1');
    expect(planA.stragglerRows.map((r) => r.id)).toEqual(['auto']);

    // Same straggler is NOT swept when the persisted current selector
    // has no signature row (it may be the only signer).
    const withoutCurrent = [row('auto', 'd1', 'v1-rsa-20260101')];
    const planB = planDkimRotation(withoutCurrent, 'd1', 'dkim-1');
    expect(planB.stragglerRows).toEqual([]);
    expect(planB.target).toBe('dkim-2');
  });

  it('steady-state A→B→A: destroys stale target, keeps current, sweeps nothing else', () => {
    const rows = [
      row('old-a', 'd1', 'dkim-1'),
      row('cur-b', 'd1', 'dkim-2'),
    ];
    const plan = planDkimRotation(rows, 'd1', 'dkim-2');
    expect(plan.target).toBe('dkim-1');
    expect(plan.staleTargetRows.map((r) => r.id)).toEqual(['old-a']);
    expect(plan.stragglerRows).toEqual([]);
  });

  it('ignores rows belonging to other domains', () => {
    const rows = [
      row('other1', 'd2', 'dkim-2'),
      row('other2', 'd2', 'v1-rsa-x'),
      row('mine', 'd1', 'dkim-1'),
    ];
    const plan = planDkimRotation(rows, 'd1', 'dkim-1');
    expect(plan.staleTargetRows).toEqual([]);
    expect(plan.stragglerRows).toEqual([]);
  });
});
