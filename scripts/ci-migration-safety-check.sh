#!/usr/bin/env bash
#
# CI guard — a migration must survive contact with existing data, and must be
# safe to re-run from the top.
#
# Why this guard exists
# ---------------------
# Migration 0113 added a CHECK constraint asserting that every
# `notification_deliveries` row names a recipient. That is true of every row the
# code writes — and false of 164 of the 458 rows already on the DEV cluster,
# because `user_id` is ON DELETE SET NULL so the audit row outlives a GDPR
# erasure. ADD CONSTRAINT aborted and platform-api crash-looped.
#
# It got worse from there. `db/migrate.ts` executes each statement on its own,
# NOT inside a transaction, and records the file as applied only after all of
# them succeed. So the ADD COLUMN that preceded the failing constraint had
# already committed: the database was half-migrated, the tracker said the file
# had never run, and the next boot replayed it from the top.
#
# That combination — no transaction, replay from the top — makes two properties
# mandatory rather than merely tidy:
#
#   1. EVERY statement must be individually re-runnable.
#   2. NO statement may assert something about rows that already exist unless
#      it has been checked against them.
#
# What is checked
# ---------------
#   * ADD CONSTRAINT … CHECK without NOT VALID     (validates existing rows)
#   * ADD COLUMN … NOT NULL without DEFAULT        (fails on a non-empty table)
#   * ALTER COLUMN … SET NOT NULL                  (fails on existing NULLs)
#   * CREATE TABLE / CREATE INDEX / ADD COLUMN / DROP CONSTRAINT / CREATE TYPE
#     without the matching IF [NOT] EXISTS         (not replay-safe)
#
# An intentional exception is declared in the migration itself:
#
#   -- safety-reviewed: <why this is safe against existing rows>
#
# on the line before the statement. Use it sparingly and say what was checked.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIG_DIR="$REPO_ROOT/backend/src/db/migrations"

# Migrations already applied everywhere predate this guard. Only files at or
# after this number are checked — an older file cannot be made safe
# retroactively, and rewriting one would change its recorded sha256.
FIRST_GUARDED=111

fail=0
err() { printf 'FAIL: %s\n' "$*" >&2; fail=1; }

echo "── migration safety guard ───────────────────────────────────────────"

[ -d "$MIG_DIR" ] || { err "migrations directory not found: $MIG_DIR"; exit 1; }

checked=0
for f in "$MIG_DIR"/*.sql; do
  base="$(basename "$f")"
  num="${base%%_*}"
  # Strip leading zeros without tripping base-8 interpretation.
  num="$((10#${num}))" 2>/dev/null || continue
  [ "$num" -ge "$FIRST_GUARDED" ] || continue
  checked=$((checked + 1))

  # Match on STATEMENTS, not lines.
  #
  # The first version of this guard checked line by line and looked for
  # "add constraint" and "check" on the SAME line. The statement that actually
  # broke DEV spans three:
  #
  #   ALTER TABLE notification_deliveries
  #     ADD CONSTRAINT notification_deliveries_recipient_present
  #     CHECK (user_id IS NOT NULL OR ...);
  #
  # So the guard passed the exact bug it exists to catch. Statements are now
  # flattened first; `-- safety-reviewed:` markers are preserved into the
  # flattened text so an intentional exception still registers.
  flat="$(python3 - "$f" <<'PYEOF'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
out = []
for raw in src.split(';'):
    reviewed = 'safety-reviewed:' in raw
    # Drop comments, collapse whitespace.
    body = re.sub(r'--[^\n]*', ' ', raw)
    body = ' '.join(body.split())
    if not body:
        continue
    out.append(('reviewed ' if reviewed else '') + body.lower())
print('\n'.join(out))
PYEOF
)"

  while IFS= read -r stmt; do
    [ -n "$stmt" ] || continue
    case "$stmt" in "reviewed "*) continue ;; esac

    case "$stmt" in
      *"add constraint"*"check"*)
        case "$stmt" in *"not valid"*) ;; *)
          err "$base: ADD CONSTRAINT … CHECK without NOT VALID — it validates EVERY existing row."
          echo "     0113 did exactly this and aborted against 164 of 458 rows, crash-looping the API." >&2
          echo "     Add NOT VALID, enforce it at write time, or declare '-- safety-reviewed: …'." >&2
        ;; esac ;;
    esac
    case "$stmt" in
      *"set not null"*)
        err "$base: ALTER COLUMN … SET NOT NULL fails on any existing NULL. Backfill first, then declare '-- safety-reviewed: …'." ;;
    esac
    case "$stmt" in
      *"add column"*"not null"*)
        case "$stmt" in *default*) ;; *)
          err "$base: ADD COLUMN … NOT NULL without DEFAULT fails on a non-empty table." ;; esac ;;
    esac

    # Replay safety — the runner is NOT transactional, so a file that fails
    # midway re-runs from the top on the next boot.
    case "$stmt" in
      *"create table "*) case "$stmt" in *"if not exists"*) ;; *) err "$base: CREATE TABLE without IF NOT EXISTS — not replay-safe." ;; esac ;;
    esac
    case "$stmt" in
      *"create index "*|*"create unique index "*) case "$stmt" in *"if not exists"*|*concurrently*) ;; *) err "$base: CREATE INDEX without IF NOT EXISTS — not replay-safe." ;; esac ;;
    esac
    case "$stmt" in
      *"add column"*) case "$stmt" in *"if not exists"*) ;; *) err "$base: ADD COLUMN without IF NOT EXISTS — not replay-safe." ;; esac ;;
    esac
    case "$stmt" in
      *"drop constraint"*) case "$stmt" in *"if exists"*) ;; *) err "$base: DROP CONSTRAINT without IF EXISTS — not replay-safe." ;; esac ;;
    esac
    case "$stmt" in
      *"create type "*) case "$stmt" in *"if not exists"*) ;; *) err "$base: CREATE TYPE without IF NOT EXISTS — not replay-safe." ;; esac ;;
    esac
  done <<< "$flat"
done

if [ "$checked" -eq 0 ]; then
  err "checked ZERO migrations — the file filter matched nothing, so this guard would pass over anything."
  exit 1
fi

[ "$fail" -eq 0 ] || exit 1
echo "ci-migration-safety: OK — $checked migration(s) at or after $FIRST_GUARDED are replay-safe and assert nothing about existing rows."
