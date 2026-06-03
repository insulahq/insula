/** Release selection for the version-poller (W11): pick the newest eligible
 * GitHub Release, honouring the `auto_update_include_prereleases` flag. */

import type { GithubRelease } from './types.js';
import { compareVersions, isPrerelease, isValidVersion } from './semver.js';

export interface SelectOptions {
  readonly includePrereleases: boolean;
}

/**
 * Choose the newest release the cluster should consider.
 *
 * - Drafts are always excluded.
 * - When `includePrereleases` is false, both API-flagged prereleases AND tags
 *   that parse as a SemVer prerelease (`-rc.1`) are excluded — defence in depth
 *   so a release mis-flagged `prerelease:false` but tagged `-rc` is still skipped.
 * - Tags that don't parse as a valid version are ignored (never selectable).
 * - Ties broken by full semver order (a stable release outranks its prerelease).
 *
 * @returns the winning release, or null when none are eligible.
 */
export function selectRelease(
  releases: readonly GithubRelease[],
  opts: SelectOptions,
): GithubRelease | null {
  const eligible = releases.filter((r) => {
    if (r.draft) return false;
    const tag = r.tagName.replace(/^v/, '');
    if (!isValidVersion(tag)) return false;
    if (!opts.includePrereleases && (r.prerelease || isPrerelease(tag))) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  return eligible.reduce((best, cur) =>
    compareVersions(cur.tagName.replace(/^v/, ''), best.tagName.replace(/^v/, '')) > 0 ? cur : best,
  );
}
