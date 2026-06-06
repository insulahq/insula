#!/usr/bin/env bash
# cut-release.sh — cut a platform release (Holistic plan W6 / ADR-045).
#
# Computes the next CalVer version (YYYY.M.PATCH — no leading-zero month, so it
# stays valid SemVer; ADR-045 Decision 6), promotes the CHANGELOG [Unreleased]
# section to a dated version section, updates platform/VERSION, and creates an
# annotated git tag. Pushing that tag fires .github/workflows/release.yml.
#
# Cadence is ad-hoc (Decision 2): run this when accumulated changes warrant a
# release. Versions are tag-driven — the next version is derived from existing
# tags, not from a stored counter.
#
# Usage:
#   scripts/cut-release.sh [--prerelease] [--breaking] [--version X.Y.Z]
#                          [--dry-run] [--yes] [--year-month YYYY.M]
#                          [--print-version] [--root DIR]
#
#   --prerelease     produce YYYY.M.PATCH-rc.N (GitHub Release marked prerelease)
#   --breaking       this release contains breaking changes — requires a
#                    `### BREAKING` heading in the [Unreleased] CHANGELOG section
#   --version X.Y.Z  override the computed version
#   --dry-run        print the plan; make no commits, tags, or file edits
#   --yes            skip the interactive confirmation
#   --year-month     (testing) override the current YYYY.M instead of reading date
#   --print-version  print only the computed version and exit (no side effects)
#   --allow-uncovered-host-changes
#                    proceed even if the firewall shape changed since the last
#                    tag with no host-migration AND no [no-host-migration] waiver
#                    (the per-PR ci-migration-coverage guard should make this
#                    impossible; this release-time audit is defence-in-depth)
#   --skip-host-migration-audit  skip the release-time host-migration audit
#   --root DIR       repo to operate on (default: this script's parent)
#
# Exit: 0 ok · 1 error (bad CHANGELOG / missing BREAKING / aborted /
#       uncovered host change) · 2 usage
set -euo pipefail

PRERELEASE=0 BREAKING=0 DRY_RUN=0 ASSUME_YES=0 PRINT_ONLY=0
ALLOW_UNCOVERED=0 SKIP_AUDIT=0
OVERRIDE_VERSION="" YEAR_MONTH="" ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prerelease) PRERELEASE=1; shift ;;
    --breaking) BREAKING=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --print-version) PRINT_ONLY=1; shift ;;
    --allow-uncovered-host-changes) ALLOW_UNCOVERED=1; shift ;;
    --skip-host-migration-audit) SKIP_AUDIT=1; shift ;;
    --version) [ $# -ge 2 ] || { echo "cut-release: --version requires a value" >&2; exit 2; }; OVERRIDE_VERSION="$2"; shift 2 ;;
    --year-month) [ $# -ge 2 ] || { echo "cut-release: --year-month requires a value" >&2; exit 2; }; YEAR_MONTH="$2"; shift 2 ;;
    --root) [ $# -ge 2 ] || { echo "cut-release: --root requires a value" >&2; exit 2; }; ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
    *) echo "cut-release: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$ROOT" ] || ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION_FILE="$ROOT/platform/VERSION"
CHANGELOG="$ROOT/CHANGELOG.md"

# Defence-in-depth: a hand-passed --version must be valid CalVer/SemVer so it
# can never produce a malformed tag/commit.
if [ -n "$OVERRIDE_VERSION" ] && ! printf '%s' "$OVERRIDE_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$'; then
  echo "cut-release: --version '$OVERRIDE_VERSION' is not valid (expected X.Y.Z or X.Y.Z-rc.N)" >&2
  exit 2
fi
if [ -n "$YEAR_MONTH" ] && ! printf '%s' "$YEAR_MONTH" | grep -qE '^[0-9]{4}\.[0-9]{1,2}$'; then
  echo "cut-release: --year-month '$YEAR_MONTH' is not valid (expected YYYY.M)" >&2
  exit 2
fi

# Validate the test-override env seams the audit reads. These never reach a
# shell directly, but a non-integer AUDIT_* would otherwise be fed to `$(( ))`
# (bash arithmetic executes `a[$(cmd)]`-style subscripts) and AUDIT_PREV_TAG is
# used as a git ref. Empty = unset (the audit falls back to git-derived values).
for _v in AUDIT_SHAPE_CHANGED AUDIT_MIGRATIONS AUDIT_WAIVERS; do
  case "${!_v-}" in
    '') ;;                  # unset → fall back to the git-derived value
    *[!0-9]*) echo "cut-release: $_v must be a non-negative integer" >&2; exit 2 ;;
  esac
done
if [ -n "${AUDIT_PREV_TAG-}" ] && ! printf '%s' "$AUDIT_PREV_TAG" | grep -qE '^v[0-9]'; then
  echo "cut-release: AUDIT_PREV_TAG must look like a version tag (e.g. v2026.6.3)" >&2
  exit 2
fi

current_year_month() {
  if [ -n "$YEAR_MONTH" ]; then printf '%s' "$YEAR_MONTH"; return; fi
  local y m
  y=$(date -u +%Y)
  m=$(date -u +%m); m=$((10#$m))   # strip leading zero numerically (portable)
  printf '%s.%s' "$y" "$m"
}

# Highest released PATCH for a YYYY.M (ignores -rc prereleases).
highest_patch() {
  local ym="$1" max=0 t rest patch
  for t in $(git -C "$ROOT" tag --list "v${ym}.*"); do
    rest="${t#v}"
    case "$rest" in *-rc.*) continue ;; esac
    patch="${rest##*.}"
    [ "$rest" = "${ym}.${patch}" ] || continue          # exact YYYY.M.PATCH only
    case "$patch" in *[!0-9]*) continue ;; esac
    [ "$patch" -gt "$max" ] && max="$patch"
  done
  printf '%s' "$max"
}

# Highest -rc.N for a fully-qualified base version.
highest_rc() {
  local base="$1" max=0 t rc
  for t in $(git -C "$ROOT" tag --list "v${base}-rc.*"); do
    rc="${t##*-rc.}"
    case "$rc" in *[!0-9]*) continue ;; esac
    [ "$rc" -gt "$max" ] && max="$rc"
  done
  printf '%s' "$max"
}

compute_version() {
  if [ -n "$OVERRIDE_VERSION" ]; then printf '%s' "$OVERRIDE_VERSION"; return; fi
  local ym base
  ym=$(current_year_month)
  base="${ym}.$(( $(highest_patch "$ym") + 1 ))"
  if [ "$PRERELEASE" -eq 1 ]; then
    printf '%s-rc.%s' "$base" "$(( $(highest_rc "$base") + 1 ))"
  else
    printf '%s' "$base"
  fi
}

# ── host-migration release audit (Tier 3) ───────────────────────────────────
# The per-PR scripts/ci-migration-coverage.sh guard already HARD-blocks a
# bootstrap.sh firewall-shape change that ships without a host-migration (or a
# [no-host-migration] waiver). This release-time audit is defence-in-depth: it
# re-checks the cumulative delta since the previous tag and surfaces, in the
# release plan, the migrations + waivers the release will contain. If the shape
# changed since the last tag with NEITHER a migration NOR a waiver, it BLOCKS
# the cut (override with --allow-uncovered-host-changes).

# prev_tag — highest existing release tag (the previous release; the tag we are
# about to cut does not exist yet). Empty on a first-ever release.
# `|| true`: head -1 closes the pipe early → git gets SIGPIPE → pipefail would
# propagate non-zero on a repo that has tags. Callers run inside `set +e`, but
# guard here so a future caller outside that window can't abort.
prev_tag() { git -C "$ROOT" tag --list 'v*' --sort=-version:refname | head -1 || true; }

# shape_at_ref REF — the canonical firewall-shape fingerprint of bootstrap.sh
# AS OF a git ref, reusing ci-migration-coverage.sh's `--print` (single source
# of the fingerprint definition). Empty string if the ref/file is unavailable.
shape_at_ref() {
  local ref="$1" tmp out
  tmp=$(mktemp)
  if git -C "$ROOT" show "${ref}:scripts/bootstrap.sh" > "$tmp" 2>/dev/null; then
    out=$(FWSHAPE_BOOTSTRAP="$tmp" "$ROOT/scripts/ci-migration-coverage.sh" --print 2>/dev/null || true)
  else
    out=""
  fi
  rm -f "$tmp"
  printf '%s' "$out"
}

# audit_verdict CHANGED MIGRATIONS WAIVERS — pure classification (always exit 0).
# Echoes one of unchanged|covered|waived|uncovered. The block decision (whether
# `uncovered` is allowed) lives in the caller, so this never trips set -e.
audit_verdict() {
  local changed="$1" migs="$2" waivers="$3"
  if [ "$changed" -eq 0 ]; then echo "unchanged"; return 0; fi
  if [ "$migs" -gt 0 ]; then echo "covered"; return 0; fi
  if [ "$waivers" -gt 0 ]; then echo "waived"; return 0; fi
  echo "uncovered"
}

# host_migration_audit — prints the audit block to the release plan and returns
# 1 if the cut should be blocked (uncovered shape change, not overridden).
# Git-derived signals are overridable via AUDIT_PREV_TAG / AUDIT_SHAPE_CHANGED /
# AUDIT_MIGRATIONS / AUDIT_WAIVERS for tests.
host_migration_audit() {
  if [ "$SKIP_AUDIT" -eq 1 ]; then
    echo "  host-migration audit : skipped (--skip-host-migration-audit)"
    return 0
  fi
  local last changed migs waivers verdict rc m
  last="${AUDIT_PREV_TAG:-$(prev_tag)}"
  if [ -z "$last" ]; then
    echo "  host-migration audit : no prior tag — skipped (first release)"
    return 0
  fi

  if [ -n "${AUDIT_SHAPE_CHANGED:-}" ]; then
    changed="$AUDIT_SHAPE_CHANGED"
  elif [ "$(shape_at_ref "$last")" = "$("$ROOT/scripts/ci-migration-coverage.sh" --print 2>/dev/null || true)" ]; then
    changed=0
  else
    changed=1
  fi
  migs="${AUDIT_MIGRATIONS:-$(git -C "$ROOT" diff --diff-filter=A --name-only "${last}..HEAD" -- 'platform/host-migrations/' 2>/dev/null | grep -cE '/[0-9]+-[a-z0-9-]+\.sh$' || true)}"
  waivers="${AUDIT_WAIVERS:-$(git -C "$ROOT" log "${last}..HEAD" --format=%B 2>/dev/null | grep -c '\[no-host-migration\]' || true)}"
  changed=$(( changed + 0 )); migs=$(( migs + 0 )); waivers=$(( waivers + 0 ))

  echo "  host-migration audit (since ${last}):"
  # Only enumerate the actual migration files when the count is git-derived
  # (production). When AUDIT_MIGRATIONS is injected (tests), there is no real
  # diff to list, so skip the listing rather than print a misleading set.
  if [ -z "${AUDIT_MIGRATIONS:-}" ]; then
    while IFS= read -r m; do
      [ -n "$m" ] && echo "    + $m"
    done < <(git -C "$ROOT" diff --diff-filter=A --name-only "${last}..HEAD" -- 'platform/host-migrations/' 2>/dev/null | grep -E '/[0-9]+-[a-z0-9-]+\.sh$' || true)
  fi

  verdict=$(audit_verdict "$changed" "$migs" "$waivers")
  case "$verdict" in
    unchanged) echo "    firewall shape unchanged ✓  (${migs} migration(s), ${waivers} waiver(s) this release)" ;;
    covered)   echo "    firewall shape CHANGED — covered by ${migs} host-migration(s) ✓" ;;
    waived)    echo "    firewall shape CHANGED — ${waivers} [no-host-migration] waiver(s) acknowledged ✓" ;;
    uncovered) echo "    firewall shape CHANGED — ⚠ UNCOVERED: no host-migration and no [no-host-migration] waiver since ${last}" ;;
  esac
  # Block only an unallowed uncovered change; everything else is informational.
  if [ "$verdict" = "uncovered" ] && [ "$ALLOW_UNCOVERED" -eq 0 ]; then
    rc=1
  else
    rc=0
  fi
  return "$rc"
}

VERSION=$(compute_version)

if [ "$PRINT_ONLY" -eq 1 ]; then
  printf '%s\n' "$VERSION"
  exit 0
fi

[ -f "$CHANGELOG" ] || { echo "cut-release: $CHANGELOG not found" >&2; exit 1; }
grep -qE '^## \[Unreleased\]' "$CHANGELOG" || { echo "cut-release: CHANGELOG has no '## [Unreleased]' section" >&2; exit 1; }

# The content currently under [Unreleased] (becomes the release body).
unreleased_body() {
  awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' "$CHANGELOG"
}

# Case-insensitive, 3-or-4-hash so a misformatted heading can't slip the gate.
if [ "$BREAKING" -eq 1 ] && ! unreleased_body | grep -qiE '^#{3,4} +BREAKING'; then
  echo "cut-release: --breaking set but [Unreleased] has no '### BREAKING' heading" >&2
  exit 1
fi
if [ "$BREAKING" -eq 0 ] && unreleased_body | grep -qiE '^#{3,4} +BREAKING'; then
  echo "cut-release: [Unreleased] contains a '### BREAKING' heading — pass --breaking to acknowledge" >&2
  exit 1
fi

RELEASE_DATE=$(date -u +%Y-%m-%d)
TAG="v${VERSION}"

# Refuse early (before the plan/prompt) if the tag already exists.
if git -C "$ROOT" rev-parse "$TAG" >/dev/null 2>&1; then
  echo "cut-release: tag ${TAG} already exists" >&2
  exit 1
fi

echo "Release plan:"
echo "  version       : ${VERSION}"
echo "  tag           : ${TAG}"
echo "  date          : ${RELEASE_DATE}"
echo "  prerelease    : $([ "$PRERELEASE" -eq 1 ] && echo yes || echo no)"
echo "  breaking      : $([ "$BREAKING" -eq 1 ] && echo yes || echo no)"
echo "  platform/VERSION → ${VERSION}"
echo "  CHANGELOG     : promote [Unreleased] → [${VERSION}] - ${RELEASE_DATE}"

set +e
host_migration_audit
AUDIT_RC=$?
set -e

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$AUDIT_RC" -ne 0 ]; then
    echo "(dry-run — WOULD BLOCK on the uncovered host change above; pass --allow-uncovered-host-changes to override)"
  fi
  echo "(dry-run — no changes made)"
  exit 0
fi

# Gate: an uncovered firewall-shape change since the last tag blocks the cut.
if [ "$AUDIT_RC" -ne 0 ]; then
  echo "cut-release: firewall shape changed since the last tag with no host-migration and no [no-host-migration] waiver." >&2
  echo "  Existing clusters render the firewall ONCE at bootstrap — a change here will NOT reach them." >&2
  echo "  Add a backfill:  make new-host-migration NAME=<change>   (then refresh the baseline)," >&2
  echo "  or, if existing nodes genuinely don't need it, add a '[no-host-migration]' waiver commit." >&2
  echo "  To cut anyway:   re-run with --allow-uncovered-host-changes" >&2
  exit 1
fi

# Pre-flight before any commit/tag: clean tree (only VERSION + CHANGELOG should
# change) and on the default branch (so the tag points at main, not a feature
# branch or detached HEAD).
if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
  echo "cut-release: working tree is dirty — commit or stash first" >&2
  exit 1
fi
branch=$(git -C "$ROOT" symbolic-ref --short -q HEAD || echo "")
if [ "$branch" != "main" ]; then
  echo "cut-release: must be on 'main' (currently on '${branch:-detached HEAD}')" >&2
  exit 1
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  printf 'Proceed? [y/N] '
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) echo "aborted."; exit 1 ;; esac
fi

# Promote the CHANGELOG: leave a fresh empty [Unreleased], move its content
# under a new dated version heading.
tmp=$(mktemp)
awk -v ver="$VERSION" -v date="$RELEASE_DATE" '
  /^## \[Unreleased\]/ && !done {
    print "## [Unreleased]"; print ""
    print "## [" ver "] - " date
    done=1; next
  }
  { print }
' "$CHANGELOG" > "$tmp"
mv "$tmp" "$CHANGELOG"

printf '%s\n' "$VERSION" > "$VERSION_FILE"

git -C "$ROOT" add platform/VERSION CHANGELOG.md
git -C "$ROOT" commit -qm "chore(release): ${TAG}"
git -C "$ROOT" tag -a "$TAG" -m "Release ${TAG}"

echo "✓ committed + tagged ${TAG}."
echo "  Push to fire release.yml:  git push && git push origin ${TAG}"
