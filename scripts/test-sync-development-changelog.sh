#!/usr/bin/env bash
# Unit test for sync-development-changelog.sh — simulates the post-cut drift in a
# throwaway git repo and asserts the reconcile restores the released section +
# scopes [Unreleased] to genuinely-new work, idempotently.
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/sync-development-changelog.sh"
pass=0; fail=0
ok(){ printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad(){ printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
yes(){ if eval "$2"; then ok "$1"; else bad "$1 — $2"; fi; }
# In-[Unreleased] grep helper.
unrel(){ awk '/^## \[Unreleased\]/{f=1;next}/^## \[/{f=0}f' CHANGELOG.md; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cd "$WORK" || exit 1
git init -q; git config user.email t@e.test; git config user.name t
mkdir -p scripts; cp "$SCRIPT" scripts/sync-development-changelog.sh

# 1. The state at cut time: [Unreleased] holds the release content. Includes a
#    multi-line **bold** title and a non-bold bullet (both previously survived
#    the dedup and left [Unreleased] drifting — regression guards).
cat > CHANGELOG.md <<'EOF'
# Changelog

## [Unreleased]

### Added
- **Feature A.** Shipped in this release.

### Fixed
- **Bug B.** Also this release.
- **A wrapping fix whose bold title spans two
  lines.** Body of the wrapping fix.

### Changed
- `some-dep` 1.0 → 2.0 (a non-bold bullet).

## [2026.7.0] - 2026-07-01

### Added
- **Old thing.** Prior release.
EOF
git add -A; git commit -qm init

# 2. cut-release's promotion, on the tag: [Unreleased] emptied, [2026.7.1] added.
cat > CHANGELOG.md <<'EOF'
# Changelog

## [Unreleased]

## [2026.7.1] - 2026-07-15

### Added
- **Feature A.** Shipped in this release.

### Fixed
- **Bug B.** Also this release.
- **A wrapping fix whose bold title spans two
  lines.** Body of the wrapping fix.

### Changed
- `some-dep` 1.0 → 2.0 (a non-bold bullet).

## [2026.7.0] - 2026-07-01

### Added
- **Old thing.** Prior release.
EOF
git add -A; git commit -qm cut; git tag v2026.7.1

# 3. development after the cut: still the OLD [Unreleased] (drift) + NEW work
#    added post-cut (a bold entry, and a non-bold bullet that must be KEPT).
cat > CHANGELOG.md <<'EOF'
# Changelog

## [Unreleased]

### Added
- **Feature A.** Shipped in this release.
- **Feature C.** Genuinely new, added after the cut.

### Fixed
- **Bug B.** Also this release.
- **A wrapping fix whose bold title spans two
  lines.** Body of the wrapping fix.

### Changed
- `some-dep` 1.0 → 2.0 (a non-bold bullet).
- `new-dep` 3.0 → 4.0 (genuinely new, non-bold).

## [2026.7.0] - 2026-07-01

### Added
- **Old thing.** Prior release.
EOF
git add -A; git commit -qm "dev drift + new work"

# 4. Reconcile.
bash scripts/sync-development-changelog.sh --tag v2026.7.1 --write; rc=$?
yes "reconcile reports a change (rc=0)"                    "[ $rc -eq 0 ]"
yes "released [2026.7.1] section restored"                 "grep -q '^## \[2026.7.1\] - 2026-07-15' CHANGELOG.md"
yes "prior [2026.7.0] preserved"                           "grep -q '^## \[2026.7.0\]' CHANGELOG.md"
yes "released Feature A moved out of [Unreleased]"         "! unrel | grep -q 'Feature A'"
yes "released Bug B moved out of [Unreleased]"             "! unrel | grep -q 'Bug B'"
yes "multi-line **bold** fix moved out of [Unreleased]"    "! unrel | grep -q 'wrapping fix'"
yes "non-bold dep bump moved out of [Unreleased]"          "! unrel | grep -q 'some-dep'"
yes "genuinely-new Feature C kept in [Unreleased]"         "unrel | grep -q 'Feature C'"
yes "genuinely-new non-bold new-dep kept in [Unreleased]"  "unrel | grep -q 'new-dep'"
yes "empty ### Added not left dangling in [Unreleased]"    "unrel | grep -q '### Added'"
yes "Feature A still present in the released section"       "grep -q 'Feature A' CHANGELOG.md"
yes "wrapping fix still present in the released section"    "grep -q 'wrapping fix' CHANGELOG.md"

# 5. Idempotent.
bash scripts/sync-development-changelog.sh --tag v2026.7.1 --write; rc2=$?
yes "second run is a no-op (rc=2 in-sync)"                 "[ $rc2 -eq 2 ]"

echo
echo "sync-development-changelog tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
