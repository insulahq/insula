#!/usr/bin/env bash
# ci-upgrade-repin-check.sh — guard the platform upgrade re-pin (ADR-045 W13).
#
# `platform-ops upgrade` / the backend orchestrator move the cluster's deployed
# revision by PATCHing a Flux GitRepository's spec.ref to a release TAG — a
# cluster-wide action. The load-bearing invariants:
#   1. DRY-RUN BY DEFAULT — the CLI re-pins only with an explicit --apply.
#   2. The re-pin target is RESOLVED from the live Kustomization's sourceRef,
#      never a hardcoded GitRepository name (works for any cluster).
#   3. The tag is a clean release tag (vX.Y.Z) — a dev pin (-<sha>) is refused.
#   4. The decision logic keeps the auto-off + BREAKING short-circuits.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLANNER="$REPO_ROOT/backend/src/modules/platform-upgrades/upgrade-planner.ts"
REPIN="$REPO_ROOT/backend/src/modules/platform-upgrades/flux-repin.ts"
ORCH="$REPO_ROOT/backend/src/modules/platform-upgrades/orchestrate.ts"
CMD="$REPO_ROOT/backend/src/cli/platform-ops/commands.ts"

fail() { echo "  ✗ $1" >&2; FAILED=1; }
FAILED=0
echo "ci-upgrade-repin-check: verifying W13 re-pin invariants..."

# (1) CLI dry-run by default
[[ -f "$CMD" ]] && grep -q "if (!apply)" "$CMD" || fail "upgradeCommand must be dry-run unless --apply is passed"

# (2) target resolved from the Kustomization, not hardcoded
if [[ -f "$ORCH" ]]; then
  grep -q 'resolveUpgradeGitRepository' "$ORCH" || fail "orchestrate must resolve the GitRepository from the Kustomization sourceRef"
  # no hardcoded live source name baked into the orchestrator/repin
  if grep -qE "'hosting-platform-(production|staging|stable)'" "$ORCH" "$REPIN"; then
    fail "a hardcoded live GitRepository name is baked in — resolve it from the Kustomization instead"
  fi
else
  fail "orchestrate.ts is missing"
fi

# (3) re-pin only writes a clean vX.Y.Z tag (+ clears branch/commit); a dev pin /
#     prerelease is refused by the strict X.Y.Z regex in BOTH functions.
if [[ -f "$REPIN" ]]; then
  grep -qF 'branch: null' "$REPIN" || fail "repin must clear branch when switching to a tag"
  grep -qF '/^v\d+\.\d+\.\d+$/' "$REPIN" || fail "repinGitRepositoryTag must validate the tag is a clean v X.Y.Z"
  grep -qF '/^\d+\.\d+\.\d+$/' "$REPIN" || fail "gitTagForVersion must validate a clean X.Y.Z (refusing dev pins / prereleases)"
else
  fail "flux-repin.ts is missing"
fi

# (4) decision-logic gates
if [[ -f "$PLANNER" ]]; then
  grep -q "blocked-auto-off" "$PLANNER" || fail "planner missing the auto-off gate"
  grep -q "blocked-breaking" "$PLANNER" || fail "planner missing the BREAKING short-circuit"
else
  fail "upgrade-planner.ts is missing"
fi

# (5) rollback (W16): mandatory rescue before apply + dry-run-default + ref-validated
ROLLBACK="$REPO_ROOT/backend/src/modules/platform-upgrades/rollback.ts"
if [[ -f "$ROLLBACK" ]]; then
  grep -qF '0 volumes' "$ROLLBACK" || fail "captureUpgradeRescue must refuse a 0-volume rescue (no safety net → no upgrade)"
  grep -qF 'if (!opts.apply)' "$ROLLBACK" || fail "runRollback must be dry-run unless apply is set"
  grep -qF "status === 'rolled-back'" "$ROLLBACK" || fail "runRollback must refuse re-rolling an already-rolled-back upgrade"
else
  fail "rollback.ts is missing"
fi
# the rollback re-pin must validate the ref it restores (refValueValid charset)
grep -qF 'refValueValid' "$REPIN" || fail "repinGitRepositoryRef must validate the restored ref value (refValueValid)"

# (6) post-flight (W14 follow-up): the consecutive-failure streak is advanced ONLY
#     by the observer (runPostflight) on a controlled cadence — the GET route must
#     be a pure READ (readPostflightState), so a fast UI poll can't inflate the
#     streak toward `abort-recommended`. Guard that read/observe split + the
#     clear-only-on-healthy invariant.
ROUTES="$REPO_ROOT/backend/src/modules/platform-upgrades/routes.ts"
POSTFLIGHT="$REPO_ROOT/backend/src/modules/platform-upgrades/collect-postflight.ts"
if [[ -f "$ROUTES" ]]; then
  grep -q 'readPostflightState' "$ROUTES" || fail "the postflight GET route must call readPostflightState (read-only)"
  # The GET handler must NOT advance the streak by calling the observer.
  if grep -q 'runPostflight' "$ROUTES"; then
    fail "routes.ts must NOT call runPostflight — the GET route is read-only; the observer runs on the scheduler's cadence"
  fi
else
  fail "platform-upgrades/routes.ts is missing"
fi
if [[ -f "$POSTFLIGHT" ]]; then
  # pending is cleared ONLY on a confirmed healthy convergence.
  awk "/verdict === 'healthy'/{f=1} f&&/KEY_PENDING/{ok=1} END{exit !ok}" "$POSTFLIGHT" \
    || fail "runPostflight must clear pending_update_version only inside the verdict==='healthy' branch"
  # the '' cleared-sentinel must be normalised back to null (else a converged
  # cluster re-accrues a streak forever).
  grep -q 'normalizePending' "$POSTFLIGHT" || fail "collect-postflight must normalise the '' pending sentinel to null"
else
  fail "platform-upgrades/collect-postflight.ts is missing"
fi

if [[ "$FAILED" -ne 0 ]]; then echo "ci-upgrade-repin-check: FAILED" >&2; exit 1; fi
echo "ci-upgrade-repin-check: OK"
