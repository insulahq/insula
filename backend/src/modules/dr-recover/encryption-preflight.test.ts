import { describe, it, expect } from 'vitest';
import {
  probeCiphertext, isEnvelopeShaped, firstConclusive, decideEncryptionGate,
} from './encryption-preflight.js';
import { encrypt } from '../oidc/crypto.js';
import { encryptSecretsPayload } from '../tenant-bundles/components/secrets.js';
import type { DrEncryptionProbe } from '@insula/api-contracts';

// Two DIFFERENT 32-byte keys — the whole point of the check is telling them
// apart, so the fixtures use the real cipher rather than hand-written strings.
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

const probe = (
  verdict: DrEncryptionProbe['verdict'],
  source: DrEncryptionProbe['source'] = 'backup_target',
): DrEncryptionProbe => ({ source, ref: `ref-${verdict}`, label: null, verdict });

describe('probeCiphertext', () => {
  it('reads a value encrypted with the SAME key as ok', () => {
    expect(probeCiphertext(encrypt('s3-secret-key', KEY_A), KEY_A)).toBe('ok');
  });

  it('reads a value encrypted with a DIFFERENT key as wrong_key', () => {
    // This is the DR case: the platform DB was restored from a cluster whose
    // PLATFORM_ENCRYPTION_KEY this cluster does not have.
    expect(probeCiphertext(encrypt('s3-secret-key', KEY_A), KEY_B)).toBe('wrong_key');
  });

  it('handles the KID-prefixed envelope too', () => {
    // pat-store / secrets use `k1:iv:tag:ct`; backup targets use `iv:tag:ct`.
    // Both must resolve, or half the probes would report a false mismatch.
    const kid = encryptSecretsPayload(Buffer.from('pat'), KEY_A);
    expect(kid.startsWith('k1:')).toBe(true);
    expect(probeCiphertext(kid, KEY_A)).toBe('ok');
    expect(probeCiphertext(kid, KEY_B)).toBe('wrong_key');
  });

  it('reports nothing stored as absent, not as a failure', () => {
    // Not every target populates every credential column; an empty one is not
    // evidence that the key is wrong.
    expect(probeCiphertext(null, KEY_A)).toBe('absent');
    expect(probeCiphertext(undefined, KEY_A)).toBe('absent');
    expect(probeCiphertext('', KEY_A)).toBe('absent');
  });

  it('reports a non-envelope value as malformed, not as wrong_key', () => {
    // A legacy plaintext column says nothing about the key. Classing it as
    // wrong_key would let one un-migrated row block an entire fleet recover.
    expect(probeCiphertext('plaintext-password', KEY_A)).toBe('malformed');
    expect(probeCiphertext('not:enough', KEY_A)).toBe('malformed');
    expect(probeCiphertext('zz:zz:zz', KEY_A)).toBe('malformed');
    expect(probeCiphertext('abc:def:012', KEY_A)).toBe('malformed'); // odd-length hex
  });

  it('does not leak the ciphertext through a thrown error', () => {
    // node-crypto messages have been observed to echo ciphertext fragments and
    // this verdict is rendered to an operator — so it returns, never throws.
    const ct = encrypt('super-secret', KEY_A);
    expect(() => probeCiphertext(ct, KEY_B)).not.toThrow();
    expect(probeCiphertext(ct, KEY_B)).toBe('wrong_key');
  });
});

describe('isEnvelopeShaped', () => {
  it('accepts both platform envelope shapes', () => {
    expect(isEnvelopeShaped(encrypt('x', KEY_A))).toBe(true);
    expect(isEnvelopeShaped(encryptSecretsPayload(Buffer.from('x'), KEY_A))).toBe(true);
  });

  it('rejects anything that is not one', () => {
    expect(isEnvelopeShaped('plain')).toBe(false);
    expect(isEnvelopeShaped('a:b:c:d:e')).toBe(false);
    expect(isEnvelopeShaped('aa::bb')).toBe(false);
  });
});

describe('firstConclusive', () => {
  it('skips past absent/malformed columns to the one that can answer', () => {
    // An S3 target leaves the SSH columns null; an SSH target leaves the S3
    // ones null. Taking the first NON-NULL would make the answer depend on
    // column order rather than on the key.
    expect(firstConclusive([null, '', encrypt('k', KEY_A)], KEY_A)).toBe('ok');
    expect(firstConclusive([null, 'legacy-plaintext', encrypt('k', KEY_A)], KEY_B)).toBe('wrong_key');
  });

  it('falls back to malformed only when nothing conclusive exists', () => {
    expect(firstConclusive([null, 'legacy-plaintext'], KEY_A)).toBe('malformed');
    expect(firstConclusive([null, undefined], KEY_A)).toBe('absent');
    expect(firstConclusive([], KEY_A)).toBe('absent');
  });
});

describe('decideEncryptionGate', () => {
  it('an EMPTY probe set is unverified, never ok', () => {
    // The bug this guards: `[].every(ok)` is true, so an absent check reads as
    // a passing one. A fresh cluster has nothing to probe and must say so.
    const v = decideEncryptionGate([]);
    expect(v.verdict).toBe('unverified');
    expect(v.probed).toBe(0);
    expect(v.summary).toContain('could not be checked');
  });

  it('a probe set with NO conclusive verdicts is also unverified', () => {
    const v = decideEncryptionGate([probe('absent'), probe('malformed')]);
    expect(v.verdict).toBe('unverified');
    expect(v.probed).toBe(0);
  });

  it('all-ok is ok, and says what it does not cover', () => {
    const v = decideEncryptionGate([probe('ok'), probe('ok', 'image_pull_credential')]);
    expect(v.verdict).toBe('ok');
    expect(v.probed).toBe(2);
    expect(v.ok).toBe(2);
    expect(v.failed).toBe(0);
    expect(v.remedy).toBeNull();
    // An operator reading "ok" must not conclude a cross-cluster migration is
    // safe — the bundle's own ciphertext was never tested.
    expect(v.summary).toContain('bundle');
  });

  it('one wrong_key among many is a mismatch — a partial read is not a pass', () => {
    const v = decideEncryptionGate([probe('ok'), probe('wrong_key'), probe('ok')]);
    expect(v.verdict).toBe('mismatch');
    expect(v.probed).toBe(3);
    expect(v.failed).toBe(1);
    expect(v.remedy).toContain('secrets-restore');
    expect(v.remedy).toContain('allowEncryptionKeyMismatch');
  });

  it('does not count absent/malformed toward `probed`', () => {
    // Otherwise a target with an empty credential column would pad the
    // denominator and make "2 of 7 failed" read as broadly fine.
    const v = decideEncryptionGate([
      probe('ok'), probe('absent'), probe('malformed'), probe('wrong_key'),
    ]);
    expect(v.probed).toBe(2);
    expect(v.ok).toBe(1);
    expect(v.failed).toBe(1);
    expect(v.verdict).toBe('mismatch');
  });

  it('names the failing sources so the operator knows what to re-enter', () => {
    const v = decideEncryptionGate([
      probe('wrong_key', 'backup_target'),
      probe('wrong_key', 'image_pull_credential'),
    ]);
    expect(v.summary).toContain('backup_target');
    expect(v.summary).toContain('image_pull_credential');
  });

  it('keeps every probe in the response, including the inconclusive ones', () => {
    // `probes` is what the UI lists. Dropping the absent/malformed rows would
    // make the count unexplainable — "probed 1" with four targets on screen.
    const v = decideEncryptionGate([probe('ok'), probe('absent'), probe('malformed')]);
    expect(v.probes).toHaveLength(3);
  });
});

describe('end-to-end: the scenario this exists for', () => {
  it('a DB restored from cluster A, read on cluster B with a fresh key', () => {
    // Cluster A encrypted its backup-target credentials and its registry PAT.
    const aRows = [
      encrypt('AKIA-example', KEY_A),
      encrypt('s3-secret', KEY_A),
      encryptSecretsPayload(Buffer.from('ghp_example'), KEY_A),
    ];
    // Cluster B was bootstrapped with its own key instead of restoring A's.
    const probes: DrEncryptionProbe[] = aRows.map((ct, i) => ({
      source: i < 2 ? 'backup_target' : 'image_pull_credential',
      ref: `row-${i}`,
      label: null,
      verdict: probeCiphertext(ct, KEY_B),
    }));
    const v = decideEncryptionGate(probes);
    expect(v.verdict).toBe('mismatch');
    expect(v.failed).toBe(3);
    expect(v.ok).toBe(0);

    // Same rows, on a cluster that DID restore A's key.
    const good = decideEncryptionGate(aRows.map((ct, i) => ({
      source: 'backup_target' as const, ref: `row-${i}`, label: null,
      verdict: probeCiphertext(ct, KEY_A),
    })));
    expect(good.verdict).toBe('ok');
  });
});
