#!/usr/bin/env bash
# ci-waf-scope-coverage-check.sh — every WAF exclusion scope in the shared
# contract must be selectable in BOTH panels, and neither panel may re-declare
# the scope union locally.
#
# WHY: 2026-08-31 an operator whitelisted a WAF rule and reported "UNBLOCKING
# VIA WHITELIST HAS NO EFFECT". The exclusion saved, reconciled, and was present
# in the running modsec container — and did nothing. Both panels defaulted to
# and *recommended* `args_names_only`, which emits
# `ctl:ruleRemoveTargetById=<id>;ARGS_NAMES`. That removes the parameter NAMES
# target only, so for the rules that actually false-positive on ordinary traffic
# (930120 and 932160 match parameter VALUES against lfi-os-files.data /
# unix-shell.data) it removes nothing at all. The only working scope was
# `full_disable`, so the safe-looking choice was the broken one.
#
# The fix added an `args` scope. This guard keeps the UI honest about the
# contract: adding a scope to the Zod enum and forgetting to offer it in a
# panel is silent — the enum value simply becomes unreachable for operators.
# Both panels also used to declare `'args_names_only' | 'full_disable'` as a
# local literal, which drifts from the contract without a type error.
#
# Exit: 0 clean · 1 a scope is missing from a panel, or a local union survives
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTRACT="packages/api-contracts/src/waf-rule-exclusions.ts"
ADMIN="frontend/admin-panel/src/components/security/web-defense-tabs.tsx"
TENANT="frontend/tenant-panel/src/pages/RouteDetail.tsx"
fail=0

cd "$ROOT" || exit 1

for f in "$CONTRACT" "$ADMIN" "$TENANT"; do
  if [ ! -f "$f" ]; then
    echo "ci-waf-scope-coverage: missing $f (moved? update this guard)" >&2
    exit 1
  fi
done

# 1) Extract the scope values from the Zod enum in the contract.
#    e.g.  z.enum(['args', 'args_names_only', 'full_disable'])
enum_line="$(grep -n "wafRuleExclusionScopeSchema" "$CONTRACT" | grep "z.enum" | head -1)"
if [ -z "$enum_line" ]; then
  echo "ci-waf-scope-coverage: could not find a z.enum for wafRuleExclusionScopeSchema in $CONTRACT" >&2
  exit 1
fi
scopes="$(printf '%s\n' "$enum_line" | grep -o "'[a-z_]*'" | tr -d "'")"
if [ -z "$scopes" ]; then
  echo "ci-waf-scope-coverage: parsed zero scopes out of: $enum_line" >&2
  exit 1
fi

# 2) Every scope must appear as a selectable <option> in both panels.
for scope in $scopes; do
  for panel in "$ADMIN" "$TENANT"; do
    if ! grep -q "<option value=\"$scope\"" "$panel"; then
      echo "ci-waf-scope-coverage: scope '$scope' is in the contract but has no <option value=\"$scope\"> in $panel" >&2
      echo "  → operators cannot choose it; add the option or remove the scope from the contract." >&2
      fail=1
    fi
  done
done

# 3) Neither panel may re-declare the union locally — it must come from
#    @insula/api-contracts so a contract change is a compile error, not a drift.
for panel in "$ADMIN" "$TENANT" "frontend/tenant-panel/src/hooks/use-route-settings.ts"; do
  if grep -qE "'args_names_only'[[:space:]]*\|[[:space:]]*'full_disable'" "$panel"; then
    echo "ci-waf-scope-coverage: $panel re-declares the scope union locally" >&2
    echo "  → import { WafRuleExclusionScope } from '@insula/api-contracts' instead." >&2
    fail=1
  fi
done

# 4) The renderer must emit a real ARGS removal for the value-matching case.
#    A scope that only ever emits ARGS_NAMES is the original bug.
RENDERER="backend/src/modules/waf-rule-exclusions/renderer.ts"
if ! grep -q "ruleRemoveTargetById=\${exclusion.ruleId};ARGS," "$RENDERER"; then
  echo "ci-waf-scope-coverage: $RENDERER never emits a bare ;ARGS target removal" >&2
  echo "  → rules matching parameter VALUES (930120, 932160) need ARGS, not just ARGS_NAMES." >&2
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "ci-waf-scope-coverage: OK ($(printf '%s' "$scopes" | wc -w) scopes offered in both panels)"
fi
exit "$fail"
