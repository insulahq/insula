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
#   --root DIR       repo to operate on (default: this script's parent)
#
# Exit: 0 ok · 1 error (bad CHANGELOG / missing BREAKING / aborted) · 2 usage
set -euo pipefail

PRERELEASE=0 BREAKING=0 DRY_RUN=0 ASSUME_YES=0 PRINT_ONLY=0
OVERRIDE_VERSION="" YEAR_MONTH="" ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prerelease) PRERELEASE=1; shift ;;
    --breaking) BREAKING=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --print-version) PRINT_ONLY=1; shift ;;
    --version) [ $# -ge 2 ] || { echo "cut-release: --version requires a value" >&2; exit 2; }; OVERRIDE_VERSION="$2"; shift 2 ;;
    --year-month) [ $# -ge 2 ] || { echo "cut-release: --year-month requires a value" >&2; exit 2; }; YEAR_MONTH="$2"; shift 2 ;;
    --root) [ $# -ge 2 ] || { echo "cut-release: --root requires a value" >&2; exit 2; }; ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
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

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry-run — no changes made)"
  exit 0
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
