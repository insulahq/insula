import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { runSelfUpgrade } from './upgrade.js';
import type { SelfUpgradeDeps, SelfUpgradeOptions } from './types.js';
import { verifyCosignSignature } from '../../../modules/platform-updates/poller/verify.js';

// Real EC P-256 keys so the orchestrator runs the REAL verify (not a stub).
let priv: KeyObject;
let pubPem: string;
let wrongPriv: KeyObject;

beforeAll(() => {
  const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  priv = kp.privateKey;
  pubPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  wrongPriv = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
});

const BIN = Buffer.from('#!/platform-ops fake binary bytes\n');
function sigFor(bin: Buffer, key: KeyObject): Buffer {
  return Buffer.from(cryptoSign('sha256', bin, key).toString('base64'));
}

interface Harness {
  deps: SelfUpgradeDeps;
  replaced: { value: Buffer | null };
  logs: Array<{ level: string; msg: string }>;
  downloads: Array<{ version: string; arch: string; kind: string }>;
}

interface Over {
  current?: string;
  running?: string | null;
  latest?: string | null;
  binBytes?: Buffer | null;
  sigBytes?: Buffer | null;
  pub?: string | null;
  replaceOk?: boolean;
}

function harness(over: Over = {}): Harness {
  const replaced: { value: Buffer | null } = { value: null };
  const logs: Array<{ level: string; msg: string }> = [];
  const downloads: Array<{ version: string; arch: string; kind: string }> = [];
  const deps: SelfUpgradeDeps = {
    currentVersion: () => over.current ?? '2026.6.2',
    arch: () => 'amd64',
    readRunningVersion: async () => over.running ?? null,
    fetchLatestReleaseVersion: async () => over.latest ?? null,
    downloadAsset: async (version, arch, kind) => {
      downloads.push({ version, arch, kind });
      if (kind === 'sig') return over.sigBytes !== undefined ? over.sigBytes : sigFor(BIN, priv);
      return over.binBytes !== undefined ? over.binBytes : BIN;
    },
    readPublicKey: () => (over.pub !== undefined ? over.pub : pubPem),
    verify: verifyCosignSignature,
    atomicReplace: async (bin) => {
      if (over.replaceOk === false) return false;
      replaced.value = bin;
      return true;
    },
    log: (level, msg) => logs.push({ level, msg }),
  };
  return { deps, replaced, logs, downloads };
}

const apply: SelfUpgradeOptions = { mode: 'apply', force: false };

describe('runSelfUpgrade — target resolution', () => {
  it('uses an explicit --version when given', async () => {
    const h = harness({ current: '2026.6.2', running: '2026.6.9' });
    const r = await runSelfUpgrade({ ...apply, version: '2026.7.0' }, h.deps);
    expect(r.action).toBe('upgraded');
    expect(r.target).toBe('2026.7.0');
    expect(r.source).toBe('explicit');
  });

  it('rejects an invalid --version (exit-2 territory) without touching the binary', async () => {
    const h = harness();
    const r = await runSelfUpgrade({ ...apply, version: 'not-a-version' }, h.deps);
    expect(r.action).toBe('invalid-version');
    expect(r.ok).toBe(false);
    expect(h.replaced.value).toBeNull();
  });

  it('cluster-up: reads the running version from the ConfigMap', async () => {
    const h = harness({ current: '2026.6.2', running: '2026.6.5' });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.source).toBe('configmap');
    expect(r.target).toBe('2026.6.5');
    expect(r.action).toBe('upgraded');
  });

  it('cluster-down: falls back to the latest GitHub Release', async () => {
    const h = harness({ current: '2026.6.2', running: null, latest: '2026.6.7' });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.source).toBe('releases');
    expect(r.target).toBe('2026.6.7');
    expect(r.action).toBe('upgraded');
  });

  it('no-target (cluster down + Releases offline) is a benign no-op', async () => {
    const h = harness({ running: null, latest: null });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('no-target');
    expect(r.ok).toBe(true);
    expect(h.replaced.value).toBeNull();
  });

  it('ignores an invalid running version and falls through to Releases', async () => {
    const h = harness({ current: '2026.6.2', running: 'garbage', latest: '2026.6.8' });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.source).toBe('releases');
    expect(r.target).toBe('2026.6.8');
  });

  it('a binary with no baked version (unknown) upgrades to any valid target', async () => {
    // Documents the semver contract: an unparseable current sorts below any
    // valid version, so a dev/un-versioned binary always self-upgrades. Pinning
    // this guards against a future semver change silently altering the behaviour.
    const h = harness({ current: 'unknown', running: '2026.6.5' });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('upgraded');
    expect(r.target).toBe('2026.6.5');
  });
});

describe('runSelfUpgrade — version gate', () => {
  it('already-current when the target is not newer and no --force', async () => {
    const h = harness({ current: '2026.6.9', running: '2026.6.9' });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('already-current');
    expect(r.ok).toBe(true);
    expect(h.downloads).toHaveLength(0); // never even downloads
  });

  it('refuses a downgrade via a MITM-ed "latest" (not newer → skipped)', async () => {
    const h = harness({ current: '2026.6.9', running: null, latest: '2026.5.1' });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('already-current');
    expect(h.replaced.value).toBeNull();
  });

  it('--force applies a non-newer version (explicit reinstall/downgrade)', async () => {
    const h = harness({ current: '2026.6.9' });
    const r = await runSelfUpgrade({ mode: 'apply', force: true, version: '2026.6.5' }, h.deps);
    expect(r.action).toBe('upgraded');
    expect(r.target).toBe('2026.6.5');
  });
});

describe('runSelfUpgrade — verify + replace (fail-closed)', () => {
  it('upgrades on a valid signature and replaces the binary', async () => {
    const h = harness({ current: '2026.6.2', running: '2026.6.5' });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('upgraded');
    expect(h.replaced.value).toEqual(BIN);
    expect(h.downloads).toEqual([
      { version: '2026.6.5', arch: 'amd64', kind: 'bin' },
      { version: '2026.6.5', arch: 'amd64', kind: 'sig' },
    ]);
  });

  it('refuses a binary whose signature does not verify (wrong key)', async () => {
    const h = harness({ current: '2026.6.2', running: '2026.6.5', sigBytes: sigFor(BIN, wrongPriv) });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('verify-failed');
    expect(r.ok).toBe(false);
    expect(h.replaced.value).toBeNull();
  });

  it('refuses a tampered binary (signature no longer matches)', async () => {
    const h = harness({ current: '2026.6.2', running: '2026.6.5', binBytes: Buffer.from('TAMPERED') });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('verify-failed');
    expect(h.replaced.value).toBeNull();
  });

  it('refuses (fail-closed) when the pinned public key is unreadable', async () => {
    const h = harness({ current: '2026.6.2', running: '2026.6.5', pub: null });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('verify-failed');
    expect(h.replaced.value).toBeNull();
  });

  it('reports download-failed when an asset is missing', async () => {
    const h = harness({ current: '2026.6.2', running: '2026.6.5', binBytes: null });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('download-failed');
    expect(h.replaced.value).toBeNull();
  });

  it('reports replace-failed when verified but the atomic replace fails', async () => {
    const h = harness({ current: '2026.6.2', running: '2026.6.5', replaceOk: false });
    const r = await runSelfUpgrade(apply, h.deps);
    expect(r.action).toBe('replace-failed');
    expect(r.ok).toBe(false);
  });

  it('never downloads when the version gate already says current (efficiency + safety)', async () => {
    const dl = vi.fn(async () => BIN);
    const h = harness({ current: '2026.6.9', running: '2026.6.9' });
    const deps = { ...h.deps, downloadAsset: dl };
    await runSelfUpgrade(apply, deps);
    expect(dl).not.toHaveBeenCalled();
  });
});
