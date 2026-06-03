/**
 * Version-poller orchestrator (W11). Fetches GitHub Releases, selects the newest
 * eligible one, downloads its cosign-signed `release-manifest.json`, verifies the
 * signature against the pinned key, and ONLY THEN persists `available_version`.
 *
 * The cosign verify is the single authenticity gate (a malicious release is
 * stopped here), so every non-`verified` path is fail-closed: `available_version`
 * is left exactly as it was, and a diagnostic `available_verify_status` is
 * recorded. Pure orchestration — all I/O (GitHub fetch, asset download, settings
 * read/write, the pinned key, the clock) is injected via `PollDeps` so the whole
 * flow is unit-testable without a network or DB.
 */

import { verifyCosignSignature } from './verify.js';
import { selectRelease } from './select.js';
import { isValidVersion } from './semver.js';
import {
  SETTING_KEYS,
  type GithubRelease,
  type PollResult,
  type PollStatus,
  type ReleaseManifest,
} from './types.js';

const MANIFEST_ASSET = 'release-manifest.json';
const SIGNATURE_ASSET = 'release-manifest.json.sig';

export interface PollDeps {
  /** Read a platform_settings value (null when unset). */
  readonly getSetting: (key: string) => Promise<string | null>;
  /** Upsert a platform_settings value. */
  readonly setSetting: (key: string, value: string) => Promise<void>;
  /** Fetch + normalize the repo's releases (newest-first not required); null = unreachable. */
  readonly fetchReleases: () => Promise<readonly GithubRelease[] | null>;
  /** Download a release asset's raw bytes; null = download failed. */
  readonly fetchAsset: (url: string) => Promise<Buffer | null>;
  /** The pinned trust anchor (PEM) — baked into the image from platform/cosign.pub. */
  readonly publicKeyPem: string;
  readonly now: () => Date;
  readonly log: (level: 'info' | 'warn', msg: string) => void;
}

function manifestVersionMatchesTag(version: string, tagName: string): boolean {
  return version === tagName.replace(/^v/, '');
}

/** Record the timestamp + diagnostic status for any terminal (non-verified) outcome. */
async function recordStatus(deps: PollDeps, status: PollStatus, nowIso: string): Promise<void> {
  await deps.setSetting(SETTING_KEYS.lastUpdateCheck, nowIso);
  await deps.setSetting(SETTING_KEYS.availableVerifyStatus, status);
}

export async function pollAvailableVersion(deps: PollDeps): Promise<PollResult> {
  const nowIso = deps.now().toISOString();
  const includePrereleases = (await deps.getSetting(SETTING_KEYS.includePrereleases)) === 'true';

  const releases = await deps.fetchReleases();
  if (releases === null) {
    // Connectivity failure — preserve the last-known-good available_version and
    // only bump the check timestamp (don't regress the UI to "unknown").
    deps.log('warn', '[version-poller] GitHub releases unreachable — keeping last-known available');
    await deps.setSetting(SETTING_KEYS.lastUpdateCheck, nowIso);
    return { status: 'unreachable', selectedTag: null, availableVersion: null };
  }

  const selected = selectRelease(releases, { includePrereleases });
  if (!selected) {
    deps.log('info', '[version-poller] no eligible releases published yet');
    await recordStatus(deps, 'no-releases', nowIso);
    return { status: 'no-releases', selectedTag: null, availableVersion: null };
  }
  const tag = selected.tagName;

  const manifestAsset = selected.assets.find((a) => a.name === MANIFEST_ASSET);
  const sigAsset = selected.assets.find((a) => a.name === SIGNATURE_ASSET);
  if (!manifestAsset || !sigAsset) {
    // Fail-closed: an unsigned release is never surfaced as available (the only
    // gate is the signature, so "no signature" === "do not trust").
    deps.log('warn', `[version-poller] release ${tag} has no signed manifest — refusing (fail-closed)`);
    await recordStatus(deps, 'unsigned', nowIso);
    return { status: 'unsigned', selectedTag: tag, availableVersion: null, reason: 'missing release-manifest.json(.sig)' };
  }

  const manifestBytes = await deps.fetchAsset(manifestAsset.url);
  const sigBytes = await deps.fetchAsset(sigAsset.url);
  if (!manifestBytes || !sigBytes) {
    // Transient connectivity failure (same class as GitHub being unreachable):
    // only bump last_update_check and DELIBERATELY leave availableVerifyStatus
    // untouched so a prior 'verified' isn't regressed by a flaky network blip.
    deps.log('warn', `[version-poller] failed to download manifest/sig for ${tag}`);
    await deps.setSetting(SETTING_KEYS.lastUpdateCheck, nowIso);
    return { status: 'unreachable', selectedTag: tag, availableVersion: null, reason: 'asset download failed' };
  }

  if (!verifyCosignSignature(manifestBytes, sigBytes.toString('utf8'), deps.publicKeyPem)) {
    deps.log('warn', `[version-poller] signature verification FAILED for ${tag} — refusing (fail-closed)`);
    await recordStatus(deps, 'verify-failed', nowIso);
    return { status: 'verify-failed', selectedTag: tag, availableVersion: null, reason: 'cosign signature did not verify' };
  }

  let manifest: ReleaseManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8')) as ReleaseManifest;
  } catch {
    deps.log('warn', `[version-poller] manifest for ${tag} is not valid JSON — refusing`);
    await recordStatus(deps, 'invalid-manifest', nowIso);
    return { status: 'invalid-manifest', selectedTag: tag, availableVersion: null, reason: 'manifest not JSON' };
  }

  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!isValidVersion(version)) {
    deps.log('warn', `[version-poller] manifest for ${tag} has invalid version '${version}' — refusing`);
    await recordStatus(deps, 'invalid-manifest', nowIso);
    return { status: 'invalid-manifest', selectedTag: tag, availableVersion: null, reason: 'manifest version invalid' };
  }
  // The signed manifest's version is authoritative; bind it to the (attacker-
  // controllable) release tag so a valid signature can't be replayed under a
  // higher tag name.
  if (!manifestVersionMatchesTag(version, tag)) {
    deps.log('warn', `[version-poller] manifest version '${version}' != release tag '${tag}' — refusing`);
    await recordStatus(deps, 'invalid-manifest', nowIso);
    return { status: 'invalid-manifest', selectedTag: tag, availableVersion: null, reason: 'manifest/tag version mismatch' };
  }

  await deps.setSetting(SETTING_KEYS.availableVersion, version);
  await deps.setSetting(SETTING_KEYS.availableSource, 'verified-release');
  await deps.setSetting(SETTING_KEYS.availableVerifiedAt, nowIso);
  await deps.setSetting(SETTING_KEYS.availableVerifyStatus, 'verified');
  await deps.setSetting(SETTING_KEYS.lastUpdateCheck, nowIso);
  deps.log('info', `[version-poller] verified release ${version} — available_version updated`);
  return { status: 'verified', selectedTag: tag, availableVersion: version };
}
