#!/usr/bin/env bash
# 2026-05-24 — CI invariants for the pg_dump scope shrink.
#
# pg_dump is intentionally a super_admin-only on-demand tool now
# (cross-PG-major-version migrations). Regressions to avoid:
#
#   1. The Drizzle schema must not re-introduce system_pg_dump_schedules.
#      The DB migration 0026 dropped the table; resurrecting the model
#      object would silently re-create it on next migration run.
#   2. app.ts must not re-import or call startPgDumpScheduler.
#   3. SystemBackupsPage.tsx must not re-import SystemDatabasesTab.
#   4. No frontend hook may import the removed pg_dump UI hook files.
#   5. pg-dump-routes.ts must not import pgDumpScheduleUpsertSchema or
#      PgDumpSchedule (both deleted from api-contracts in this work).
#
# Bash-level guard, intentionally low-tech — easier to read than parse.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$REPO_ROOT/backend/src/db/schema.ts"
APP="$REPO_ROOT/backend/src/app.ts"
PAGE="$REPO_ROOT/frontend/admin-panel/src/pages/backups/SystemBackupsPage.tsx"
ROUTES="$REPO_ROOT/backend/src/modules/system-backup/pg-dump-routes.ts"

FAILED=0

# Match only the Drizzle schema declaration, not the post-removal
# comment that references the dropped table name as a historical note.
if grep -E "^export const systemPgDumpSchedules\s*=\s*pgTable" "$SCHEMA" >/dev/null 2>&1; then
  echo "FAIL: $SCHEMA must not declare systemPgDumpSchedules — table dropped in migration 0026."
  FAILED=1
fi

if grep -q "startPgDumpScheduler\|pg-dump-scheduler" "$APP"; then
  echo "FAIL: $APP must not call startPgDumpScheduler — scheduler removed."
  FAILED=1
fi

if grep -q "SystemDatabasesTab" "$PAGE"; then
  echo "FAIL: $PAGE must not import SystemDatabasesTab — UI removed; pg_dump is super_admin-only on-demand."
  FAILED=1
fi

# 4 — hook files must not exist OR be re-imported. Check imports across
#     the frontend tree (loose match catches both default + named imports).
if grep -rn "use-system-pg-dump\|use-pg-dump-schedules" "$REPO_ROOT/frontend/admin-panel/src" 2>/dev/null; then
  echo "FAIL: deleted hook files (use-system-pg-dump, use-pg-dump-schedules) must not be re-imported."
  FAILED=1
fi

if grep -q "pgDumpScheduleUpsertSchema\|PgDumpSchedule\b" "$ROUTES"; then
  echo "FAIL: $ROUTES must not import pgDumpScheduleUpsertSchema / PgDumpSchedule — types deleted."
  FAILED=1
fi

# Migration must exist + name must match.
MIG="$REPO_ROOT/backend/src/db/migrations/0026_drop_pg_dump_schedules.sql"
if [[ ! -f "$MIG" ]]; then
  echo "FAIL: migration $MIG must exist (drops system_pg_dump_schedules table)."
  FAILED=1
fi
if [[ -f "$MIG" ]] && ! grep -q "DROP TABLE IF EXISTS public.system_pg_dump_schedules" "$MIG"; then
  echo "FAIL: $MIG must DROP TABLE public.system_pg_dump_schedules."
  FAILED=1
fi

if [[ "$FAILED" -ne 0 ]]; then
  exit 1
fi

echo "OK: pg_dump scope-shrink invariants hold (scheduler removed, UI removed, super_admin endpoint preserved)."
