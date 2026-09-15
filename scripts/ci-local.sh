#!/usr/bin/env bash
#
# Run the CI checks LOCALLY, before pushing.
#
# Why this exists
# ---------------
# 2026-09-15: Backend CI went red on one commit and stayed red for three more
# pushes and roughly eight hours. The cause was a single guard violation
# (a route casting `request.body` instead of parsing it). It went unnoticed
# because "CI is green" was inferred from the per-job notifications that
# happened to be seen, rather than checked — and a job that finishes after you
# look away is invisible.
#
# Two habits caused that, and this script removes the second:
#
#   1. Watch every job to a TERMINAL state before calling a push good.
#   2. Run the checks locally FIRST, so a guard violation never reaches CI.
#
# Usage:
#   ./scripts/ci-local.sh            # checks affected by your diff vs origin/development
#   ./scripts/ci-local.sh --all      # everything, regardless of the diff
#
# This is not a replacement for CI — it cannot build images or reach a live
# PowerDNS. It is the fast 90% that catches what review does not.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ALL=0
[[ "${1:-}" == "--all" ]] && ALL=1

BASE="${CI_LOCAL_BASE:-origin/development}"
CHANGED="$(git diff --name-only "$BASE"...HEAD 2>/dev/null || echo "")"
if [[ -z "$CHANGED" ]]; then
  echo "note: no diff against $BASE — running everything"
  ALL=1
fi

touches() { [[ "$ALL" == "1" ]] && return 0; grep -qE "$1" <<< "$CHANGED"; }

GREEN='\033[32m'; RED='\033[31m'; DIM='\033[2m'; RESET='\033[0m'
pass=0; fail=0; skipped=0
FAILED_NAMES=()

run() {
  local name="$1"; shift
  printf '  %-48s ' "$name"
  if out="$("$@" 2>&1)"; then
    printf '%bPASS%b\n' "$GREEN" "$RESET"; pass=$((pass+1))
  else
    printf '%bFAIL%b\n' "$RED" "$RESET"; fail=$((fail+1)); FAILED_NAMES+=("$name")
    sed 's/^/      /' <<< "$out" | tail -15
  fi
}

skip() { printf '  %-48s %bskipped (not in diff)%b\n' "$1" "$DIM" "$RESET"; skipped=$((skipped+1)); }

# Checks that need a tool this machine may not have. Reported as UNAVAILABLE,
# never as FAIL.
#
# This distinction is the difference between a script people run and a script
# people ignore. `ci-admin-auth-check` needs kubectl; calling its absence a
# failure would make ci-local red on a clean tree, and a tool that is red when
# nothing is wrong teaches you to skip it — which is precisely the habit that
# let a genuine red build survive three pushes.
declare -A NEEDS_TOOL=(
  [ci-admin-auth-check]=kubectl
  [ci-firewall-check]=kubectl
)
unavailable=0
UNAVAILABLE_NAMES=()

run_guard() {
  local g="$1"
  local need="${NEEDS_TOOL[$g]:-}"
  if [[ -n "$need" ]] && ! command -v "$need" >/dev/null 2>&1; then
    printf '  %-48s %bUNAVAILABLE (needs %s) — CI runs it%b\n' "$g" "$DIM" "$need" "$RESET"
    unavailable=$((unavailable+1)); UNAVAILABLE_NAMES+=("$g")
    return 0
  fi
  run "$g" "./scripts/$g.sh"
}

echo "── ci-local ─────────────────────────────────────────────────────────"
echo "base: $BASE   mode: $([[ $ALL == 1 ]] && echo all || echo changed-only)"
echo

# ── api-contracts ───────────────────────────────────────────────────────
# Built FIRST and unconditionally: the backend typecheck resolves against its
# compiled dist, and a stale dist produces phantom errors that mask real ones
# (measured 2026-09-15: 100 phantom errors hiding 4 genuine).
echo "api-contracts"
run "build (tsc --build --force)" \
  node_modules/.bin/tsc --build --force packages/api-contracts
echo

# ── backend ─────────────────────────────────────────────────────────────
if touches '^(backend/|packages/api-contracts/)'; then
  echo "backend"
  run "lint"       npm run --silent lint -w @insula/backend
  run "typecheck"  npm run --silent typecheck -w @insula/backend
  run "tests"      npm run --silent test -w @insula/backend
  echo
else
  echo "backend"; skip "lint / typecheck / tests"; echo
fi

# ── guards that Backend CI runs ─────────────────────────────────────────
echo "backend CI guards"
for g in ci-route-body-validation-check ci-mail-sdk-shape ci-no-longhorn-in-mail \
         ci-mail-arch-regressions ci-tenant-bundles-schema-audit \
         ci-tenant-bundles-resource-audit ci-config-dump-restore-parity; do
  if [[ -x "scripts/$g.sh" ]]; then run_guard "$g"; fi
done
echo

# ── guards that Infrastructure CI runs ──────────────────────────────────
echo "infrastructure CI guards"
for g in ci-notification-template-coverage ci-notification-variable-contract \
         ci-notification-retention-check ci-migration-safety-check \
         ci-integration-coverage ci-admin-auth-check ci-no-pinned-domains \
         ci-system-tenant-check ci-gitops-structure-check; do
  if [[ -x "scripts/$g.sh" ]]; then run_guard "$g"; fi
done
echo

# ── panels ──────────────────────────────────────────────────────────────
for panel in admin-panel tenant-panel; do
  if touches "^frontend/$panel/"; then
    echo "$panel"
    run "typecheck" npm run --silent typecheck -w @insula/"$panel"
    run "tests"     npm run --silent test -w @insula/"$panel"
    echo
  fi
done

echo "────────────────────────────────────────────────────────────────────"
if [[ "$fail" -gt 0 ]]; then
  printf '%bRED%b — %d passed, %d FAILED, %d skipped\n' "$RED" "$RESET" "$pass" "$fail" "$skipped"
  printf '  failed: %s\n' "${FAILED_NAMES[*]}"
  [[ "$unavailable" -gt 0 ]] && printf '  not checked locally (CI will): %s\n' "${UNAVAILABLE_NAMES[*]}"
  echo
  echo "Do not push. CI will fail the same way, and a red branch that stays red"
  echo "is how three more commits land on top of the break."
  exit 1
fi
printf '%bGREEN%b — %d passed, %d skipped, %d unavailable here\n' "$GREEN" "$RESET" "$pass" "$skipped" "$unavailable"
if [[ "$unavailable" -gt 0 ]]; then
  # Named, never silent: an unrun check is not a passed check.
  printf '  not checked locally (CI will): %s\n' "${UNAVAILABLE_NAMES[*]}"
fi
echo
echo "This does NOT replace watching CI: it cannot build images or reach a live"
echo "PowerDNS. Watch every job to a terminal state before calling a push good."
