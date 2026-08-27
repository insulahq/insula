#!/usr/bin/env bash
#
# CI guard: never test kubectl JSON output by grepping for "key":"value".
#
# `kubectl get -o json` PRETTY-PRINTS. Its output contains
#     "name": "platform-secrets-backup"
# with a space after the colon, so a guard written as
#     grep -q "\"name\":\"${cj}\""
# can never match. That is not a cosmetic bug: in
# platform/host-migrations/2026.8.18/0001-flux-strip-dr-cronjob-suspend.sh it
# made an "is this already applied?" check answer NO forever, so the
# `platform-ops host-config` converger appended a duplicate Flux patch on every
# enforce pass. Three passes later, kustomize failed the second
# `remove /spec/suspend` with "Unable to remove nonexistent key" and pinned the
# whole platform Kustomization at Ready=False — nothing reconciled at all
# (staging, 2026-08-27).
#
# The failure mode is nasty because it is SILENT and inverted: the script
# reports success while doing the opposite of converging. Idempotence that is
# only asserted by a string match against pretty-printed JSON is not asserted.
#
# Use a structural read instead — values come back unquoted and unspaced:
#     kubectl get ... -o jsonpath='{range .spec.patches[*]}{.target.name}{"\n"}{end}'
#     kubectl get ... -o jsonpath='{.metadata.name}'
# then match with `grep -qx`.
#
# Exits non-zero on violation. Wired into the Infrastructure CI workflow.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FAILED=0

# Files that shell out to kubectl and make convergence decisions.
mapfile -t TARGETS < <(
  find "${PROJECT_DIR}/platform/host-migrations" -name '*.sh' -type f 2>/dev/null
  printf '%s\n' "${PROJECT_DIR}/scripts/bootstrap.sh"
)

echo "▸ Scanning ${#TARGETS[@]} converger script(s) for JSON-text greps"

# Scoped deliberately to KUBECTL output. `helm list -o json` and HTTP/JMAP
# responses are compact (json.Marshal, no spaces), so a "key":"value" grep is
# correct against those and flagging them would be noise that gets the guard
# disabled. kubectl is the one that pretty-prints.
for f in "${TARGETS[@]}"; do
  [[ -f "$f" ]] || continue
  rel="${f#"${PROJECT_DIR}/"}"

  # Candidate: a grep / [[ =~ ]] test for  "word":"…  with NO space after the
  # colon. Comment lines are skipped so a file may still DOCUMENT the broken
  # pattern (this guard and the migration it came from both do).
  while IFS= read -r hit; do
    [[ -n "$hit" ]] || continue
    lineno="${hit%%:*}"
    text="${hit#*:}"

    # Which shell variable is being tested? Either piped in ($VAR | grep …)
    # or matched directly ([[ $VAR =~ … ]]).
    var=$(printf '%s' "$text" | grep -oE '\$\{?[A-Za-z_][A-Za-z0-9_]*\}?' | head -1 | tr -d '${}')

    kubectl_sourced=0
    if printf '%s' "$text" | grep -qE '(kubectl|kube )[^|]*\|[^|]*grep'; then
      # Direct pipe: kubectl … | grep '"k":"v"'
      kubectl_sourced=1
    elif [[ -n "$var" ]] && grep -qE "^[[:space:]]*(local[[:space:]]+)?${var}=\\\$\\(.*(kubectl|kube )" "$f"; then
      # Variable assigned from a kubectl/kube invocation somewhere in the file.
      kubectl_sourced=1
    fi

    if [[ "$kubectl_sourced" -eq 1 ]]; then
      echo "  ✗ ${rel}:${lineno} — grep of \"key\":\"value\" against kubectl JSON; kubectl emits \": \". Use -o jsonpath + grep -qx."
      FAILED=1
    fi
  done < <(grep -nE '^[^#]*(grep|=~)[^#]*\\?"[A-Za-z_][A-Za-z0-9_]*\\?"[[:space:]]*:[[:space:]]*\\?"' "$f" 2>/dev/null || true)
done

if [[ "$FAILED" -ne 0 ]]; then
  echo ""
  echo "ci-no-json-text-grep: FAILED — see the header of this script for the staging incident it encodes."
  exit 1
fi

echo "  ✓ no JSON-text greps found"
echo ""
echo "ci-no-json-text-grep: OK."
