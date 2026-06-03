/** Shapes for the version-poller (W11). Kept separate so the pure selection +
 * orchestration logic can be unit-tested without importing Node/DB modules. */

/** A GitHub Release asset, normalized to just what the poller needs. */
export interface ReleaseAsset {
  readonly name: string;
  /** Direct download URL (GitHub `browser_download_url`). */
  readonly url: string;
}

/** A GitHub Release, normalized from the REST API response. */
export interface GithubRelease {
  /** e.g. `v2026.6.3` (the poller normalizes the leading `v` when comparing). */
  readonly tagName: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly ReleaseAsset[];
}

/** The cosign-signed `release-manifest.json` payload (release.yml produces it). */
export interface ReleaseManifest {
  readonly version: string;
  readonly images?: Record<string, string>;
  readonly releasedAt?: string;
  /**
   * True when the release CHANGELOG carries a `### BREAKING` heading. Drives the
   * W13 auto-upgrade short-circuit: a BREAKING release is never auto-applied
   * (operator must apply it manually). Defaults false when absent.
   */
  readonly breaking?: boolean;
}

/**
 * Outcome of a single poll. The poller writes `available_version` ONLY on
 * `verified` — every other status is fail-closed (the prior value, if any,
 * is left untouched) so an unverifiable release can never surface as available.
 */
export type PollStatus =
  | 'verified' // signature verified → available_version persisted
  | 'no-releases' // repo has no matching (non-draft, stable-unless-flagged) release
  | 'unreachable' // GitHub API or asset download failed
  | 'unsigned' // selected release lacks the signed manifest assets → refused
  | 'verify-failed' // signature did not verify against the pinned key → refused
  | 'invalid-manifest'; // manifest unparseable, or its version != the release tag → refused

export interface PollResult {
  readonly status: PollStatus;
  readonly selectedTag: string | null;
  readonly availableVersion: string | null;
  readonly reason?: string;
}

/** platform_settings keys the poller reads/writes. */
export const SETTING_KEYS = {
  includePrereleases: 'auto_update_include_prereleases',
  availableVersion: 'available_version',
  availableSource: 'available_source',
  availableVerifiedAt: 'available_verified_at',
  availableVerifyStatus: 'available_verify_status',
  availableBreaking: 'available_breaking',
  lastUpdateCheck: 'last_update_check',
} as const;
