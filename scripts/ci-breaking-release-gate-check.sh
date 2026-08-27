#!/usr/bin/env bash
#
# CI guard for the BREAKING-release auto-upgrade gate (ADR-045 W13).
#
# The gate is a four-link chain, and it was silently broken from the day it
# shipped until 2026-08-26: release.yml never emitted `breaking` into
# release-manifest.json, so the poller always persisted
# `available_breaking=false` and upgrade-planner's `blocked-breaking` branch
# was unreachable — a release carrying `### BREAKING` would have been
# auto-applied. Nothing failed loudly; the gate just never fired.
#
# Each link is asserted here so a future edit to any one of them cannot
# quietly decouple the chain again:
#
#   1. cut-release.sh  — refuses a `### BREAKING` CHANGELOG section without
#                        --breaking (and vice versa)
#   2. release.yml     — emits a `breaking` field in release-manifest.json,
#                        derived from the released CHANGELOG section
#   3. poller          — persists manifest.breaking as `available_breaking`
#   4. upgrade-planner — short-circuits the AUTO path on a breaking release
#
# Exits non-zero on violation. Wired into the Infrastructure CI workflow.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FAILED=0
fail() { echo "  ✗ $1"; FAILED=1; }
pass() { echo "  ✓ $1"; }

readonly RELEASE_WF="${PROJECT_DIR}/.github/workflows/release.yml"
readonly CUT_RELEASE="${PROJECT_DIR}/scripts/cut-release.sh"
readonly POLLER="${PROJECT_DIR}/backend/src/modules/platform-updates/poller/poll.ts"
readonly PLANNER="${PROJECT_DIR}/backend/src/modules/platform-upgrades/upgrade-planner.ts"

echo "▸ Link 1: cut-release.sh cross-checks --breaking against the CHANGELOG"
if grep -q 'BREAKING' "$CUT_RELEASE" \
  && grep -qE 'breaking set but .* no .*BREAKING|BREAKING.* pass --breaking' "$CUT_RELEASE"; then
  pass "cut-release.sh refuses a mismatch in both directions"
else
  fail "cut-release.sh no longer cross-checks --breaking against the '### BREAKING' heading"
fi

echo "▸ Link 2: release.yml emits a derived 'breaking' field into the manifest"
if grep -qE '"breaking":' "$RELEASE_WF"; then
  pass "release-manifest.json includes a breaking field"
else
  fail "release.yml does NOT emit 'breaking' in release-manifest.json — the gate is dead code (this is the 2026-08-26 regression)"
fi
if grep -q 'CHANGELOG.md' "$RELEASE_WF" && grep -qE '#\{3,4\} \+BREAKING|BREAKING' "$RELEASE_WF"; then
  pass "the breaking value is derived from the released CHANGELOG section"
else
  fail "release.yml emits 'breaking' without deriving it from the CHANGELOG — hardcoded or decoupled from the definition of record"
fi

echo "▸ Link 3: the version-poller persists manifest.breaking"
if grep -q 'availableBreaking' "$POLLER" && grep -qE 'manifest\.breaking' "$POLLER"; then
  pass "poller writes available_breaking from manifest.breaking"
else
  fail "poller no longer persists manifest.breaking as available_breaking"
fi

echo "▸ Link 4: upgrade-planner short-circuits the auto path on a breaking release"
if grep -q "blocked-breaking" "$PLANNER" && grep -qE 'input\.breaking' "$PLANNER"; then
  pass "planner refuses to auto-apply a breaking release"
else
  fail "upgrade-planner no longer short-circuits on a breaking release"
fi

if [ "$FAILED" -ne 0 ]; then
  echo
  echo "✗ ci-breaking-release-gate-check FAILED — the BREAKING auto-upgrade gate is broken end-to-end."
  echo "  A release flagged '### BREAKING' would be auto-applied without operator action."
  exit 1
fi

echo "✓ ci-breaking-release-gate-check passed — all four links intact."
