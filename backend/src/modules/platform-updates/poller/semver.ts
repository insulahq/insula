/**
 * Prerelease-aware SemVer comparison for the version-poller (W11).
 *
 * The lazy checker in ../service.ts uses a core-only `isNewer` (it strips the
 * `-<suffix>` before comparing). The poller needs the FULL ordering because it
 * may be asked to consider prereleases (`auto_update_include_prereleases`), and
 * per SemVer §11 a version WITH a prerelease sorts BEFORE the same core without
 * one (`2026.6.3-rc.1` < `2026.6.3`). ADR-045 Decision 6 mandates semver-aware
 * comparison, never raw string sort, so this is the single comparator the
 * selection logic uses.
 */

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The dot-separated prerelease identifiers, or [] for a stable release. */
  readonly prerelease: readonly string[];
}

// MAJOR.MINOR.PATCH with NO leading-zero core segments (CalVer 2026.6.1 is
// valid, 2026.06.1 is not — ADR-045 Decision 6), optional `-prerelease`.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** Strip a single leading `v` and surrounding whitespace, then parse. */
export function parseVersion(raw: string): ParsedVersion | null {
  const v = raw.trim().replace(/^v/, '');
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/** True when `raw` is a parseable version per the platform's SemVer subset. */
export function isValidVersion(raw: string): boolean {
  return parseVersion(raw) !== null;
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // SemVer §11.3: a version WITHOUT a prerelease has higher precedence than one
  // WITH a prerelease. Empty list = stable = higher.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  // All shared identifiers equal — the longer set has higher precedence.
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Returns -1 / 0 / 1 for a < b / a == b / a > b. Unparseable inputs sort as the
 * lowest possible value so a corrupted tag can never be selected as "newest".
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** True when the version carries a prerelease identifier (e.g. `-rc.1`). */
export function isPrerelease(raw: string): boolean {
  const p = parseVersion(raw);
  return p !== null && p.prerelease.length > 0;
}
