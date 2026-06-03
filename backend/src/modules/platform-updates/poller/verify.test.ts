import { describe, it, expect, beforeAll } from 'vitest';
import {
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCosignSignature, loadEcPublicKey } from './verify.js';

// Some minimal CI images lack the openssl CLI; skip the real-format proof there
// rather than hard-failing with an opaque spawn ENOENT (the Node-crypto tests
// above already cover the verifier; this one only pins cosign's wire format).
function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version']);
    return true;
  } catch {
    return false;
  }
}

// A cosign `sign-blob --key` signature == base64(DER ECDSA-P256 over sha256).
// Node's crypto.sign('sha256', blob, ecKey) produces that exact format, so we
// use it to forge valid/invalid signatures without needing the cosign binary.
function signBlob(blob: Buffer, privateKey: KeyObject): string {
  return cryptoSign('sha256', blob, privateKey).toString('base64');
}

describe('verifyCosignSignature (Node crypto, no cosign binary)', () => {
  const blob = Buffer.from('{"version":"2026.6.3"}\n');
  let keyPem: string;
  let priv: KeyObject;
  let wrongPriv: KeyObject;

  beforeAll(() => {
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    priv = kp.privateKey;
    keyPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    wrongPriv = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
  });

  it('verifies a correctly-signed blob', () => {
    expect(verifyCosignSignature(blob, signBlob(blob, priv), keyPem)).toBe(true);
  });

  it('accepts a pre-loaded KeyObject as the anchor', () => {
    const key = loadEcPublicKey(keyPem);
    expect(key).not.toBeNull();
    expect(verifyCosignSignature(blob, signBlob(blob, priv), key!)).toBe(true);
  });

  it('rejects a signature made with a different key', () => {
    expect(verifyCosignSignature(blob, signBlob(blob, wrongPriv), keyPem)).toBe(false);
  });

  it('rejects when the blob has been tampered with', () => {
    const sig = signBlob(blob, priv);
    const tampered = Buffer.from('{"version":"9999.9.9"}\n');
    expect(verifyCosignSignature(tampered, sig, keyPem)).toBe(false);
  });

  it('rejects a malformed (non-base64) signature', () => {
    expect(verifyCosignSignature(blob, 'not base64 !!!', keyPem)).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(verifyCosignSignature(blob, '', keyPem)).toBe(false);
    expect(verifyCosignSignature(blob, '   ', keyPem)).toBe(false);
  });

  it('rejects base64 that decodes to a non-signature blob', () => {
    expect(verifyCosignSignature(blob, Buffer.from('garbage').toString('base64'), keyPem)).toBe(false);
  });

  it('rejects a non-EC (RSA) public key as the anchor', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyCosignSignature(blob, signBlob(blob, priv), rsaPem)).toBe(false);
  });

  it('rejects a wrong-curve (P-384) EC public key as the anchor', () => {
    // P-384 is also asymmetricKeyType 'ec' — only prime256v1 (P-256) is the
    // cosign contract, so the curve must be pinned, not just the key type.
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const p384Pem = p384.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(loadEcPublicKey(p384Pem)).toBeNull();
    expect(verifyCosignSignature(blob, signBlob(blob, p384.privateKey), p384Pem)).toBe(false);
  });

  it('rejects a garbage / empty public key', () => {
    expect(verifyCosignSignature(blob, signBlob(blob, priv), 'not a key')).toBe(false);
    expect(verifyCosignSignature(blob, signBlob(blob, priv), '')).toBe(false);
  });
});

describe('loadEcPublicKey', () => {
  it('loads the committed platform/cosign.pub trust anchor', () => {
    // Defence-in-depth: the real pinned key must be a loadable EC key, else the
    // poller would silently fail-closed on every cluster.
    const pub = readFileSync(join(__dirname, '../../../../../platform/cosign.pub'), 'utf8');
    const key = loadEcPublicKey(pub);
    expect(key).not.toBeNull();
    expect(key!.asymmetricKeyType).toBe('ec');
  });

  it('returns null for a non-PEM string', () => {
    expect(loadEcPublicKey('hello')).toBeNull();
  });
});

// Real-format proof: a signature produced by `openssl dgst -sha256 -sign`
// (byte-identical to cosign's `sign-blob --key` output: DER ECDSA, base64) must
// verify. This pins the format contract to the EXACT tool family the release
// pipeline + node bootstrap use, not just Node's own sign().
describe('verifyCosignSignature against openssl-produced signatures (cosign format)', () => {
  it.skipIf(!hasOpenssl())('verifies an openssl ECDSA-P256/SHA256 base64 signature', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cosign-fmt-'));
    try {
      const keyPath = join(dir, 'key.pem');
      const pubPath = join(dir, 'pub.pem');
      const blobPath = join(dir, 'blob');
      const sigPath = join(dir, 'sig.der');
      execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', keyPath]);
      execFileSync('openssl', ['ec', '-in', keyPath, '-pubout', '-out', pubPath]);
      const blob = Buffer.from('{"version":"2026.6.7","images":{}}\n');
      writeFileSync(blobPath, blob);
      // openssl writes the raw DER signature; base64 it the way cosign emits .sig.
      execFileSync('openssl', ['dgst', '-sha256', '-sign', keyPath, '-out', sigPath, blobPath]);
      const sigB64 = readFileSync(sigPath).toString('base64');
      const pubPem = readFileSync(pubPath, 'utf8');
      expect(verifyCosignSignature(blob, sigB64, pubPem)).toBe(true);
      // wrong blob must fail
      expect(verifyCosignSignature(Buffer.from('tampered'), sigB64, pubPem)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
