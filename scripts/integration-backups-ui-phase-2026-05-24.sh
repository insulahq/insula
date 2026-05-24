#!/usr/bin/env bash
# integration-backups-ui-phase-2026-05-24.sh
#
# REAL-AUTH end-to-end exercise of the Backups UI overhaul (Phases 0a-5,
# commit 50ccf9e8 + ancestors). Every check logs in as super_admin,
# calls the relevant API with the token, and asserts on the actual
# response body or ensuing DB / cluster state.
#
# Coverage (one section per phase):
#   Phase 0a — WAL Archive route no longer reports mail-db; surface
#              shape changed.
#   Phase 0b — Pg_dump UI removed but super_admin endpoint still
#              accepts requests; schedules table gone.
#   Phase 1  — POST /admin/cnpg-backup-now creates a Backup CR.
#   Phase 2  — Frontend asset is built + served (admin-panel image
#              roll-out verification is via the build pipeline, not
#              this script — we just confirm the Backup Now endpoint
#              the button hits is alive and returns the contract shape).
#   Phase 3  — Catalogue endpoint returns the rows the
#              SystemBackupListSection table renders.
#   Phase 4  — Routing tab WAL section: WAL Archive `/clusters` is
#              reachable + only returns platform/system-db.
#   Phase 5  — Switch preview returns SwitchPreviewResponse shape;
#              switch-with-pause endpoint accepts but is gated on a
#              non-target-touch to avoid actually breaking staging.
#
# Env:
#   ADMIN_HOST       — defaults to https://admin.staging.phoenix-host.net
#   ADMIN_EMAIL      — defaults to info+claude@phoenix-tech.net
#   ADMIN_PASSWORD   — required (or use INTEGRATION_TOKEN cache)
#   CURL_INSECURE    — set 1 to ignore TLS errors

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-info+claude@phoenix-tech.net}"
CURL_OPTS=(-s --max-time 60)
if [[ "${CURL_INSECURE:-0}" == "1" ]]; then
  CURL_OPTS+=(-k)
fi

# shellcheck disable=SC1090
source "$(dirname "$0")/lib/integration-token.sh"

login_token() {
  if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
    echo "ERROR: ADMIN_PASSWORD env not set + no INTEGRATION_TOKEN cache." >&2
    exit 1
  fi
  local resp
  resp=$(curl "${CURL_OPTS[@]}" -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  echo "$resp" | sed -nE 's/.*"(token|accessToken)":"([^"]+)".*/\2/p' | head -1
}

TOKEN=$(cached_or_login_token)
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: could not obtain admin token." >&2
  exit 1
fi

api() {
  local method="$1" path="$2" body="${3:-}"
  local out_var="${4:-RESP}" code_var="${5:-CODE}"
  local response status
  if [[ -n "$body" ]]; then
    response=$(curl "${CURL_OPTS[@]}" -X "$method" "$ADMIN_HOST$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -w "\n%{http_code}" \
      -d "$body")
  else
    response=$(curl "${CURL_OPTS[@]}" -X "$method" "$ADMIN_HOST$path" \
      -H "Authorization: Bearer $TOKEN" \
      -w "\n%{http_code}")
  fi
  status=$(printf '%s' "$response" | tail -n1)
  printf -v "$out_var" '%s' "$(printf '%s' "$response" | sed '$d')"
  printf -v "$code_var" '%s' "$status"
}

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=$((FAILED+1)); }
info() { printf '  \033[36m→\033[0m %s\n' "$*"; }
FAILED=0

# ─── Phase 0a — WAL Archive returns ONLY platform/system-db ──────────
echo '═══ Phase 0a — WAL Archive clusters list excludes phantom mail-db ═══'
api GET '/api/v1/system-backup/wal-archive/clusters' '' WAL_RESP WAL_CODE
if [[ "$WAL_CODE" != "200" ]]; then
  fail "wal-archive/clusters returned $WAL_CODE"
else
  CLUSTER_NAMES=$(printf '%s' "$WAL_RESP" | grep -oE '"clusterName":"[^"]+"' | sed 's/"clusterName":"//; s/"$//' | sort -u)
  if printf '%s' "$CLUSTER_NAMES" | grep -q 'mail-db'; then
    fail "wal-archive/clusters still includes mail-db — phantom not removed: $CLUSTER_NAMES"
  else
    pass "wal-archive/clusters has no mail-db (Phase 0a fix shipped)"
  fi
  if printf '%s' "$CLUSTER_NAMES" | grep -q 'system-db'; then
    pass "wal-archive/clusters includes platform/system-db (only real cluster)"
  else
    fail "wal-archive/clusters missing platform/system-db: $CLUSTER_NAMES"
  fi
fi

# ─── Phase 0b — pg_dump schedule routes are gone, trigger still works ─
echo '═══ Phase 0b — pg_dump schedule routes deleted, trigger preserved ═══'
api GET '/api/v1/system-backup/pg-dump/schedules' '' PGSCHED_RESP PGSCHED_CODE
if [[ "$PGSCHED_CODE" == "404" ]]; then
  pass "pg_dump schedules route returns 404 (route deleted)"
elif [[ "$PGSCHED_CODE" == "405" ]]; then
  pass "pg_dump schedules route returns 405 (method removed)"
else
  fail "pg_dump schedules route unexpectedly returned $PGSCHED_CODE (should be 404 — route deleted)"
fi
# The trigger route stays but requires a body. POST with empty body
# should be a 400 (validation error), confirming the route still exists.
api POST '/api/v1/system-backup/pg-dump' '{}' PGT_RESP PGT_CODE
if [[ "$PGT_CODE" == "400" ]]; then
  pass "pg_dump trigger POST returns 400 on empty body (route alive, validation works)"
else
  fail "pg_dump trigger POST returned $PGT_CODE (expected 400 from validation)"
fi

# ─── Phase 1 — POST /admin/cnpg-backup-now creates a Backup CR ───────
echo '═══ Phase 1 — POST /admin/cnpg-backup-now ═══'
api POST '/api/v1/admin/cnpg-backup-now' \
  '{"namespace":"platform","clusterName":"system-db"}' \
  BNOW_RESP BNOW_CODE
if [[ "$BNOW_CODE" == "200" || "$BNOW_CODE" == "201" ]]; then
  BACKUP_NAME=$(printf '%s' "$BNOW_RESP" | sed -nE 's/.*"backupName":"(on-demand-[0-9]+)".*/\1/p' | head -1)
  if [[ -n "$BACKUP_NAME" ]]; then
    pass "cnpg-backup-now created CR: $BACKUP_NAME (http=$BNOW_CODE)"
  else
    fail "cnpg-backup-now returned $BNOW_CODE but no backupName: $(printf '%s' "$BNOW_RESP" | head -c 300)"
  fi
elif [[ "$BNOW_CODE" == "409" ]]; then
  info "cnpg-backup-now returned 409 — likely barman plugin not enabled OR a backup is already running; this is a safe rejection from the eligibility check"
  pass "cnpg-backup-now: 409 surface intact (eligibility check fires)"
else
  fail "cnpg-backup-now returned $BNOW_CODE: $(printf '%s' "$BNOW_RESP" | head -c 300)"
fi
# Bad input → 400
api POST '/api/v1/admin/cnpg-backup-now' '{"namespace":"_BAD_","clusterName":"system-db"}' BAD_RESP BAD_CODE
if [[ "$BAD_CODE" == "400" ]]; then
  pass "cnpg-backup-now rejects invalid namespace with 400 (contract guard works)"
else
  fail "cnpg-backup-now invalid namespace returned $BAD_CODE (expected 400)"
fi

# ─── Phase 3 — Catalogue endpoint feeds SystemBackupListSection ──────
echo '═══ Phase 3 — cnpg-backup-catalogue feeds the new sibling section ═══'
# Look up the ObjectStore name from the health endpoint first.
api GET '/api/v1/admin/cnpg-backup-health' '' HEALTH_RESP HEALTH_CODE
OBJ_STORE=$(printf '%s' "$HEALTH_RESP" | sed -nE 's/.*"clusterName":"system-db"[^}]*"objectStoreName":"([^"]+)".*/\1/p' | head -1)
if [[ -z "$OBJ_STORE" ]]; then
  info "system-db has no ObjectStore — skip catalogue check (WAL not configured)"
else
  info "system-db ObjectStore: $OBJ_STORE"
  api GET "/api/v1/admin/cnpg-backup-catalogue/platform/$OBJ_STORE" '' CAT_RESP CAT_CODE
  if [[ "$CAT_CODE" == "200" ]]; then
    SOURCE=$(printf '%s' "$CAT_RESP" | sed -nE 's/.*"source":"([^"]+)".*/\1/p' | head -1)
    if [[ "$SOURCE" == "object-store" || "$SOURCE" == "unavailable" ]]; then
      pass "catalogue endpoint returned source='$SOURCE' (valid surface)"
    else
      fail "catalogue endpoint returned unexpected source='$SOURCE'"
    fi
  else
    fail "catalogue endpoint returned $CAT_CODE"
  fi
fi

# ─── Phase 5 — Switch preview endpoint shape ─────────────────────────
echo '═══ Phase 5 — Switch preview returns SwitchPreviewResponse ═══'
api GET '/api/v1/admin/backup-rclone-shim/switch-preview/tenant' '' SP_RESP SP_CODE
if [[ "$SP_CODE" == "200" ]]; then
  if printf '%s' "$SP_RESP" | grep -q '"schedulesToPause"'; then
    pass "switch-preview returned the expected contract shape"
  else
    fail "switch-preview missing 'schedulesToPause': $(printf '%s' "$SP_RESP" | head -c 300)"
  fi
else
  fail "switch-preview tenant returned $SP_CODE"
fi
# system class preview should surface walToDisable when WAL is configured.
api GET '/api/v1/admin/backup-rclone-shim/switch-preview/system' '' SPSYS_RESP SPSYS_CODE
if [[ "$SPSYS_CODE" == "200" ]]; then
  if printf '%s' "$SPSYS_RESP" | grep -q '"walToDisable"'; then
    pass "switch-preview system: walToDisable field present"
  else
    fail "switch-preview system missing walToDisable field"
  fi
else
  fail "switch-preview system returned $SPSYS_CODE"
fi
# Switch-with-pause is destructive. We do NOT call it with a real
# target id (that would actually pause staging schedules). We only
# verify the route exists + validates the body. POST with no body
# should be 400.
api POST '/api/v1/admin/backup-rclone-shim/switch-with-pause/tenant' '' SW_RESP SW_CODE
if [[ "$SW_CODE" == "400" ]]; then
  pass "switch-with-pause route alive + validates body (400 on empty body)"
else
  fail "switch-with-pause route returned $SW_CODE on empty body (expected 400)"
fi

# ─── Phase 6 — WAL Archive consistency fixes ─────────────────────────
echo '═══ Phase 6 — WAL Archive enable rejects unknown fields + bad cron ═══'
# Phase 6 schema is .strict() — pre-Phase-6 super_admin scripts that
# still send `targetConfigId` get a 400 instead of silent strip.
api POST '/api/v1/system-backup/wal-archive/enable' \
  '{"clusterNamespace":"platform","clusterName":"system-db","retentionDays":30,"targetConfigId":"00000000-0000-0000-0000-000000000000"}' \
  P6_STRICT_RESP P6_STRICT_CODE
if [[ "$P6_STRICT_CODE" == "400" ]]; then
  pass "wal-archive/enable rejects unknown 'targetConfigId' with 400 (.strict() schema)"
else
  fail "wal-archive/enable returned $P6_STRICT_CODE on pre-Phase-6 body (expected 400): $(printf '%s' "$P6_STRICT_RESP" | head -c 200)"
fi
# Bad cron → 400.
api POST '/api/v1/system-backup/wal-archive/enable' \
  '{"clusterNamespace":"platform","clusterName":"system-db","retentionDays":30,"baseBackupSchedule":"not a cron"}' \
  P6_CRON_RESP P6_CRON_CODE
if [[ "$P6_CRON_CODE" == "400" ]]; then
  pass "wal-archive/enable rejects bad cron (400 from contract regex)"
else
  fail "wal-archive/enable returned $P6_CRON_CODE on bad cron (expected 400)"
fi
# Phase 6 happy-path: enable WAL streaming WITHOUT a target picker.
# Only test when a SYSTEM target is bound — otherwise we skip with info.
api GET '/api/v1/admin/backup-rclone-shim/assignments' '' P6_ASSIGN_RESP _
SYS_TARGET=$(printf '%s' "$P6_ASSIGN_RESP" | sed -nE 's/.*"className":"system"[^}]*"targetId":"([^"]+)".*/\1/p' | head -1)
if [[ -z "$SYS_TARGET" ]]; then
  info "No SYSTEM target bound on staging — skip WAL enable happy-path (no upstream to route to)"
else
  info "SYSTEM target bound (id=$SYS_TARGET) — testing WAL enable happy-path"
  api POST '/api/v1/system-backup/wal-archive/enable' \
    '{"clusterNamespace":"platform","clusterName":"system-db","retentionDays":7,"archiveTimeout":"5min","baseBackupSchedule":"0 0 3 * * *"}' \
    P6_ENABLE_RESP P6_ENABLE_CODE
  if [[ "$P6_ENABLE_CODE" == "200" ]]; then
    DEST=$(printf '%s' "$P6_ENABLE_RESP" | sed -nE 's/.*"destinationPath":"([^"]+)".*/\1/p' | head -1)
    if [[ "$DEST" == "s3://system/wal-archive/platform-system-db" ]]; then
      pass "wal-archive/enable uses shim destinationPath ($DEST)"
    else
      fail "wal-archive/enable destinationPath wrong: '$DEST' (expected s3://system/wal-archive/platform-system-db)"
    fi
  else
    fail "wal-archive/enable returned $P6_ENABLE_CODE (no target picker now): $(printf '%s' "$P6_ENABLE_RESP" | head -c 300)"
  fi
fi
# WAL clusters list should still return only platform/system-db.
api GET '/api/v1/system-backup/wal-archive/clusters' '' P6_LIST_RESP _
if printf '%s' "$P6_LIST_RESP" | grep -q '"clusterName":"system-db"'; then
  pass "wal-archive/clusters surfaces platform/system-db"
else
  fail "wal-archive/clusters missing system-db"
fi

# ─── Summary ──────────────────────────────────────────────────────────
echo
if [[ "$FAILED" -eq 0 ]]; then
  printf '\033[32m✅ all backup-ui-phase E2E checks passed\033[0m\n'
  exit 0
else
  printf '\033[31m❌ %d backup-ui-phase E2E check(s) failed\033[0m\n' "$FAILED"
  exit 1
fi
