#!/usr/bin/env bash
# ci-db-isolation-check.sh — guard the database connection-isolation
# invariants (ROADMAP R36).
#
# The property: no database in the platform's CNPG cluster grants CONNECT to
# PUBLIC, so a per-service login role can authenticate into its own database
# and nothing else.
#
# Two writers carry the SQL, which is why this guard exists at all:
#   - backend/src/modules/db-isolation/sql.ts — the converger (source of truth)
#   - scripts/bootstrap.sh:harden_database_connect_acls — fresh installs
# Every other environment (local dev included) inherits the property from the
# converger, which re-applies it on boot and every 5 minutes.
#
# Four checks:
#   1. The converger's three statements are all present in sql.ts.
#   2. Both GRANTs precede the REVOKE. Ordering is the safety property: the
#      CNPG metrics exporter connects to EVERY database (the pg_extensions
#      collector carries `target_databases: ['*']` and its query calls
#      current_database()), so a sequence that revokes before granting leaves
#      a window with no path in — and a metrics break here is silent, moving
#      only cnpg_collector_last_collection_error while the pod stays Running.
#   3. bootstrap.sh carries the same three statements. A fresh install that
#      skipped the revoke would be open until platform-api first boots.
#   4. Neither writer revokes on a template database. Revoking on
#      template0/template1 propagates the ACL into every database created
#      afterwards — a far larger change than this one, and one that would
#      arrive silently in a much later install.
#
# Exits non-zero on any missing invariant. Reference: ROADMAP R36.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SQL_TS="$REPO_ROOT/backend/src/modules/db-isolation/sql.ts"
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"

fail() {
  echo "ci-db-isolation-check: FAIL — $1" >&2
  exit 1
}

[[ -f "$SQL_TS" ]] || fail "$SQL_TS not found"
[[ -f "$BOOTSTRAP" ]] || fail "$BOOTSTRAP not found"

GRANT_OWNER="GRANT CONNECT ON DATABASE %I TO %I', d.datname, d.owner"
GRANT_EXPORTER="GRANT CONNECT ON DATABASE %I TO %I', d.datname, 'cnpg_metrics_exporter'"
# sql.ts spells the exporter role through a constant, so the emitted SQL and the
# TypeScript source do not share a literal. Grepping the source for the emitted
# string would fail on correct code (and, worse, a later rename would keep
# passing while the two copies drifted). The byte-for-byte comparison of the
# EMITTED SQL against the bootstrap heredoc lives in sql.test.ts, where the
# built string is actually available; this guard checks the source-level shape.
GRANT_EXPORTER_TS="GRANT CONNECT ON DATABASE %I TO %I', d.datname, '\${METRICS_EXPORTER_ROLE}'"
REVOKE_PUBLIC="REVOKE CONNECT ON DATABASE %I FROM PUBLIC', d.datname"

# (1) the converger carries all three statements
for stmt in "$GRANT_OWNER" "$GRANT_EXPORTER_TS" "$REVOKE_PUBLIC"; do
  grep -qF -- "$stmt" "$SQL_TS" \
    || fail "sql.ts is missing the statement: $stmt"
done

# (2) ordering — both grants before the revoke, in BOTH builders.
#     Checked per-builder rather than over the whole file, because the shared
#     body means a whole-file check would pass on a file where one builder had
#     been rewritten by hand.
check_order() {
  local file="$1" label="$2" body="$3"
  local g_owner g_exporter revoke
  g_owner=$(printf '%s' "$body" | grep -nF -- "$GRANT_OWNER" | head -1 | cut -d: -f1 || true)
  g_exporter=$(printf '%s' "$body" | grep -nF -- "$4" | head -1 | cut -d: -f1 || true)
  revoke=$(printf '%s' "$body" | grep -nF -- "$REVOKE_PUBLIC" | head -1 | cut -d: -f1 || true)
  [[ -n "$g_owner" && -n "$g_exporter" && -n "$revoke" ]] \
    || fail "$label ($file): could not locate all three statements to order-check"
  [[ "$g_owner" -lt "$revoke" ]] \
    || fail "$label ($file): REVOKE FROM PUBLIC precedes the owner GRANT"
  [[ "$g_exporter" -lt "$revoke" ]] \
    || fail "$label ($file): REVOKE FROM PUBLIC precedes the metrics-exporter GRANT — this breaks CNPG metrics collection silently"
}

check_order "$SQL_TS" "converger" "$(cat "$SQL_TS")" "$GRANT_EXPORTER_TS"

# (3) bootstrap.sh carries the same three statements, in the same order.
#     Extract just the heredoc so an unrelated occurrence elsewhere in a
#     10k-line script cannot satisfy the check.
BOOTSTRAP_SQL=$(sed -n "/<<'DBISOSQL'/,/^DBISOSQL$/p" "$BOOTSTRAP")
[[ -n "$BOOTSTRAP_SQL" ]] \
  || fail "bootstrap.sh: the DBISOSQL heredoc (harden_database_connect_acls) is missing"

for stmt in "$GRANT_OWNER" "$GRANT_EXPORTER" "$REVOKE_PUBLIC"; do
  printf '%s' "$BOOTSTRAP_SQL" | grep -qF -- "$stmt" \
    || fail "bootstrap.sh DBISOSQL heredoc is missing the statement: $stmt"
done
check_order "$BOOTSTRAP" "bootstrap heredoc" "$BOOTSTRAP_SQL" "$GRANT_EXPORTER"

# (3b) the function is actually called — a guard that only checks the body
#      would pass on a bootstrap that defines it and never runs it.
grep -qE '^\s+harden_database_connect_acls\s*$' "$BOOTSTRAP" \
  || fail "bootstrap.sh defines harden_database_connect_acls but never calls it"

# (4) template databases are excluded by both writers
grep -qF 'datistemplate = false' "$SQL_TS" \
  || fail "sql.ts: the converger does not exclude template databases"
printf '%s' "$BOOTSTRAP_SQL" | grep -qF 'datistemplate = false' \
  || fail "bootstrap.sh DBISOSQL heredoc does not exclude template databases"

echo "ci-db-isolation-check: OK (converger + bootstrap agree; grants precede revoke; templates excluded)"
