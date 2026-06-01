#!/usr/bin/env bash
# TDD harness for scripts/cut-release.sh (Holistic plan W6 / PR 6).
#
# cut-release.sh computes the next CalVer version (YYYY.M.PATCH, no leading-zero
# month — ADR-045 Decision 6), promotes the CHANGELOG [Unreleased] section,
# updates platform/VERSION, and creates an annotated tag. This harness exercises
# the computation + CHANGELOG promotion in throwaway git repos so the logic is
# regression-proof without ever cutting a real release.
#
# Run: ./scripts/test-cut-release.sh   (exit 0 = all pass)
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
CUT="$REPO_ROOT/scripts/cut-release.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
yes() { if eval "$2"; then ok "$1"; else bad "$1 — predicate failed: $2"; fi; }

# A throwaway git repo with platform/VERSION + a Keep-a-Changelog file.
make_repo() {
  local d; d=$(mktemp -d)
  git -C "$d" init -q -b main          # cut-release requires the default branch
  git -C "$d" config user.email t@t.test
  git -C "$d" config user.name test
  mkdir -p "$d/platform" "$d/scripts"
  printf '2026.6.1\n' > "$d/platform/VERSION"
  cat > "$d/CHANGELOG.md" <<'EOF'
# Changelog

## [Unreleased]

### Added
- a new thing

## [2026.6.0] - 2026-06-01

### Added
- the first thing
EOF
  git -C "$d" add -A >/dev/null
  git -C "$d" commit -qm init
  printf '%s' "$d"
}

echo "== version computation =="

# 1. First release of a month (no tags yet) → .1
R=$(make_repo)
V=$("$CUT" --root "$R" --year-month 2026.6 --print-version 2>/dev/null)
eq "no tags → YYYY.M.1" "$V" "2026.6.1"
rm -rf "$R"

# 2. Patch bump when a tag for the month already exists
R=$(make_repo)
git -C "$R" tag v2026.6.1
V=$("$CUT" --root "$R" --year-month 2026.6 --print-version 2>/dev/null)
eq "v2026.6.1 exists → 2026.6.2" "$V" "2026.6.2"
rm -rf "$R"

# 3. Highest patch wins (out-of-order tags) + month rollover gives .1
R=$(make_repo)
git -C "$R" tag v2026.6.1; git -C "$R" tag v2026.6.3; git -C "$R" tag v2026.6.2
eq "max patch +1" "$("$CUT" --root "$R" --year-month 2026.6 --print-version 2>/dev/null)" "2026.6.4"
eq "new month → .1" "$("$CUT" --root "$R" --year-month 2026.7 --print-version 2>/dev/null)" "2026.7.1"
rm -rf "$R"

# 4. Prerelease: -rc.1, then -rc.2 once rc.1 is tagged
R=$(make_repo)
eq "prerelease → -rc.1" "$("$CUT" --root "$R" --year-month 2026.6 --prerelease --print-version 2>/dev/null)" "2026.6.1-rc.1"
git -C "$R" tag v2026.6.1-rc.1
eq "next prerelease → -rc.2" "$("$CUT" --root "$R" --year-month 2026.6 --prerelease --print-version 2>/dev/null)" "2026.6.1-rc.2"
rm -rf "$R"

# 5. Explicit --version override wins over computation
R=$(make_repo)
eq "--version override" "$("$CUT" --root "$R" --version 2030.1.7 --print-version 2>/dev/null)" "2030.1.7"
rm -rf "$R"

echo "== --dry-run is side-effect-free =="
R=$(make_repo)
before=$(git -C "$R" rev-parse HEAD; cat "$R/platform/VERSION"; git -C "$R" tag)
"$CUT" --root "$R" --year-month 2026.6 --dry-run --yes >/dev/null 2>&1
after=$(git -C "$R" rev-parse HEAD; cat "$R/platform/VERSION"; git -C "$R" tag)
eq "--dry-run writes nothing" "$before" "$after"
rm -rf "$R"

echo "== a real cut (in the throwaway repo) =="
R=$(make_repo)
"$CUT" --root "$R" --year-month 2026.6 --yes >/dev/null 2>&1
eq "platform/VERSION bumped" "$(cat "$R/platform/VERSION")" "2026.6.1"
yes "annotated tag v2026.6.1 created" "git -C '$R' rev-parse v2026.6.1 >/dev/null 2>&1"
yes "tag is annotated (not lightweight)" "[ \"\$(git -C '$R' cat-file -t v2026.6.1)\" = tag ]"
yes "CHANGELOG gained a [2026.6.1] section" "grep -qE '^## \[2026.6.1\]' '$R/CHANGELOG.md'"
yes "CHANGELOG keeps a fresh [Unreleased]" "grep -qE '^## \[Unreleased\]' '$R/CHANGELOG.md'"
yes "the 'new thing' moved under [2026.6.1]" "awk '/^## \[2026.6.1\]/{f=1} /^## \[2026.6.0\]/{f=0} f&&/a new thing/{found=1} END{exit !found}' '$R/CHANGELOG.md'"
yes "release commit created" "git -C '$R' log -1 --format=%s | grep -qiE 'release.*2026.6.1'"
rm -rf "$R"

echo "== the --breaking gate (both directions) =="
# fixture's [Unreleased] has no ### BREAKING
R=$(make_repo)
"$CUT" --root "$R" --year-month 2026.6 --breaking --yes >/dev/null 2>&1
yes "--breaking without a BREAKING heading fails (no tag)" "! git -C '$R' rev-parse v2026.6.1 >/dev/null 2>&1"
rm -rf "$R"

# inject a BREAKING heading, keep the tree clean (re-commit)
make_breaking_repo() {
  local d; d=$(make_repo)
  perl -0pi -e 's/### Added\n- a new thing/### BREAKING\n- a breaking thing\n\n### Added\n- a new thing/' "$d/CHANGELOG.md"
  git -C "$d" commit -aqm "breaking changelog"
  printf '%s' "$d"
}

R=$(make_breaking_repo)
"$CUT" --root "$R" --year-month 2026.6 --yes >/dev/null 2>&1
yes "BREAKING present but no --breaking → abort (no tag)" "! git -C '$R' rev-parse v2026.6.1 >/dev/null 2>&1"
rm -rf "$R"

R=$(make_breaking_repo)
"$CUT" --root "$R" --year-month 2026.6 --breaking --yes >/dev/null 2>&1
yes "BREAKING + --breaking → succeeds (tag created)" "git -C '$R' rev-parse v2026.6.1 >/dev/null 2>&1"
rm -rf "$R"

echo "== guards =="
# tag-already-exists: cut the same explicit version twice; second must fail
R=$(make_repo)
"$CUT" --root "$R" --version 2026.6.1 --yes >/dev/null 2>&1
"$CUT" --root "$R" --version 2026.6.1 --yes >/dev/null 2>&1
yes "second cut of an existing tag fails (still exactly one tag)" "[ \$(git -C '$R' tag --list 'v2026.6.1' | wc -l) -eq 1 ]"
rm -rf "$R"

# dirty working tree is refused
R=$(make_repo)
echo "scratch" > "$R/dirty.txt"; git -C "$R" add dirty.txt
"$CUT" --root "$R" --year-month 2026.6 --yes >/dev/null 2>&1
yes "dirty tree → refuses to cut (no tag)" "! git -C '$R' rev-parse v2026.6.1 >/dev/null 2>&1"
rm -rf "$R"

echo
echo "cut-release tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
