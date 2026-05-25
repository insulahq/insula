#!/usr/bin/env bash
# ci-config-dump-restore-parity.sh — fail CI when a table is dumped to a
# bundle but cannot be restored from one (or vice versa).
#
# Why: the config-dump side (CONFIG_DUMP_TABLES in
# tenant-bundles/components/config.ts) and the restore side
# (ALLOWED_TABLE_TO_SQL in backup-restore/executors/config-tables.ts)
# are two hand-maintained lists. A table added to the dump but missing
# from the restore allow-list silently breaks restore for that table
# ("table 'X' is not in the restore allow-list") only at runtime, when
# the operator clicks Restore from a bundle that already contains the
# row. That's how `tenantCertificates` was found in production.
#
# How: extract the camelCase names from each list and demand the dump
# side is a subset of the restore side (restore may also contain extra
# allow-list entries for executor-internal tables — that's fine).
#
# Output: human-readable list of tables that appear in CONFIG_DUMP_TABLES
# but are missing from ALLOWED_TABLE_TO_SQL. The canonical fix-it line
# is `tableNameCamel: 'table_name_snake',` in config-tables.ts.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DUMP_SRC="$ROOT/backend/src/modules/tenant-bundles/components/config.ts"
RESTORE_SRC="$ROOT/backend/src/modules/backup-restore/executors/config-tables.ts"

if [[ ! -f "$DUMP_SRC" ]]; then
  echo "❌ ci-config-dump-restore-parity: $DUMP_SRC not found" >&2
  exit 2
fi
if [[ ! -f "$RESTORE_SRC" ]]; then
  echo "❌ ci-config-dump-restore-parity: $RESTORE_SRC not found" >&2
  exit 2
fi

# 1. CONFIG_DUMP_TABLES — camelCase string array.
DUMP_TABLES=$(awk '
  /^export const CONFIG_DUMP_TABLES = \[/ { in_arr=1; next }
  in_arr && /^\s*\] as const;/ { in_arr=0 }
  in_arr {
    line=$0
    sub(/[ \t]*\/\/.*$/, "", line)
    gsub(/[ \t,'"'"']/, "", line)
    if (line != "" && line !~ /^\/\//) print line
  }
' "$DUMP_SRC" | sort -u)

# 2. ALLOWED_TABLE_TO_SQL — extract keys from the record literal.
#    grep + sed (portable; avoids gawk-only match() with captures).
RESTORE_TABLES=$(awk '
  /export const ALLOWED_TABLE_TO_SQL: Record<string, string> = \{/ { in_arr=1; next }
  in_arr && /^\};/ { in_arr=0 }
  in_arr { print }
' "$RESTORE_SRC" \
  | sed -E 's#[ \t]*//.*$##' \
  | sed -nE 's/^[ \t]*([a-zA-Z0-9_]+):.*/\1/p' \
  | sort -u)

# 3. Tables dumped but not restorable.
MISSING=$(comm -23 <(echo "$DUMP_TABLES") <(echo "$RESTORE_TABLES"))

echo "── ci-config-dump-restore-parity ──"
echo "  CONFIG_DUMP_TABLES:    $(echo "$DUMP_TABLES" | wc -l)"
echo "  ALLOWED_TABLE_TO_SQL:  $(echo "$RESTORE_TABLES" | wc -l)"

if [[ -z "$MISSING" ]]; then
  echo "✅ Every dumped table can be restored."
  exit 0
fi

echo
echo "❌ Tables present in CONFIG_DUMP_TABLES but MISSING from"
echo "   ALLOWED_TABLE_TO_SQL — these rows would be written to every"
echo "   tenant bundle but rejected by the restore executor at runtime:"
echo
while IFS= read -r t; do
  # snake_case guess for the operator (correct ~95% of the time).
  snake=$(echo "$t" | sed -E 's/([A-Z])/_\L\1/g')
  echo "      - $t  → fix: add  $t: '$snake',  to ALLOWED_TABLE_TO_SQL"
done <<<"$MISSING"
echo
echo "Fix-it file: $RESTORE_SRC"
exit 1
