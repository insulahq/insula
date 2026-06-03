import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { pollAvailableVersion, type PollDeps } from './poll.js';
import { SETTING_KEYS, type GithubRelease } from './types.js';

// Real EC keypair so the orchestrator exercises the REAL verify path, not a stub.
let priv: KeyObject;
let pubPem: string;
let wrongPriv: KeyObject;

beforeAll(() => {
  const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  priv = kp.privateKey;
  pubPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  wrongPriv = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
});

function signB64(blob: Buffer, key: KeyObject): string {
  return cryptoSign('sha256', blob, key).toString('base64');
}

interface Harness {
  deps: PollDeps;
  settings: Map<string, string>;
  logs: Array<{ level: string; msg: string }>;
}

interface BuildOpts {
  releases?: readonly GithubRelease[] | null;
  manifestBytes?: Buffer | null;
  sigBytes?: Buffer | null;
  includePrereleases?: boolean;
  /** override fetchAsset entirely (for download-failure simulation) */
  fetchAsset?: (url: string) => Promise<Buffer | null>;
}

function manifestFor(version: string): Buffer {
  return Buffer.from(JSON.stringify({ version, images: { backend: `ghcr.io/x/backend:${version}` } }) + '\n');
}

function releaseWithSignedManifest(tag: string, key: KeyObject): { release: GithubRelease; manifest: Buffer; sig: Buffer } {
  const version = tag.replace(/^v/, '');
  const manifest = manifestFor(version);
  const sig = Buffer.from(signB64(manifest, key));
  const release: GithubRelease = {
    tagName: tag,
    draft: false,
    prerelease: false,
    assets: [
      { name: 'release-manifest.json', url: `https://x/${tag}/release-manifest.json` },
      { name: 'release-manifest.json.sig', url: `https://x/${tag}/release-manifest.json.sig` },
      { name: 'platform-ops-linux-amd64', url: `https://x/${tag}/bin` },
    ],
  };
  return { release, manifest, sig };
}

function build(opts: BuildOpts): Harness {
  const settings = new Map<string, string>();
  if (opts.includePrereleases) settings.set(SETTING_KEYS.includePrereleases, 'true');
  const logs: Array<{ level: string; msg: string }> = [];
  const deps: PollDeps = {
    getSetting: async (k) => settings.get(k) ?? null,
    setSetting: async (k, v) => { settings.set(k, v); },
    fetchReleases: async () => opts.releases ?? null,
    fetchAsset:
      opts.fetchAsset ??
      (async (url) => (url.endsWith('.sig') ? opts.sigBytes ?? null : opts.manifestBytes ?? null)),
    publicKeyPem: pubPem,
    now: () => new Date('2026-06-03T07:00:00.000Z'),
    log: (level, msg) => logs.push({ level, msg }),
  };
  return { deps, settings, logs };
}

describe('pollAvailableVersion — happy path', () => {
  it('verifies a signed release and persists available_version + metadata', async () => {
    const { release, manifest, sig } = releaseWithSignedManifest('v2026.6.5', priv);
    const h = build({ releases: [release], manifestBytes: manifest, sigBytes: sig });

    const res = await pollAvailableVersion(h.deps);

    expect(res.status).toBe('verified');
    expect(res.availableVersion).toBe('2026.6.5');
    expect(h.settings.get(SETTING_KEYS.availableVersion)).toBe('2026.6.5');
    expect(h.settings.get(SETTING_KEYS.availableSource)).toBe('verified-release');
    expect(h.settings.get(SETTING_KEYS.availableVerifiedAt)).toBe('2026-06-03T07:00:00.000Z');
    expect(h.settings.get(SETTING_KEYS.availableVerifyStatus)).toBe('verified');
    // W13: the BREAKING flag is persisted (default 'false' when the manifest omits it).
    expect(h.settings.get(SETTING_KEYS.availableBreaking)).toBe('false');
    expect(h.settings.get(SETTING_KEYS.lastUpdateCheck)).toBe('2026-06-03T07:00:00.000Z');
  });

  it('selects the newest stable across several releases', async () => {
    const a = releaseWithSignedManifest('v2026.6.4', priv);
    const b = releaseWithSignedManifest('v2026.6.6', priv);
    const h = build({
      releases: [a.release, b.release],
      fetchAsset: async (url) => {
        if (url.includes('v2026.6.6')) return url.endsWith('.sig') ? b.sig : b.manifest;
        return url.endsWith('.sig') ? a.sig : a.manifest;
      },
    });
    const res = await pollAvailableVersion(h.deps);
    expect(res.availableVersion).toBe('2026.6.6');
  });
});

describe('pollAvailableVersion — fail-closed paths (available_version never written)', () => {
  it('refuses an unsigned release (no manifest assets)', async () => {
    const release: GithubRelease = {
      tagName: 'v2026.6.5', draft: false, prerelease: false,
      assets: [{ name: 'platform-ops-linux-amd64', url: 'https://x/bin' }],
    };
    const h = build({ releases: [release] });
    const res = await pollAvailableVersion(h.deps);
    expect(res.status).toBe('unsigned');
    expect(h.settings.has(SETTING_KEYS.availableVersion)).toBe(false);
    expect(h.settings.get(SETTING_KEYS.availableVerifyStatus)).toBe('unsigned');
  });

  it('refuses a release whose signature does not verify (wrong key)', async () => {
    const { release, manifest } = releaseWithSignedManifest('v2026.6.5', priv);
    const badSig = Buffer.from(signB64(manifest, wrongPriv));
    const h = build({ releases: [release], manifestBytes: manifest, sigBytes: badSig });
    const res = await pollAvailableVersion(h.deps);
    expect(res.status).toBe('verify-failed');
    expect(h.settings.has(SETTING_KEYS.availableVersion)).toBe(false);
    expect(h.settings.get(SETTING_KEYS.availableVerifyStatus)).toBe('verify-failed');
  });

  it('refuses when the signed manifest version != the release tag (replay guard)', async () => {
    // Validly sign a manifest for 2026.6.5 but attach it to a v2026.9.9 release.
    const realManifest = manifestFor('2026.6.5');
    const realSig = Buffer.from(signB64(realManifest, priv));
    const release: GithubRelease = {
      tagName: 'v2026.9.9', draft: false, prerelease: false,
      assets: [
        { name: 'release-manifest.json', url: 'https://x/m' },
        { name: 'release-manifest.json.sig', url: 'https://x/m.sig' },
      ],
    };
    const h = build({ releases: [release], manifestBytes: realManifest, sigBytes: realSig });
    const res = await pollAvailableVersion(h.deps);
    expect(res.status).toBe('invalid-manifest');
    expect(h.settings.has(SETTING_KEYS.availableVersion)).toBe(false);
  });

  it('refuses a manifest that is signed but not valid JSON', async () => {
    const junk = Buffer.from('{not json');
    const sig = Buffer.from(signB64(junk, priv));
    const release: GithubRelease = {
      tagName: 'v2026.6.5', draft: false, prerelease: false,
      assets: [
        { name: 'release-manifest.json', url: 'https://x/m' },
        { name: 'release-manifest.json.sig', url: 'https://x/m.sig' },
      ],
    };
    const h = build({ releases: [release], manifestBytes: junk, sigBytes: sig });
    const res = await pollAvailableVersion(h.deps);
    expect(res.status).toBe('invalid-manifest');
    expect(h.settings.has(SETTING_KEYS.availableVersion)).toBe(false);
  });

  it('preserves last-known available_version on a previously-verified value when a newer release is unsigned', async () => {
    const release: GithubRelease = {
      tagName: 'v2026.9.9', draft: false, prerelease: false,
      assets: [{ name: 'platform-ops-linux-amd64', url: 'https://x/bin' }],
    };
    const h = build({ releases: [release] });
    h.settings.set(SETTING_KEYS.availableVersion, '2026.6.5'); // prior verified value
    const res = await pollAvailableVersion(h.deps);
    expect(res.status).toBe('unsigned');
    expect(h.settings.get(SETTING_KEYS.availableVersion)).toBe('2026.6.5'); // untouched
  });
});

describe('pollAvailableVersion — connectivity + empty', () => {
  it('reports unreachable and only bumps last_update_check when GitHub is down', async () => {
    const h = build({ releases: null });
    h.settings.set(SETTING_KEYS.availableVersion, '2026.6.5');
    const res = await pollAvailableVersion(h.deps);
    expect(res.status).toBe('unreachable');
    expect(h.settings.get(SETTING_KEYS.availableVersion)).toBe('2026.6.5');
    expect(h.settings.get(SETTING_KEYS.lastUpdateCheck)).toBe('2026-06-03T07:00:00.000Z');
  });

  it('reports no-releases for an empty repo', async () => {
    const h = build({ releases: [] });
    const res = await pollAvailableVersion(h.deps);
    expect(res.status).toBe('no-releases');
    expect(h.settings.has(SETTING_KEYS.availableVersion)).toBe(false);
  });

  it('reports unreachable when the manifest asset download fails', async () => {
    const { release } = releaseWithSignedManifest('v2026.6.5', priv);
    const h = build({ releases: [release], fetchAsset: async () => null });
    const res = await pollAvailableVersion(h.deps);
    expect(res.status).toBe('unreachable');
    expect(h.settings.has(SETTING_KEYS.availableVersion)).toBe(false);
  });

  it('preserves a prior verified status when the asset download fails (transient blip)', async () => {
    const { release } = releaseWithSignedManifest('v2026.6.5', priv);
    const h = build({ releases: [release], fetchAsset: async () => null });
    h.settings.set(SETTING_KEYS.availableVersion, '2026.6.4');
    h.settings.set(SETTING_KEYS.availableVerifyStatus, 'verified');
    const res = await pollAvailableVersion(h.deps);
    expect(res.status).toBe('unreachable');
    // Status NOT regressed by a flaky network — both prior values intact.
    expect(h.settings.get(SETTING_KEYS.availableVerifyStatus)).toBe('verified');
    expect(h.settings.get(SETTING_KEYS.availableVersion)).toBe('2026.6.4');
    expect(h.settings.get(SETTING_KEYS.lastUpdateCheck)).toBe('2026-06-03T07:00:00.000Z');
  });

  it('honours auto_update_include_prereleases when selecting', async () => {
    const stable = releaseWithSignedManifest('v2026.6.5', priv);
    const pre = releaseWithSignedManifest('v2026.7.0-rc.1', priv);
    const preRel: GithubRelease = { ...pre.release, prerelease: true };
    const h = build({
      releases: [stable.release, preRel],
      includePrereleases: true,
      fetchAsset: async (url) => {
        if (url.includes('v2026.7.0-rc.1')) return url.endsWith('.sig') ? pre.sig : pre.manifest;
        return url.endsWith('.sig') ? stable.sig : stable.manifest;
      },
    });
    const res = await pollAvailableVersion(h.deps);
    expect(res.availableVersion).toBe('2026.7.0-rc.1');
  });
});
