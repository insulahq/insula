#!/usr/bin/env bash
# ci-tenant-restore-policy-check.sh — fail CI when a sensitive column
# is added to the `tenants` table but not added to the
# tenant-restore-policy deny list.
#
# Why: a tenant restoring the `tenants` table from a bundle could
# overwrite billing fields (plan_id), operator-only quotas
# (*_override), placement decisions (node_name, region_id), or the
# is_system privilege flag. The policy module at
# `backend/src/modules/backup-restore/tenant-restore-policy.ts`
# redacts these on the tenant-cart execute path. But the deny list
# is hand-maintained — a new column shipped without policy update
# silently widens the attack surface.
#
# How: this script grep's tenants column names from schema.ts,
# matches them against a sensitive-pattern allowlist + an explicit
# allow-list of "safe to expose to a tenant", and reports any
# unclassified column.
#
# A typo in the policy module that doesn't match a real DB column
# (e.g. `max_subusers_override` vs the actual
# `max_sub_users_override`) is also caught — we cross-reference the
# deny list against real columns.
#
# Output: human-readable findings; exit 1 on any failure.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$ROOT/backend/src/db/schema.ts"
POLICY="$ROOT/backend/src/modules/backup-restore/tenant-restore-policy.ts"

if [[ ! -f "$SCHEMA" ]]; then
  echo "❌ schema.ts not found at $SCHEMA" >&2
  exit 2
fi
if [[ ! -f "$POLICY" ]]; then
  echo "❌ policy file not found at $POLICY" >&2
  exit 2
fi

# Extract `tenants` pgTable block. Two column patterns:
#   1. `name: type('snake_case', ...)`  — explicit DB name
#   2. `camelCase: enumName(),`         — implicit; Drizzle converts
#                                          camelCase → snake_case
TENANTS_BLOCK=$(sed -n "/^export const tenants = pgTable(/,/^}, (table) =>/p" "$SCHEMA")

# Pattern 1 — explicit snake_case argument.
EXPLICIT_COLUMNS=$(printf '%s\n' "$TENANTS_BLOCK" \
  | grep -oE "[a-zA-Z]+\('[_a-z0-9]+'" \
  | sed -E "s/.*'([_a-z0-9]+)'/\\1/" \
  | sort -u)

# Pattern 2 — implicit DB name (enums). Match `camelCase: enumNameEnum()`
# and convert the field name to snake_case.
IMPLICIT_COLUMNS=$(printf '%s\n' "$TENANTS_BLOCK" \
  | grep -oE "^[[:space:]]+[a-z][a-zA-Z0-9]*: [a-zA-Z]+Enum\(\)" \
  | sed -E "s/^[[:space:]]+([a-z][a-zA-Z0-9]*):.*/\\1/" \
  | sed -E "s/([a-z0-9])([A-Z])/\\1_\\2/g" \
  | tr 'A-Z' 'a-z' \
  | sort -u)

TENANTS_COLUMNS=$(printf '%s\n%s\n' "$EXPLICIT_COLUMNS" "$IMPLICIT_COLUMNS" | sort -u | grep -v '^$')

# Extract the 'tenants' deny-list entries from the policy file.
POLICY_BLOCK=$(sed -n "/'tenants', new Set/,/])],/p" "$POLICY")
DENIED_COLUMNS=$(printf '%s\n' "$POLICY_BLOCK" \
  | grep -oE "'[_a-z0-9]+'" \
  | sed -E "s/'([_a-z0-9]+)'/\\1/" \
  | grep -v '^tenants$' \
  | sort -u)

# Sensitive-pattern check: any column matching these patterns MUST
# be on the deny list unless explicitly allowed.
SENSITIVE_PATTERNS='_override$|_id$|^is_|_at$|^kubernetes_|^private_worker_|^provisioning_|^storage_lifecycle_|^active_storage_|^created_by$|^updated_at$|^email_send_rate_limit$|^storage_tier$'

# Explicit allow-list of columns that match a sensitive pattern but
# are SAFE for a tenant to restore (the tenant owns their own values).
# Anything not in the deny list AND not in this list AND matching a
# sensitive pattern is a failure.
declare -a ALLOWED_SENSITIVE=(
  # PKs the tenant must keep when restoring their own row.
  id
  # Lifecycle timestamps stamped by the lifecycle cascade — restoring
  # from a bundle to the same tenant means the cart was opened by
  # someone on the lifecycle path, so these are derivable from the
  # restored state and considered safe.
  # (Intentionally empty — we DO want all *_at denied.)
)

is_in_array() {
  local needle="$1"; shift
  local hay
  for hay in "$@"; do [[ "$hay" == "$needle" ]] && return 0; done
  return 1
}

is_denied() {
  local col="$1"
  while IFS= read -r d; do
    [[ "$d" == "$col" ]] && return 0
  done <<< "$DENIED_COLUMNS"
  return 1
}

EXIT=0

# 1. Cross-reference: every entry in the deny list must correspond
#    to a real `tenants` column.
echo "→ Cross-checking deny list against schema..."
while IFS= read -r col; do
  [[ -z "$col" ]] && continue
  if ! grep -qx "$col" <<< "$TENANTS_COLUMNS"; then
    echo "❌ Deny-list entry '$col' does NOT match any column in tenants table." >&2
    echo "   Likely typo. Check exact snake_case name in schema.ts:tenants." >&2
    EXIT=1
  fi
done <<< "$DENIED_COLUMNS"

# 2. Pattern check: every sensitive-looking column must be denied
#    OR explicitly allowed.
echo "→ Checking sensitive-pattern columns are denied..."
while IFS= read -r col; do
  [[ -z "$col" ]] && continue
  if [[ "$col" =~ $SENSITIVE_PATTERNS ]]; then
    if is_denied "$col"; then
      continue
    fi
    if is_in_array "$col" "${ALLOWED_SENSITIVE[@]}"; then
      continue
    fi
    echo "❌ Sensitive-looking column 'tenants.$col' is not in the deny list." >&2
    echo "   Add to DEFAULT_TENANT_RESTORE_POLICY.deniedColumnsByTable['tenants']" >&2
    echo "   in $POLICY," >&2
    echo "   or add to ALLOWED_SENSITIVE in this CI script if it is genuinely" >&2
    echo "   safe for a tenant to restore (with rationale in a comment)." >&2
    EXIT=1
  fi
done <<< "$TENANTS_COLUMNS"

if [[ "$EXIT" -eq 0 ]]; then
  echo "✓ ci-tenant-restore-policy-check OK"
fi
exit "$EXIT"
