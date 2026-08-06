/**
 * Map a platform version to the release TAG that actually publishes a binary.
 *
 * The DEV cluster's `platform-version` ConfigMap is stamped by build-deploy as
 * `<VERSION>-<short-sha>` (e.g. `2026.8.2-d847808`) — that suffix identifies the
 * image build, not a release. There is exactly ONE platform-ops binary per
 * release, published under `v<VERSION>`, so a self-upgrade that used the stamp
 * verbatim asked GitHub for `v2026.8.2-d847808` and got a 404. The node then sat
 * on whatever binary it happened to have, which is how DEV ran a July build
 * against an August cluster.
 *
 * A genuine prerelease must survive untouched: `2026.8.3-rc.4` IS its own tag,
 * and mapping it to `2026.8.3` would ask for a release that may not exist (or,
 * worse, silently install a different one). So only a lone git-sha identifier is
 * stripped — never `rc.N`, never anything else.
 *
 * Comparison deliberately still runs on the FULL version: per SemVer §11.3 a
 * prerelease sorts below its own stable, so a node already on `2026.8.2` does
 * not flap when the ConfigMap says `2026.8.2-<newsha>`.
 */
import { parseVersion } from '../../../modules/platform-updates/poller/semver.js';

/** An abbreviated or full git object name — what build-deploy appends. */
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * The tag whose release assets should be fetched for `version`.
 * Returns the input unchanged when it is not a dev-stamped build.
 */
export function releaseTagFor(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed) return version;
  // Exactly one identifier, and it looks like a sha rather than `rc`/`beta`/…
  if (parsed.prerelease.length !== 1) return version;
  const only = parsed.prerelease[0] ?? '';
  if (!GIT_SHA_RE.test(only)) return version;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}
