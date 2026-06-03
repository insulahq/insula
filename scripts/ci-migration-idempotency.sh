#!/usr/bin/env bash
# ci-migration-idempotency.sh — guard the W9 platform-migration registry's
# authoring discipline (ADR-045 §14): idempotent, self-contained, order-stable.
#
# Checks (fail the build on any violation):
#   1. Every migration file `migrations/NNNN_*.ts` (except index.ts) is
#      registered in `migrations/index.ts` (PLATFORM_MIGRATIONS) — and nothing
#      is registered that lacks a file. A migration that exists but isn't wired
#      in silently never runs.
#   2. Each migration's `id` field equals its filename (sans `.ts`). The id is
#      the order-stable contract; a mismatch means a rename slipped through.
#   3. Ids/prefixes are unique (no two migrations share a numeric prefix).
#   4. No forbidden DESTRUCTIVE raw SQL in a migration body — `DROP TABLE`,
#      `TRUNCATE`, `DROP COLUMN` (without `IF EXISTS`), or `DELETE FROM` without
#      a `WHERE`. Convergence migrations must be additive + idempotent.
#
# Reference: HOLISTIC_RELEASE_AND_UPGRADE_PLAN.md W9 + §14.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
MIG_DIR="$REPO_ROOT/backend/src/modules/platform-upgrades/migrations"
INDEX="$MIG_DIR/index.ts"

fail() { echo "  ✗ $1" >&2; FAILED=1; }
FAILED=0

if [[ ! -f "$INDEX" ]]; then
  echo "ci-migration-idempotency: registry index not found: $INDEX" >&2
  exit 1
fi

echo "ci-migration-idempotency: checking platform-migration registry..."

# Collect migration files (NNNN_*.ts), excluding index.ts. Filenames are a
# controlled charset (NNNN_name.ts) so a glob is safe + needs no `ls` parsing.
shopt -s nullglob
FILES=()
for path in "$MIG_DIR"/[0-9][0-9][0-9][0-9]_*.ts; do
  FILES+=("$(basename "$path")")
done
shopt -u nullglob
if [[ ${#FILES[@]} -gt 0 ]]; then
  mapfile -t FILES < <(printf '%s\n' "${FILES[@]}" | sort)
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "  (no migrations defined yet — registry is empty, OK)"
fi

declare -A SEEN_PREFIX
for f in "${FILES[@]}"; do
  base="${f%.ts}"
  path="$MIG_DIR/$f"
  prefix="${base%%_*}"

  # (0) filename charset — keep ids to [0-9a-z_] so the id is a safe literal in
  # the grep patterns below and the naming convention stays consistent.
  if [[ ! "$base" =~ ^[0-9a-z_]+$ ]]; then
    fail "$f has an out-of-charset name — migration ids must match [0-9a-z_] (got '$base')"
    continue
  fi

  # (3) unique numeric prefix
  if [[ -n "${SEEN_PREFIX[$prefix]:-}" ]]; then
    fail "duplicate migration prefix '$prefix' ($f and ${SEEN_PREFIX[$prefix]})"
  fi
  SEEN_PREFIX[$prefix]="$f"

  # (1) registered in index.ts (imported from './<base>.js')
  if ! grep -qE "from '\./${base}\.js'" "$INDEX"; then
    fail "$f is not imported in migrations/index.ts (it would never run)"
  fi

  # (2) id field equals the filename (sans .ts)
  if ! grep -qE "id:\s*'${base}'" "$path"; then
    fail "$f does not declare \`id: '${base}'\` (id must match the filename — order-stable contract)"
  fi

  # (4) forbidden destructive raw SQL
  if grep -qiE '\bDROP[[:space:]]+TABLE\b' "$path"; then
    fail "$f contains 'DROP TABLE' — convergence migrations must be additive"
  fi
  if grep -qiE '\bTRUNCATE\b' "$path"; then
    fail "$f contains 'TRUNCATE' — forbidden in a convergence migration"
  fi
  if grep -qiE '\bDROP[[:space:]]+COLUMN\b' "$path" && ! grep -qiE '\bDROP[[:space:]]+COLUMN[[:space:]]+IF[[:space:]]+EXISTS\b' "$path"; then
    fail "$f contains an unguarded 'DROP COLUMN' (use 'DROP COLUMN IF EXISTS' if truly needed)"
  fi
  # `DELETE FROM` present but no `WHERE` anywhere in the file (file-wide so a
  # multi-line `DELETE FROM x\n WHERE …` is not a false positive).
  if grep -qiE '\bDELETE[[:space:]]+FROM\b' "$path" && ! grep -qiE '\bWHERE\b' "$path"; then
    fail "$f contains a 'DELETE FROM' with no WHERE clause anywhere — refusing an unbounded delete"
  fi
done

# Reverse check: every './NNNN_*.js' import in index.ts has a matching file.
while IFS= read -r imported; do
  [[ -z "$imported" ]] && continue
  if [[ ! -f "$MIG_DIR/${imported}.ts" ]]; then
    fail "index.ts imports './${imported}.js' but $MIG_DIR/${imported}.ts does not exist"
  fi
done < <(grep -oE "from '\./[0-9][0-9][0-9][0-9]_[a-zA-Z0-9_]+\.js'" "$INDEX" | sed -E "s/from '\.\/(.*)\.js'/\1/")

if [[ "$FAILED" -ne 0 ]]; then
  echo "ci-migration-idempotency: FAILED" >&2
  exit 1
fi
echo "ci-migration-idempotency: OK (${#FILES[@]} migration(s) checked)"
