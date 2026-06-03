/**
 * Integration coverage for the REAL self-upgrade I/O (the unit test in
 * upgrade.test.ts fakes atomicReplace + download). Here we drive the REAL
 * `realSelfUpgradeDeps` — real filesystem atomic replace + real Node-crypto
 * verify — with the network seams pointed at local, properly-signed fixtures.
 * No network, no k8s.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realSelfUpgradeDeps } from './index.js';
import { runSelfUpgrade } from './upgrade.js';
import type { SelfUpgradeDeps } from './types.js';

let priv: KeyObject;
let pubPem: string;

beforeAll(() => {
  const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  priv = kp.privateKey;
  pubPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

function sigB64(bytes: Buffer): Buffer {
  return Buffer.from(cryptoSign('sha256', bytes, priv).toString('base64'));
}

/** REAL deps (atomicReplace + verify) with the network seams swapped for local
 * signed fixtures. `binPath` is the live "binary" the upgrade should replace. */
function realDepsWithLocalAssets(
  binPath: string,
  buildVersion: string,
  newBinary: Buffer,
  newSig: Buffer,
  target: { running?: string | null; latest?: string | null },
): SelfUpgradeDeps {
  const env: NodeJS.ProcessEnv = { PLATFORM_OPS_BIN: binPath };
  return {
    ...realSelfUpgradeDeps(env, buildVersion),
    readRunningVersion: async () => target.running ?? null,
    fetchLatestReleaseVersion: async () => target.latest ?? null,
    downloadAsset: async (_v, _a, kind) => (kind === 'sig' ? newSig : newBinary),
    readPublicKey: () => pubPem,
    log: () => undefined,
  };
}

describe('self-upgrade integration — real atomic replace + real verify', () => {
  it('replaces the live binary with a verified payload (real fs, real crypto)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'po-su-'));
    try {
      const bin = join(dir, 'platform-ops');
      writeFileSync(bin, Buffer.from('OLD BINARY v2026.6.2\n'), { mode: 0o755 });
      const newBytes = Buffer.from('NEW BINARY v2026.6.5 ' + 'x'.repeat(1000) + '\n');
      const deps = realDepsWithLocalAssets(bin, '2026.6.2', newBytes, sigB64(newBytes), { running: '2026.6.5' });

      const r = await runSelfUpgrade({ mode: 'apply', force: false }, deps);
      expect(r.action).toBe('upgraded');
      expect(r.target).toBe('2026.6.5');
      // The real file on disk is now the new bytes...
      expect(readFileSync(bin)).toEqual(newBytes);
      // ...still executable...
      expect(statSync(bin).mode & 0o777).toBe(0o755);
      // ...and no temp file left behind.
      expect(existsSync(join(dir, `.platform-ops.new.${process.pid}`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT touch the live binary when the signature does not verify (fail-closed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'po-su-'));
    try {
      const bin = join(dir, 'platform-ops');
      const original = Buffer.from('OLD BINARY v2026.6.2\n');
      writeFileSync(bin, original, { mode: 0o755 });
      const newBytes = Buffer.from('MALICIOUS PAYLOAD\n');
      // Sign DIFFERENT bytes → the signature won't match newBytes.
      const wrongSig = sigB64(Buffer.from('something else'));
      const deps = realDepsWithLocalAssets(bin, '2026.6.2', newBytes, wrongSig, { running: '2026.6.5' });

      const r = await runSelfUpgrade({ mode: 'apply', force: false }, deps);
      expect(r.action).toBe('verify-failed');
      // The live binary is byte-for-byte unchanged.
      expect(readFileSync(bin)).toEqual(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomicReplace returns false (not a crash) when the target dir does not exist', async () => {
    const env: NodeJS.ProcessEnv = { PLATFORM_OPS_BIN: '/no/such/dir/platform-ops' };
    const deps = realSelfUpgradeDeps(env, '2026.6.2');
    expect(await deps.atomicReplace(Buffer.from('x'))).toBe(false);
  });

  it('arch token maps the host arch to the release asset name', () => {
    const deps = realSelfUpgradeDeps({}, '2026.6.2');
    expect(['amd64', 'arm64', process.arch]).toContain(deps.arch());
  });
});
