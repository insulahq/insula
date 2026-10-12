#!/usr/bin/env bash
# ci-system-tenant-check.sh — guard against regressions in the SYSTEM
# tenant protection invariants (ADR-040).
#
# Three checks:
#   1. `subscriptions/expiry-checker.ts` MUST contain `eq(tenants.isSystem, false)`
#      in the candidate query. Without this filter, an operator who
#      hand-writes a past `subscription_expires_at` on SYSTEM via
#      direct SQL would see the auto-suspend cron flip SYSTEM to
#      suspended on the next tick.
#   2. `tenant-lifecycle/automation/real.ts` MUST contain
#      `eq(tenants.isSystem, false)` in the query that lists the tenants
#      in line for automatic archive (`status='suspended'`) and automatic
#      delete (`status='archived'`) — one function, `inLine`, serves both
#      steps of the sweep. Same reasoning as (1) — defense in depth against
#      direct SQL writes that would otherwise let the sweep pick up SYSTEM.
#   3. `backend/src/db/migrations/0008_system_tenant.sql` MUST contain
#      the partial unique index `tenants_only_one_system_idx`. This is
#      the DB-level "at most one SYSTEM row" enforcement — its accidental
#      removal in a future migration would let a buggy code path create
#      a second SYSTEM row.
#
# Exits non-zero on any missing invariant. Reference: ADR-040.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
EXPIRY="$REPO_ROOT/backend/src/modules/subscriptions/expiry-checker.ts"
SCHED="$REPO_ROOT/backend/src/modules/tenant-lifecycle/automation/real.ts"
MIGRATION="$REPO_ROOT/backend/src/db/migrations/0008_system_tenant.sql"

fail() {
  echo "ci-system-tenant-check: FAIL — $1" >&2
  exit 1
}

[[ -f "$EXPIRY" ]] || fail "$EXPIRY not found"
[[ -f "$SCHED" ]] || fail "$SCHED not found"
[[ -f "$MIGRATION" ]] || fail "$MIGRATION not found"

# (1) expiry-checker filter
if ! grep -q "eq(tenants.isSystem, false)" "$EXPIRY"; then
  fail "subscriptions/expiry-checker.ts is missing 'eq(tenants.isSystem, false)' (ADR-040 §3.5)"
fi

# (2) the sweep's "in line" query. The filter must sit INSIDE that query — the
# file filters SYSTEM in its status listing too, and that one protects nothing.
due_query=$(awk '/^async function inLine\(/{inq=1} inq{print} inq && /\.orderBy\(/{exit}' "$SCHED")
if [[ -z "$due_query" ]]; then
  fail "tenant-lifecycle/automation/real.ts no longer has the sweep's 'inLine' query where this guard reads it — update the guard with the code"
fi
if ! grep -q "eq(tenants.isSystem, false)" <<<"$due_query"; then
  fail "tenant-lifecycle/automation/real.ts: the sweep's 'inLine' query is missing 'eq(tenants.isSystem, false)' (automatic archive + delete would reach SYSTEM)"
fi
if ! grep -q "eq(tenants.status, status)" <<<"$due_query"; then
  fail "tenant-lifecycle/automation/real.ts: the sweep's 'inLine' query no longer filters by status — the guard cannot tell what it lists"
fi

# (3) migration index
if ! grep -q "tenants_only_one_system_idx" "$MIGRATION"; then
  fail "migration 0008 is missing the partial unique index 'tenants_only_one_system_idx'"
fi
if ! grep -q "WHERE.*is_system.*=.*TRUE" "$MIGRATION"; then
  fail "migration 0008 partial unique index is missing the 'WHERE is_system = TRUE' qualifier"
fi

echo "ci-system-tenant-check: OK (ADR-040 invariants intact)"
