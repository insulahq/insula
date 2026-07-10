#!/usr/bin/env bash
# scripts/vmtest/run-matrix.sh — multi-OS compatibility sweep.
#
# Runs the FULL throw-away integration flow once per OS, sequentially. Each OS gets
# its own run.sh invocation — a fresh cluster, fresh network, fresh teardown — so
# one OS failing or leaking can't affect the next (the same isolation principle as
# per-run teardown, applied across the matrix). This is what the container-based
# scripts/test-bootstrap-os-matrix.sh cannot do: a REAL boot + REAL bootstrap.sh
# per OS, then the real suite.
#
# Usage:  run-matrix.sh [os-id ...]        (default: VMTEST_OS_MATRIX from config)
#         run-matrix.sh -- --tier core     (args after -- pass through to run.sh)
#
# ⚠ UNTESTED until a VMTEST_DRIVER is enabled.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export VMTEST_CONFIG="${VMTEST_CONFIG:-$HERE/config.env}"
source "$VMTEST_CONFIG"
source "$HERE/lib/os-registry.sh"

OSES=(); PASSTHRU=()
while [[ $# -gt 0 ]]; do
  case "$1" in --) shift; PASSTHRU=("$@"); break ;; *) OSES+=("$1"); shift ;; esac
done
[[ ${#OSES[@]} -gt 0 ]] || read -ra OSES <<<"$VMTEST_OS_MATRIX"

echo "════ OS compatibility matrix: ${OSES[*]} ════"
declare -A RC
START=$(date +%s)
for os in "${OSES[@]}"; do
  os_known "$os" || { echo "skip unknown OS '$os'"; RC[$os]="unknown"; continue; }
  echo; echo "──────── OS: ${os} (tier $(os_tier "$os"), $(os_family "$os")) ────────"
  "$HERE/os-images.sh" "$os" || { RC[$os]="image-fail"; continue; }
  "$HERE/run.sh" --os "$os" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
  RC[$os]=$?
done

echo; echo "════ matrix summary (${SECONDS}s wall; started $(( $(date +%s)-START ))s ago) ════"
fails=0
for os in "${OSES[@]}"; do
  r="${RC[$os]:-?}"
  if [[ "$r" == "0" ]]; then printf '  \033[32mPASS\033[0m  %s\n' "$os"
  else printf '  \033[31mFAIL\033[0m  %-18s (rc=%s)\n' "$os" "$r"; fails=$((fails+1)); fi
done
echo "  ${fails}/${#OSES[@]} OS failed"
exit $(( fails > 0 ? 1 : 0 ))
