#!/bin/bash
# ci-frontend-api-types-check.sh — ratchet on hand-written API request types in
# frontend hooks.
#
# AGENTS.md: "ALL API types MUST live in @insula/api-contracts ... Never define
# API types locally." A frontend hook that declares its own request interface is
# internally consistent by construction, so tsc can never see it drift from the
# backend. It is not a style problem — it is a class of silent breakage:
#
#   0000_tenant_rename.sql bulk-renamed oidc_providers.client_id -> tenant_id by
#   mistake. 0001_rename_oidc_client_id.sql reverted the column AND the backend.
#   The admin panel's own `CreateProviderInput` kept tenant_id / tenant_secret.
#   Nothing failed to compile, and adding an OIDC provider was impossible:
#   POST 400'd, and PATCH returned 200 while silently not writing the client id
#   or secret. Shipped, and found by an operator.
#
# There are dozens of these already. Migrating them all is a large refactor, so
# this guard RATCHETS: the count per file may go down, never up, and a new file
# may not introduce one. New code uses the shared contract; existing code is
# grandfathered until someone migrates it (which the baseline then records).
#
# To migrate one:
#   1. Move the shape to packages/api-contracts/src/<domain>.ts as a Zod schema.
#   2. Backend parses request.body with it (safeParse, not a truthiness check).
#   3. The hook does `type XInput = z.infer<typeof schema>` — no field names.
#   4. Re-run with --update-baseline.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BASELINE="scripts/.frontend-api-types-baseline.txt"
PATTERN='^(export )?(interface|type) [A-Za-z]*(Input|Request|Payload)[[:space:]]*[{=]'

current() {
  # `type X = SomethingImported;` is the migrated form — an alias, no field
  # names of its own — so it is not counted.
  for f in $(git ls-files 'frontend/*/src/hooks/*.ts' | sort); do
    n=$(grep -cE "$PATTERN" "$f" 2>/dev/null || true)
    n=${n:-0}
    aliases=$(grep -cE '^(export )?type [A-Za-z]*(Input|Request|Payload) = [A-Z][A-Za-z]*;' "$f" 2>/dev/null || true)
    aliases=${aliases:-0}
    n=$((n - aliases))
    [ "$n" -gt 0 ] && echo "$f $n"
  done
  true
}

if [ "${1:-}" = "--update-baseline" ]; then
  current > "$BASELINE"
  echo "baseline updated: $(wc -l < "$BASELINE") file(s), $(awk '{s+=$2} END{print s+0}' "$BASELINE") type(s)"
  exit 0
fi

echo "── frontend API-type ratchet ───────────────────────────────────────"

if [ ! -f "$BASELINE" ]; then
  echo "  FAIL: $BASELINE is missing — the guard cannot pass without it." >&2
  exit 1
fi

fail=0
now=$(current)
while read -r file count; do
  [ -z "$file" ] && continue
  was=$(awk -v f="$file" '$1==f {print $2}' "$BASELINE")
  was=${was:-0}
  if [ "$count" -gt "$was" ]; then
    echo "  FAIL: $file declares $count hand-written API request type(s), baseline $was" >&2
    fail=1
  fi
done <<< "$now"

total_now=$(echo "$now" | awk '{s+=$2} END{print s+0}')
total_was=$(awk '{s+=$2} END{print s+0}' "$BASELINE")

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'
── frontend API-type ratchet: FAILED ───────────────────────────────
A hook that declares its own request shape cannot be checked against the
backend by tsc — the type and the caller agree with each other and with
nothing else. Define it in packages/api-contracts and infer:

    import type { CreateXInput } from '@insula/api-contracts';

If you deliberately removed types elsewhere, re-run with --update-baseline.
MSG
  exit 1
fi

echo "  $total_now hand-written request type(s) across $(echo "$now" | grep -c . || true) file(s) (baseline $total_was)"
if [ "$total_now" -lt "$total_was" ]; then
  echo "  ratchet moved: $((total_was - total_now)) fewer than baseline — run --update-baseline to lock it in"
fi
echo "ci-frontend-api-types: OK — no new hand-written API request types."
