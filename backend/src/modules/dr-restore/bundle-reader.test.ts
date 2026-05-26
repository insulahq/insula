import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar-stream';
import { execSync, spawn as realSpawn } from 'node:child_process';

import { readBundle, LegacyBundleError, BundleDecryptError } from './bundle-reader.js';
import { BundleVersionError } from '../system-backup/dr-sidecars.js';

// We exercise the REAL `age` binary when available — the bundle
// format is too intertwined with age internals to mock meaningfully,
// and the binary is on PATH in every dev/CI environment we target.
// If `age` is unavailable the test is skipped (CI runners install it
// per the docs in CLAUDE.md).
const AGE_AVAILABLE = (() => {
  try {
    execSync('which age', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const describeIfAge = AGE_AVAILABLE ? describe : describe.skip;

// ─── Fixtures ────────────────────────────────────────────────────────

let tmpDir: string;
let identityPath: string;
let recipient: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dr-reader-test-'));
  if (AGE_AVAILABLE) {
    identityPath = join(tmpDir, 'identity.key');
    execSync(`age-keygen -o ${identityPath} 2>/dev/null`, { stdio: 'pipe' });
    const fs = await import('node:fs');
    const keyText = fs.readFileSync(identityPath, 'utf8');
    const m = keyText.match(/# public key: (age1[a-z0-9]+)/);
    if (!m) throw new Error('failed to parse age-keygen output');
    recipient = m[1];
  }
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// Build a tar archive containing the listed entries, then age-encrypt
// it to `recipient`. Returns the encrypted path.
async function buildAndEncrypt(entries: Array<{ name: string; content: Buffer | string }>): Promise<string> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (c: Buffer) => chunks.push(c));
  for (const e of entries) {
    const buf = typeof e.content === 'string' ? Buffer.from(e.content, 'utf8') : e.content;
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: e.name, size: buf.length }, buf, (err) => err ? reject(err) : resolve());
    });
  }
  pack.finalize();
  await new Promise<void>((resolve) => pack.on('end', () => resolve()));
  const tarBytes = Buffer.concat(chunks);

  const encryptedPath = join(tmpDir, 'bundle.tar.age');
  await new Promise<void>((resolve, reject) => {
    const proc = realSpawn('age', ['-r', recipient, '-o', encryptedPath], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`age exit ${code}: ${err}`)));
    proc.stdin.end(tarBytes);
  });
  return encryptedPath;
}

const validDrInputs = `drBundleVersion: 1
createdAt: '2026-05-25T20:00:00.000Z'
apexDomain: example.com
clusterName: example
meshCidr: 10.42.0.0/16
platformVersion: 0.1.0-abc1234
cnpgClusters: []
mailPortMode: haproxy
bundleTopology: single
`;

const validDrRows = JSON.stringify({
  drBundleVersion: 1,
  createdAt: '2026-05-25T20:00:00.000Z',
  backupConfigurations: [],
  backupTargetAssignments: [],
});

const validManifest = JSON.stringify({ bundleFormat: 2, entries: [], skipAtRestore: [] });

// ─── Tests ──────────────────────────────────────────────────────────

describeIfAge('readBundle (real age binary)', () => {
  it('parses a valid bundle with all sidecars present', async () => {
    const path = await buildAndEncrypt([
      { name: 'MANIFEST.json', content: validManifest },
      { name: 'dr-inputs.yaml', content: validDrInputs },
      { name: 'dr-rows.json', content: validDrRows },
      { name: 'platform__platform-secrets.yaml', content: 'apiVersion: v1\nkind: Secret\n' },
    ]);
    const result = await readBundle({ bundlePath: path, ageKeyPath: identityPath });
    expect(result.drInputs.apexDomain).toBe('example.com');
    expect(result.drInputs.drBundleVersion).toBe(1);
    expect(result.drRows.drBundleVersion).toBe(1);
    expect(result.secretYamls.map((s) => s.filename)).toEqual(['platform__platform-secrets.yaml']);
    expect(result.manifestJson.toString('utf8')).toBe(validManifest);
  });

  it('throws LegacyBundleError when dr-inputs.yaml is missing (pre-A2 bundle)', async () => {
    const path = await buildAndEncrypt([
      { name: 'MANIFEST.json', content: validManifest },
      // dr-inputs.yaml + dr-rows.json deliberately absent
      { name: 'platform__platform-secrets.yaml', content: 'apiVersion: v1\nkind: Secret\n' },
    ]);
    await expect(readBundle({ bundlePath: path, ageKeyPath: identityPath }))
      .rejects.toThrowError(LegacyBundleError);
  });

  it('throws LegacyBundleError when ONLY dr-rows.json is missing', async () => {
    const path = await buildAndEncrypt([
      { name: 'MANIFEST.json', content: validManifest },
      { name: 'dr-inputs.yaml', content: validDrInputs },
    ]);
    await expect(readBundle({ bundlePath: path, ageKeyPath: identityPath }))
      .rejects.toThrowError(LegacyBundleError);
  });

  it('throws BundleVersionError when sidecar drBundleVersion is unknown', async () => {
    const futureInputs = validDrInputs.replace('drBundleVersion: 1', 'drBundleVersion: 99');
    const path = await buildAndEncrypt([
      { name: 'MANIFEST.json', content: validManifest },
      { name: 'dr-inputs.yaml', content: futureInputs },
      { name: 'dr-rows.json', content: validDrRows },
    ]);
    await expect(readBundle({ bundlePath: path, ageKeyPath: identityPath }))
      .rejects.toThrowError(BundleVersionError);
  });

  it('throws BundleDecryptError when MANIFEST.json is missing (malformed tar)', async () => {
    const path = await buildAndEncrypt([
      // No MANIFEST.json — this isn't a real platform-produced bundle
      { name: 'dr-inputs.yaml', content: validDrInputs },
      { name: 'dr-rows.json', content: validDrRows },
    ]);
    await expect(readBundle({ bundlePath: path, ageKeyPath: identityPath }))
      .rejects.toThrowError(BundleDecryptError);
  });

  it('throws BundleDecryptError when the wrong age key is provided', async () => {
    const path = await buildAndEncrypt([
      { name: 'MANIFEST.json', content: validManifest },
      { name: 'dr-inputs.yaml', content: validDrInputs },
      { name: 'dr-rows.json', content: validDrRows },
    ]);
    // Generate a DIFFERENT identity and try to decrypt with it.
    const otherKey = join(tmpDir, 'other.key');
    execSync(`age-keygen -o ${otherKey} 2>/dev/null`);
    await expect(readBundle({ bundlePath: path, ageKeyPath: otherKey }))
      .rejects.toThrowError(BundleDecryptError);
  });

  it('throws BundleDecryptError when the bundle file is not age-encrypted', async () => {
    const fakePath = join(tmpDir, 'not-encrypted.age');
    await writeFile(fakePath, 'this is not an age file');
    await expect(readBundle({ bundlePath: fakePath, ageKeyPath: identityPath }))
      .rejects.toThrowError(BundleDecryptError);
  });

  it('wraps BundleVersionError separately from LegacyBundleError', async () => {
    // Behaviour contract: future-version bundles are NOT legacy. The
    // operator should know whether to upgrade the platform or fall
    // back to secrets-only restore.
    const futureInputs = validDrInputs.replace('drBundleVersion: 1', 'drBundleVersion: 2');
    const path = await buildAndEncrypt([
      { name: 'MANIFEST.json', content: validManifest },
      { name: 'dr-inputs.yaml', content: futureInputs },
      { name: 'dr-rows.json', content: validDrRows },
    ]);
    try {
      await readBundle({ bundlePath: path, ageKeyPath: identityPath });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BundleVersionError);
      expect(err).not.toBeInstanceOf(LegacyBundleError);
    }
  });
});

// Silence vi to satisfy the lint rule that imports vi only when used.
void vi;
