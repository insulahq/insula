#!/usr/bin/env bash
# ci-migration-coverage.sh — forcing function (Tier 1) for the
# "fresh-render vs existing-node" delta.
#
# WHY: bootstrap.sh renders the host firewall (nft sets + drop/accept rules)
# ONCE at install time. A change to that shape reaches FRESH installs but NOT
# already-bootstrapped nodes — those need a one-shot W10c host-migration to
# backfill (the firewall-blacklist gap, 2026-06-06, that this guard prevents
# from recurring). Until firewall rules are continuously converged (Tier 2),
# this guard makes "change the firewall → ship a migration" a hard gate.
#
# HOW: fingerprint the firewall shape from bootstrap.sh and compare to the
# committed baseline scripts/.firewall-shape.sha256. On a mismatch the PR MUST
# either (a) add a host-migration AND refresh the baseline, or (b) carry a
# `[no-host-migration]` waiver with a reason. Else the build fails.
#
# Modes:
#   ci-migration-coverage.sh                  → check (CI)
#   ci-migration-coverage.sh --update-baseline → rewrite the baseline to current
#   ci-migration-coverage.sh --print           → print the current shape (debug)
#
# Testable: FWSHAPE_BOOTSTRAP / FWSHAPE_BASELINE override the inputs, and
# MIGRATION_ADDED / WAIVER / BASELINE_UPDATED override the git-derived signals.
set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BOOTSTRAP="${FWSHAPE_BOOTSTRAP:-$REPO_ROOT/scripts/bootstrap.sh}"
BASELINE="${FWSHAPE_BASELINE:-$REPO_ROOT/scripts/.firewall-shape.sha256}"
BASE_REF="${BASE_REF:-origin/main}"

# Structural firewall lines: nft set declarations + the input-chain
# drop/accept rules + chain policies. Comments are stripped FIRST (so a
# comment that merely mentions a port can't churn the hash), then whitespace
# normalised (so reindentation isn't a "change").
#
# Notes:
#   - drop set names end in a digit (@blacklist_v4) → the set-ref class must
#     allow [a-z0-9_]+, not [a-z_]+ (which stops at the digit and matches
#     NOTHING — a dead pattern bug, code-review 2026-06-06).
#   - set declarations have NO `^[[:space:]]*` anchor: some live inside a
#     `local set_decls="  set tenant_ports_tcp {` assignment, so anchoring to
#     line-start would miss them.
firewall_shape() {
  sed -E 's/#.*$//' "$BOOTSTRAP" \
    | grep -E 'set (blacklist|crowdsec_blocklist|trusted_ranges|cluster_peers|tenant_ports)[a-z0-9_]* \{|saddr @[a-z0-9_]+ drop|dport [0-9]+ (accept|drop)|policy (drop|accept)|type filter hook' \
    | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//' \
    | grep -v '^$'
}

current_hash() { firewall_shape | sha256sum | awk '{print $1}'; }

case "${1:-}" in
  --print) firewall_shape; exit 0 ;;
  --update-baseline)
    current_hash > "$BASELINE"
    echo "ci-migration-coverage: baseline refreshed → $BASELINE ($(cat "$BASELINE"))"
    exit 0 ;;
esac

cur="$(current_hash)"
base="$(cat "$BASELINE" 2>/dev/null || echo "")"

if [[ "$cur" == "$base" ]]; then
  echo "ci-migration-coverage: firewall shape unchanged — OK."
  exit 0
fi

# Shape changed → require coverage. Signals are git-derived in CI, overridable
# in tests.
migration_added="${MIGRATION_ADDED:-$(git -C "$REPO_ROOT" diff --diff-filter=A --name-only "$BASE_REF"...HEAD -- 'platform/host-migrations/' 2>/dev/null | grep -E '/[0-9]+-[a-z0-9-]+\.sh$' | grep -vc '\.test\.sh$')}"
waiver="${WAIVER:-$(git -C "$REPO_ROOT" log "$BASE_REF"..HEAD --format=%B 2>/dev/null | grep -c '\[no-host-migration\]')}"
baseline_updated="${BASELINE_UPDATED:-$(git -C "$REPO_ROOT" diff --name-only "$BASE_REF"...HEAD -- "$BASELINE" 2>/dev/null | grep -c .)}"
# Coerce to integers (empty/non-numeric → 0).
migration_added=$(( migration_added + 0 )) 2>/dev/null || migration_added=0
waiver=$(( waiver + 0 )) 2>/dev/null || waiver=0
baseline_updated=$(( baseline_updated + 0 )) 2>/dev/null || baseline_updated=0

if (( waiver > 0 )); then
  echo "ci-migration-coverage: firewall shape changed; [no-host-migration] waiver present — allowed."
  # A waiver still must refresh the baseline so the NEXT PR starts clean.
  if (( baseline_updated == 0 )); then
    echo "::error::waiver requires refreshing the baseline: run scripts/ci-migration-coverage.sh --update-baseline and commit scripts/.firewall-shape.sha256" >&2
    exit 1
  fi
  exit 0
fi

if (( migration_added > 0 && baseline_updated > 0 )); then
  echo "ci-migration-coverage: firewall shape changed + host-migration added + baseline refreshed — OK."
  exit 0
fi

echo "::error::ci-migration-coverage: scripts/bootstrap.sh firewall shape changed but no host-migration backfills existing nodes." >&2
echo "  Existing clusters render the firewall ONCE at bootstrap — a change here will NOT reach them." >&2
echo "  Do ONE of:" >&2
echo "   1. Add platform/host-migrations/<next-version>/NNNN-name.sh that idempotently backfills the change," >&2
echo "      then refresh the baseline:  ./scripts/ci-migration-coverage.sh --update-baseline" >&2
echo "      and commit scripts/.firewall-shape.sha256." >&2
echo "   2. If existing nodes genuinely don't need it, add '[no-host-migration]' (with a reason) to a commit" >&2
echo "      message AND refresh the baseline as above." >&2
(( migration_added == 0 )) && echo "  (detected: no new host-migration in the diff)" >&2
(( baseline_updated == 0 )) && echo "  (detected: scripts/.firewall-shape.sha256 not refreshed in the diff)" >&2
exit 1
