#!/usr/bin/env bash
# ci-stalwart-config-drift.sh — guard against silent drift between
# k8s/base/stalwart/stalwart-config.toml (base) and
# k8s/overlays/production/stalwart/config-overrides.toml (production).
#
# Kustomize's configMapGenerator{behavior: merge} for file keys replaces
# the entire file content — it cannot deep-merge TOML inside a string
# field. The production overlay therefore carries a full copy of
# config.toml with production-only additions. This script detects when
# the two files diverge in sections that are NOT explicitly production-only,
# so the drift is caught at PR time rather than at production cutover.
#
# Usage:
#   bash scripts/ci-stalwart-config-drift.sh          # exits 0 on no drift
#   bash scripts/ci-stalwart-config-drift.sh --verbose # show section list
#
# Exit codes:
#   0 — no unexpected drift
#   1 — drift found in a section that is NOT in the allowlist
#
# Allowlist: scripts/stalwart-config-prod-allowed-divergence.txt
# One TOML section header per line (e.g. [certificate.default]).
# Sections in this file may diverge between base and production.
#
# No external deps beyond bash, grep, sort, diff (all standard on Debian/RHEL).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BASE="$REPO_ROOT/k8s/base/stalwart/stalwart-config.toml"
PROD="$REPO_ROOT/k8s/overlays/production/stalwart/config-overrides.toml"
ALLOWLIST="$SCRIPT_DIR/stalwart-config-prod-allowed-divergence.txt"

VERBOSE=0
[[ "${1:-}" == "--verbose" ]] && VERBOSE=1

fail() { echo "FAIL: $*" >&2; exit 1; }
log()  { [[ "$VERBOSE" == "1" ]] && echo "  $*" || true; }

[[ -f "$BASE" ]]      || fail "base config not found: $BASE"
[[ -f "$PROD" ]]      || fail "production config not found: $PROD"
[[ -f "$ALLOWLIST" ]] || fail "allowlist not found: $ALLOWLIST"

# Extract all [section.header] lines from a TOML file.
# Handles both [foo] and [foo.bar.baz] forms. Returns sorted, unique list.
extract_sections() {
  grep -E '^\[' "$1" | grep -v '^#' | sort -u
}

base_sections=$(extract_sections "$BASE")
prod_sections=$(extract_sections "$PROD")

# Load allowlist: strip blank lines and comment lines
allowed=$(grep -v '^[[:space:]]*#' "$ALLOWLIST" | grep -v '^[[:space:]]*$' | sort -u)

log "Base sections:"
while IFS= read -r s; do log "  $s"; done <<< "$base_sections"
log "Production sections:"
while IFS= read -r s; do log "  $s"; done <<< "$prod_sections"
log "Allowed-divergence sections:"
while IFS= read -r s; do log "  $s"; done <<< "$allowed"

# Find sections present in base but missing from production
missing_in_prod=$(comm -23 \
  <(echo "$base_sections") \
  <(echo "$prod_sections") \
  | grep -vxF -f <(echo "$allowed") || true)

if [[ -n "$missing_in_prod" ]]; then
  echo "DRIFT: the following sections are in BASE but missing from PRODUCTION"
  echo "       (and not in the allowed-divergence list):"
  echo "$missing_in_prod"
  echo ""
  echo "Fix: add the missing sections to:"
  echo "  $PROD"
  echo "Or, if the divergence is intentional, add the section to:"
  echo "  $ALLOWLIST"
  exit 1
fi

# Find sections present in production but missing from base
# (new production-only sections not yet allowed)
extra_in_prod=$(comm -13 \
  <(echo "$base_sections") \
  <(echo "$prod_sections") \
  | grep -vxF -f <(echo "$allowed") || true)

if [[ -n "$extra_in_prod" ]]; then
  echo "DRIFT: the following sections are in PRODUCTION but missing from BASE"
  echo "       (and not in the allowed-divergence list):"
  echo "$extra_in_prod"
  echo ""
  echo "Fix: either add the section to:"
  echo "  $BASE"
  echo "Or register it as production-only in:"
  echo "  $ALLOWLIST"
  exit 1
fi

echo "OK: no unexpected config drift between base and production stalwart config."
