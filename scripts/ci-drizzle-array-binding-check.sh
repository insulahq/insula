#!/usr/bin/env bash
#
# Reject `sql` templates that interpolate a JS ARRAY into a SQL operator that
# needs one.
#
# Why this guard exists
# --------------------
# `.where(sql`id = ANY(${ids})`)` looks right and is not. Drizzle expands an
# array in a template literal into one placeholder PER ELEMENT, so the query
# reaching Postgres is:
#
#     where id = ANY(($2, $3, $4, … $32))
#
# `($2, $3, …)` is a ROW CONSTRUCTOR, not an array, and Postgres rejects it.
#
# The failure is invisible in review and invisible to unit tests — a mocked db
# records the call and returns happily. It only appears against a real server,
# and then only if something reads the log: the caller in this repo was a
# scheduler whose tick is deliberately wrapped so a throw cannot kill the API,
# so the exception was caught, logged, and the feature silently did nothing
# while continuing to look alive. Escalation notifications fired repeatedly
# because the "already escalated" write was the statement that kept throwing.
#
# The fix is always drizzle's own helper — `inArray(col, ids)` / `notInArray` —
# which binds a real array parameter.
set -euo pipefail
cd "$(dirname "$0")/.."

# ANY/ALL/IN applied directly to an interpolated value inside a sql`` template.
#
# \b before IN so MIN(${x}) / COALESCE-style calls ending in "IN" do not match.
# sql.join(...) is the CORRECT idiom for expanding a list into placeholders, so
# an interpolation whose value starts with `sql.join` is excluded.
PATTERN='(\b(ANY|ALL|IN))[[:space:]]*\([[:space:]]*\$\{'

hits=$(grep -rnE "$PATTERN" --include='*.ts' backend/src packages 2>/dev/null \
  | grep -v '\.test\.ts:' \
  | grep -vE ':[[:space:]]*(//|\*|/\*)' \
  | grep -vE '\$\{sql\.join' \
  | grep -v 'allow-array-binding' || true)

if [ -n "$hits" ]; then
  echo "FAIL: a JS array interpolated into ANY()/ALL()/IN() inside a sql\`\` template."
  echo
  echo "$hits"
  echo
  echo "Drizzle expands the array into ANY((\$2, \$3, …)) — a row constructor, which"
  echo "Postgres rejects. Use inArray(column, ids) / notInArray(column, ids) instead."
  echo "If the interpolated value is genuinely a scalar or a subquery, append the"
  echo "comment marker 'allow-array-binding' on that line with a reason."
  exit 1
fi

echo "OK: no array-into-ANY/IN interpolation in sql\`\` templates."
