#!/usr/bin/env bash
# ci-integration-coverage.sh — fail if any scripts/integration-*.sh is an
# unregistered orphan. Every integration script MUST appear in
# scripts/integration-test-registry.txt with a category; suites must actually be
# wired into their orchestrator. Prevents the integration-test sprawl that let
# ~half the E2E scripts rot unrun (2026-06-30 audit).
set -euo pipefail
cd "$(dirname "$0")/.."
REG=scripts/integration-test-registry.txt
[[ -f "$REG" ]] || { echo "FAIL: $REG missing"; exit 1; }

fail=0
declare -A CAT
while read -r cat script _rest; do
  [[ -z "${cat:-}" || "${cat:0:1}" == "#" ]] && continue
  CAT["$script"]="$cat"
done < <(grep -vE '^[[:space:]]*#|^[[:space:]]*$' "$REG")

# 1. every on-disk integration-*.sh must be registered (no silent new orphans)
for f in scripts/integration-*.sh; do
  b=$(basename "$f")
  if [[ -z "${CAT[$b]:-}" ]]; then
    echo "ORPHAN: $b is not in $REG"
    echo "        → register it (suite/suite-staging/helper/manual/perf/local/pending) or delete it."
    fail=1
  fi
done

# 2. every registry entry must point at a real file (no stale rows)
for b in "${!CAT[@]}"; do
  [[ -f "scripts/$b" ]] || { echo "STALE: $b is registered but the file is gone — drop the row (or move it to the retired tombstone block)."; fail=1; }
done

# 3. 'suite' / 'suite-staging' must actually be referenced by their orchestrator
for b in "${!CAT[@]}"; do
  case "${CAT[$b]}" in
    suite)         grep -qF "$b" scripts/integration-all.sh     || { echo "UNWIRED: $b is 'suite' but not referenced in integration-all.sh";     fail=1; } ;;
    suite-staging) grep -qF "$b" scripts/integration-staging.sh || { echo "UNWIRED: $b is 'suite-staging' but not referenced in integration-staging.sh"; fail=1; } ;;
  esac
done

echo "── integration-test registry ──"
for c in orchestrator suite suite-staging helper manual perf local pending; do
  n=$(printf '%s\n' "${CAT[@]:-}" | grep -cx "$c" || true)
  printf '  %-14s %s\n' "$c" "$n"
done
pend=$(printf '%s\n' "${CAT[@]:-}" | grep -cx pending || true)
if [[ $fail -eq 0 ]]; then
  echo "ci-integration-coverage: OK — ${#CAT[@]} scripts registered, $pend pending integration (backlog in $REG)."
else
  echo "ci-integration-coverage: FAIL — register or remove the scripts above."
  exit 1
fi
