/**
 * Lightweight cosign signature verification — pure Node `crypto`, NO cosign
 * binary on the host (the 120 MB cosign binary is CI-only / signing-side).
 *
 * A `cosign sign-blob --key <key>` signature is just a base64-encoded,
 * DER-encoded ECDSA-P256 signature over the SHA-256 digest of the blob. The
 * node-side bootstrap (scripts/lib/bootstrap-phases.sh `platform_ops_verify_blob`)
 * already verifies it with `base64 -d | openssl dgst -sha256 -verify`; this is
 * the exact same operation expressed with Node's built-in crypto so the
 * in-cluster poller needs neither a subprocess nor an external tool:
 *
 *   base64 → DER bytes ; crypto.verify('sha256', blob, ecPubKey, der)
 *
 * The trust anchor is the pinned `platform/cosign.pub` (committed; baked into
 * the backend image). This function is the ONLY gate that decides a release is
 * authentic, so it FAILS CLOSED: any malformed input, wrong-curve key, or
 * non-verifying signature returns false (never throws).
 */

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

// cosign `--key` uses ECDSA over the P-256 (prime256v1) curve. Pin BOTH the key
// type AND the curve: a P-384/P-521 key is also `type === 'ec'` but would make
// every legitimate P-256 signature fail to verify — a silent self-DoS and a
// drift from the documented trust contract. RSA / ed25519 are rejected outright.
function isP256EcKey(key: KeyObject): boolean {
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
}

/**
 * Load a PEM public key, asserting it is an ECDSA-P256 key. Returns null on any
 * problem so a corrupted/empty/wrong-curve key can never be mistaken for a valid
 * anchor.
 */
export function loadEcPublicKey(pem: string): KeyObject | null {
  const trimmed = pem.trim();
  if (!trimmed.includes('BEGIN PUBLIC KEY')) return null;
  try {
    const key = createPublicKey(trimmed);
    if (!isP256EcKey(key)) return null;
    return key;
  } catch {
    return null;
  }
}

function decodeBase64Strict(b64: string): Buffer | null {
  const cleaned = b64.trim();
  if (cleaned.length === 0) return null;
  // Reject anything that isn't pure base64 (cosign emits only base64, no
  // whitespace/newlines inside the token besides a possible trailing one).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned.replace(/\s+/g, ''))) return null;
  try {
    const buf = Buffer.from(cleaned, 'base64');
    if (buf.length === 0) return null;
    // Round-trip guard: Buffer.from is lenient, so confirm re-encoding matches
    // (modulo padding) to catch truncated/garbage input.
    if (buf.toString('base64').replace(/=+$/, '') !== cleaned.replace(/\s+/g, '').replace(/=+$/, '')) {
      return null;
    }
    return buf;
  } catch {
    return null;
  }
}

/**
 * Verify a cosign `sign-blob` signature over `blob`.
 *
 * @param blob       the exact bytes that were signed (e.g. release-manifest.json)
 * @param signatureB64 the `.sig` asset's contents — base64(DER ECDSA signature)
 * @param publicKey  a PEM string OR a pre-loaded EC KeyObject (the pinned anchor)
 * @returns true ONLY if the signature verifies; false on ANY failure (fail-closed)
 */
export function verifyCosignSignature(
  blob: Buffer,
  signatureB64: string,
  publicKey: string | KeyObject,
): boolean {
  const key = typeof publicKey === 'string' ? loadEcPublicKey(publicKey) : publicKey;
  if (!key || !isP256EcKey(key)) return false;

  const der = decodeBase64Strict(signatureB64);
  if (!der) return false;

  try {
    // dsaEncoding 'der' matches cosign's ASN.1/DER output (Node's default for
    // EC verify, set explicitly for clarity and forward-safety).
    return cryptoVerify('sha256', blob, { key, dsaEncoding: 'der' }, der);
  } catch {
    return false;
  }
}
