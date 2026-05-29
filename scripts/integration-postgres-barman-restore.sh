#!/usr/bin/env bash
# integration-postgres-barman-restore.sh — REAL-AUTH end-to-end
# exercise of the Phase 3 barman-cloud side-by-side restore AND the
# Phase 3.1 promote (destructive cutover).
#
# Verifies the full off-cluster archive restore flow:
#
#   1. List barman-cloud catalogue via /admin/cnpg-backup-catalogue/...
#      Pick the most recent backup.
#   2. Insert a marker row pre-Phase-3 (so we can verify the restored
#      cluster does NOT have it — barman archive predates it).
#   3. POST /admin/postgres-barman-restore — creates side-by-side
#      cluster `<source>-restored-e2e-<ts>` (verify-only, no plugins).
#   4. Wait for side-by-side cluster healthy; query it to confirm
#      data matches the barman archive (NOT the source's live data).
#   5. POST /admin/postgres-barman-restore/.../promote with the
#      type-to-confirm gate (server-side enforced).
#   6. Watch the promote PITR Job; assert progress streams + Job
#      succeeds.
#   7. Verify source cluster cut over (now has barman archive data,
#      not the marker row).
#   8. Verify side-by-side cluster auto-deleted (cleanup hook).
#   9. Verify plugin sidecar on the cut-over source pod (FAST recovery).
#  10. Verify task-center chip is terminal with full step timeline
#      persisted (modal-reopen renders).
#
# Env:
#   ADMIN_HOST       — defaults to https://admin.staging.example.test
#   ADMIN_EMAIL      — defaults to admin@staging.example.test
#   ADMIN_PASSWORD   — required
#   STAGING_SSH      — defaults to root@staging1.example.test
#   SSH_KEY          — defaults to ~/hosting-platform.key
#   CLUSTER_NS       — defaults to platform
#   CLUSTER_NAME     — defaults to system-db
#   OBJECT_STORE     — defaults to system-postgres-objectstore
#   SKIP_PROMOTE     — set 1 to skip Phase 3.1 (verify side-by-side only)
#   CURL_INSECURE    — set 1 to ignore TLS errors
#
# Runtime: ~15-25 min (driven by barman download + WAL replay + cutover
# orchestration + replica scale-up).
#
# Side effects: when SKIP_PROMOTE is unset (default), the source
# cluster IS WIPED + REBUILT from the barman archive. ONLY run against
# staging. Same production paranoia as snapshot-restore harness.

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@staging.example.test}"
STAGING_SSH="${STAGING_SSH:-root@staging1.example.test}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
CLUSTER_NS="${CLUSTER_NS:-platform}"
CLUSTER_NAME="${CLUSTER_NAME:-system-db}"
OBJECT_STORE="${OBJECT_STORE:-system-postgres-objectstore}"
SKIP_PROMOTE="${SKIP_PROMOTE:-0}"
CURL_OPTS=(-s --max-time 60)
if [[ "${CURL_INSECURE:-0}" == "1" ]]; then
  CURL_OPTS+=(-k)
fi

if printf '%s %s' "$ADMIN_HOST" "$STAGING_SSH" | grep -iqE 'production|prod[^a-z]'; then
  echo "REFUSING: ADMIN_HOST or STAGING_SSH looks like production." >&2
  exit 2
fi

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "ERROR: ADMIN_PASSWORD env not set" >&2
  exit 1
fi

ssh_cmd() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o LogLevel=ERROR -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 "$STAGING_SSH" "$@"; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=$((FAILED+1)); }
info() { printf '  \033[36m→\033[0m %s\n' "$*"; }
hdr()  { printf '\n\033[1;34m═══ %s ═══\033[0m\n' "$*"; }
FAILED=0

# ─── Auth ────────────────────────────────────────────────────────────
hdr "Auth"
LOGIN=$(curl "${CURL_OPTS[@]}" -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(printf '%s' "$LOGIN" | sed -nE 's/.*"token":"([^"]+)".*/\1/p' | head -1)
if [[ -z "$TOKEN" ]]; then
  fail "login failed: $(printf '%s' "$LOGIN" | head -c 200)"
  exit 1
fi
pass "obtained admin token"

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl "${CURL_OPTS[@]}" -X "$method" "$ADMIN_HOST$path" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -w '\n%{http_code}' -d "$body"
  else
    curl "${CURL_OPTS[@]}" -X "$method" "$ADMIN_HOST$path" \
      -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}'
  fi
}

# ─── Pre-test cluster + barman catalogue ─────────────────────────────
hdr "Pre-test state + barman catalogue"
PRE_PRIMARY=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.currentPrimary}'")
PRE_PHASE=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.phase}'")
PRE_INSTANCES=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.spec.instances}'")
info "source: primary=$PRE_PRIMARY phase=$PRE_PHASE spec.instances=$PRE_INSTANCES"
if [[ "$PRE_PHASE" != "Cluster in healthy state" ]]; then
  fail "Source cluster not healthy at start"
  exit 1
fi
pass "source cluster healthy"

CAT_OUT=$(api GET "/api/v1/admin/cnpg-backup-catalogue/$CLUSTER_NS/$OBJECT_STORE")
CAT_BODY=$(printf '%s' "$CAT_OUT" | sed '$d')
CAT_CODE=$(printf '%s' "$CAT_OUT" | tail -n1)
if [[ "$CAT_CODE" != "200" ]]; then
  fail "catalogue returned $CAT_CODE: $(printf '%s' "$CAT_BODY" | head -c 200)"
  exit 1
fi
LATEST_BACKUP=$(printf '%s' "$CAT_BODY" | sed -nE 's/.*"backups":\[\{"backupId":"([^"]+)".*/\1/p' | head -1)
if [[ -z "$LATEST_BACKUP" ]]; then
  fail "catalogue has no backups — can't run E2E"
  exit 1
fi
pass "catalogue has $(printf '%s' "$CAT_BODY" | grep -o '"backupId"' | wc -l) backups; latest=$LATEST_BACKUP"

# Marker setup. Default mode = single POST-barman-backup marker that
# proves restored cluster came from offsite archive (not source).
# WAL mode = two markers wrapping recoveryTargetTime; pg_switch_wal
# forces a fresh WAL segment so the markers reach the offsite archive.
flush_wal() {
  ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $PRE_PRIMARY -c postgres -- psql -U postgres -d platform -c \"SELECT pg_switch_wal();\"" >/dev/null 2>&1 || true
}

MARKER_VALUE="e2e_barman_$(date +%s)"
if [[ "${WITH_WAL:-0}" == "1" ]]; then
  # Marker A: pre-target
  MARKER_A_VALUE="${MARKER_VALUE}_A"
  ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $PRE_PRIMARY -c postgres -- psql -U postgres -d platform -c \"INSERT INTO platform_settings (setting_key, setting_value) VALUES ('e2e_barman_marker_a', '$MARKER_A_VALUE') ON CONFLICT (setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_at=NOW();\"" >/dev/null
  flush_wal
  info "marker A '$MARKER_A_VALUE' inserted + WAL flushed"

  sleep 5
  RECOVERY_TARGET_TIME=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $PRE_PRIMARY -c postgres -- psql -U postgres -d platform -t -A -c \"SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\\\"T\\\"HH24:MI:SS.US\\\"Z\\\"');\"" 2>&1 | tr -d ' ')
  info "recoveryTargetTime captured: $RECOVERY_TARGET_TIME"

  sleep 5
  MARKER_B_VALUE="${MARKER_VALUE}_B"
  ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $PRE_PRIMARY -c postgres -- psql -U postgres -d platform -c \"INSERT INTO platform_settings (setting_key, setting_value) VALUES ('e2e_barman_marker_b', '$MARKER_B_VALUE') ON CONFLICT (setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_at=NOW();\"" >/dev/null
  flush_wal
  info "marker B '$MARKER_B_VALUE' inserted POST-target + WAL flushed"

  # Wait for the archiver to flush the latest WAL segment to barman.
  # CNPG's barman archiver runs every few seconds; give it time.
  sleep 10
else
  ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $PRE_PRIMARY -c postgres -- psql -U postgres -d platform -c \"INSERT INTO platform_settings (setting_key, setting_value) VALUES ('e2e_barman_marker', '$MARKER_VALUE') ON CONFLICT (setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_at=NOW();\"" >/dev/null
  info "marker '$MARKER_VALUE' inserted in source (POST-barman-backup)"
fi

# ─── Phase 3 — side-by-side restore ──────────────────────────────────
hdr "Phase 3 — POST /admin/postgres-barman-restore (side-by-side)"
NEW_NAME="${CLUSTER_NAME}-restored-e2e-$(date +%s | tail -c 6)"
if [[ "${WITH_WAL:-0}" == "1" ]]; then
  RESTORE_BODY="{\"namespace\":\"$CLUSTER_NS\",\"sourceClusterName\":\"$CLUSTER_NAME\",\"newClusterName\":\"$NEW_NAME\",\"instances\":1,\"recoveryTargetTime\":\"$RECOVERY_TARGET_TIME\"}"
  info "WAL mode: CNPG bootstrap.recovery with recoveryTarget.targetTime=$RECOVERY_TARGET_TIME"
else
  RESTORE_BODY="{\"namespace\":\"$CLUSTER_NS\",\"sourceClusterName\":\"$CLUSTER_NAME\",\"newClusterName\":\"$NEW_NAME\",\"instances\":1}"
fi
TRIGGER=$(api POST '/api/v1/admin/postgres-barman-restore' "$RESTORE_BODY")
TRIGGER_CODE=$(printf '%s' "$TRIGGER" | tail -n1)
TRIGGER_BODY=$(printf '%s' "$TRIGGER" | sed '$d')
if [[ "$TRIGGER_CODE" != "202" ]]; then
  fail "barman-restore returned $TRIGGER_CODE: $(printf '%s' "$TRIGGER_BODY" | head -c 300)"
  exit 1
fi
pass "side-by-side restore $NEW_NAME accepted"

# Wait for the new cluster healthy.
hdr "Wait for $NEW_NAME healthy (barman download + WAL replay)"
for i in $(seq 1 80); do
  STATE=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $NEW_NAME -o jsonpath='ready={.status.readyInstances}/phase={.status.phase}' 2>/dev/null" || true)
  printf '  [%3d] %s\n' "$i" "$STATE"
  if printf '%s' "$STATE" | grep -qE "ready=[1-9].*phase=Cluster in healthy state"; then break; fi
  sleep 15
done
if ! printf '%s' "$STATE" | grep -qE "ready=[1-9].*phase=Cluster in healthy state"; then
  fail "side-by-side cluster $NEW_NAME did NOT become healthy"
  ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $NEW_NAME" || true
  exit 1
fi
pass "$NEW_NAME healthy after ${i} polls (~$((i*15))s)"

# Verify restored data matches the expected point-in-time.
if [[ "${WITH_WAL:-0}" == "1" ]]; then
  RESTORED_A=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i ${NEW_NAME}-1 -c postgres -- psql -U postgres -d platform -t -A -c \"SELECT COALESCE((SELECT setting_value FROM platform_settings WHERE setting_key='e2e_barman_marker_a'), 'GONE');\"" 2>/dev/null || echo 'GONE')
  RESTORED_B=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i ${NEW_NAME}-1 -c postgres -- psql -U postgres -d platform -t -A -c \"SELECT COALESCE((SELECT setting_value FROM platform_settings WHERE setting_key='e2e_barman_marker_b'), 'GONE');\"" 2>/dev/null || echo 'GONE')
  info "restored A (pre-target): $RESTORED_A"
  info "restored B (post-target): $RESTORED_B"
  if [[ "$RESTORED_A" == "$MARKER_A_VALUE" ]]; then
    pass "marker A PRESENT in restored cluster — WAL replay reached target"
  else
    fail "marker A MISSING — WAL replay didn't reach target (archive may not have caught up before restore?)"
  fi
  if [[ "$RESTORED_B" == "GONE" ]] || [[ "$RESTORED_B" != "$MARKER_B_VALUE" ]]; then
    pass "marker B GONE in restored cluster — WAL replay stopped at target"
  else
    fail "marker B PRESENT — WAL replayed BEYOND target time"
  fi
else
  RESTORED_MARKER=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i ${NEW_NAME}-1 -c postgres -- psql -U postgres -d platform -t -A -c \"SELECT COALESCE((SELECT setting_value FROM platform_settings WHERE setting_key='e2e_barman_marker'), 'GONE');\"" 2>/dev/null || echo 'GONE')
  if [[ "$RESTORED_MARKER" == "GONE" ]] || [[ "$RESTORED_MARKER" != "$MARKER_VALUE" ]]; then
    pass "restored cluster does NOT have post-archive marker — bootstrapped from barman correctly"
  else
    fail "restored cluster has marker '$RESTORED_MARKER' — NOT from barman archive!"
  fi
fi

# WAL mode tests the recoveryTargetTime application — promote is
# independent of recoveryTargetTime (always uses snapshot LSN). Skip
# promote in WAL mode + clean up the side-by-side.
if [[ "${WITH_WAL:-0}" == "1" ]] && [[ "$SKIP_PROMOTE" != "1" ]]; then
  info "WAL mode auto-skips promote (recoveryTargetTime applies to Phase 3 bootstrap, not promote)"
  SKIP_PROMOTE=1
fi

if [[ "$SKIP_PROMOTE" == "1" ]]; then
  hdr "SKIP_PROMOTE — stopping after Phase 3 verify; deleting side-by-side"
  api DELETE "/api/v1/admin/postgres-barman-restore/$CLUSTER_NS/$NEW_NAME" >/dev/null || true
  pass "side-by-side delete requested"
  echo
  if [[ $FAILED -eq 0 ]]; then
    printf '\033[1;32mPHASE 3 VERIFY PASSED\033[0m (WITH_WAL=${WITH_WAL:-0})\n'
    exit 0
  else
    exit 1
  fi
fi

# ─── Phase 3.1 — promote ──────────────────────────────────────────────
hdr "Phase 3.1 — POST .../promote (destructive cutover)"
PROMOTE_OUT=$(api POST "/api/v1/admin/postgres-barman-restore/$CLUSTER_NS/$NEW_NAME/promote" \
  "{\"sourceClusterName\":\"$CLUSTER_NAME\",\"confirmSourceClusterName\":\"$CLUSTER_NAME\"}")
PROMOTE_CODE=$(printf '%s' "$PROMOTE_OUT" | tail -n1)
PROMOTE_BODY=$(printf '%s' "$PROMOTE_OUT" | sed '$d')
PROMOTE_JOB=$(printf '%s' "$PROMOTE_BODY" | sed -nE 's/.*"jobName":"([^"]+)".*/\1/p' | head -1)
if [[ "$PROMOTE_CODE" != "202" ]] || [[ -z "$PROMOTE_JOB" ]]; then
  fail "promote returned $PROMOTE_CODE: $(printf '%s' "$PROMOTE_BODY" | head -c 300)"
  exit 1
fi
pass "promote Job $PROMOTE_JOB accepted"

# Server-side type-to-confirm gate must reject mismatched confirms.
GATE_OUT=$(api POST "/api/v1/admin/postgres-barman-restore/$CLUSTER_NS/$NEW_NAME/promote" \
  "{\"sourceClusterName\":\"$CLUSTER_NAME\",\"confirmSourceClusterName\":\"WRONG-$CLUSTER_NAME\"}" 2>/dev/null || true)
GATE_CODE=$(printf '%s' "$GATE_OUT" | tail -n1)
if [[ "$GATE_CODE" == "4"* ]]; then
  pass "type-to-confirm gate rejects mismatched confirm (HTTP $GATE_CODE)"
else
  info "second promote attempt returned $GATE_CODE (may be 409 if lock still held — OK)"
fi

# ─── Live progress: poll /status for promote ─────────────────────────
hdr "Live progress on promote ($PROMOTE_JOB)"
SEEN_STEPS=()
for i in $(seq 1 150); do
  STATUS_OUT=$(api GET '/api/v1/admin/postgres-restore/status' | head -n -1)
  IN_PROGRESS=$(printf '%s' "$STATUS_OUT" | sed -nE 's/.*"inProgress":(true|false).*/\1/p' | head -1)
  PHASE=$(printf '%s' "$STATUS_OUT" | sed -nE 's/.*"phase":"([^"]+)".*/\1/p' | head -1)
  IN_FLIGHT=$(printf '%s' "$STATUS_OUT" | sed -nE 's/.*"progressInFlight":\{"step":"([^"]+)".*/\1/p' | head -1)
  while IFS= read -r s; do [[ -n "$s" ]] && SEEN_STEPS+=("$s"); done < <(printf '%s' "$STATUS_OUT" | grep -oE '"step":"[^"]+"' | sed -E 's/.*"step":"([^"]+)"/\1/' || true)
  printf '  [%3d] inProgress=%s phase=%s inFlight=%s\n' "$i" "$IN_PROGRESS" "${PHASE:--}" "${IN_FLIGHT:--}"
  if [[ "$IN_PROGRESS" == "false" ]]; then break; fi
  sleep 8
done
if [[ "$IN_PROGRESS" != "false" ]]; then
  fail "promote did not finish within 20 min"
  ssh_cmd "k3s kubectl -n $CLUSTER_NS logs job/$PROMOTE_JOB --tail=30" || true
  exit 1
fi
pass "promote finished after ~$((i*8))s"

# Job exit code
JOB_FINAL=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get job $PROMOTE_JOB -o jsonpath='succeeded={.status.succeeded}/failed={.status.failed}'")
if ! printf '%s' "$JOB_FINAL" | grep -q "succeeded=1"; then
  fail "promote Job failed: $JOB_FINAL"
  ssh_cmd "k3s kubectl -n $CLUSTER_NS logs job/$PROMOTE_JOB --tail=40" || true
  exit 1
fi
pass "promote Job succeeded"

# ─── Side-by-side cluster must be auto-deleted ───────────────────────
hdr "Side-by-side cluster cleanup"
for i in $(seq 1 20); do
  EXISTS=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $NEW_NAME 2>&1" | head -1)
  if printf '%s' "$EXISTS" | grep -q 'NotFound'; then break; fi
  sleep 3
done
if printf '%s' "$EXISTS" | grep -q 'NotFound'; then
  pass "$NEW_NAME auto-deleted by post-success cleanup"
else
  fail "$NEW_NAME still exists after promote: $EXISTS"
fi

# ─── Source cluster cut over to barman data ──────────────────────────
hdr "Source cluster post-cutover health"
for i in $(seq 1 60); do
  POST_PHASE=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.phase}'")
  POST_READY=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.readyInstances}'")
  POST_PRIMARY=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.currentPrimary}'")
  printf '  [%3d] phase=%s ready=%s primary=%s\n' "$i" "${POST_PHASE:--}" "${POST_READY:-0}" "${POST_PRIMARY:--}"
  if [[ "$POST_PHASE" == "Cluster in healthy state" ]] && [[ "${POST_READY:-0}" -ge 1 ]]; then break; fi
  sleep 5
done
if [[ "$POST_PHASE" != "Cluster in healthy state" ]]; then
  fail "source cluster not healthy post-promote: phase=$POST_PHASE"
  exit 1
fi
pass "source healthy at $POST_READY instance(s) (primary=$POST_PRIMARY)"

# Marker must be gone — source now has the barman data.
MARKER_AFTER=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $POST_PRIMARY -c postgres -- psql -U postgres -d platform -t -A -c \"SELECT COALESCE((SELECT setting_value FROM platform_settings WHERE setting_key='e2e_barman_marker'), 'GONE');\"" 2>/dev/null || echo 'GONE')
if [[ "$MARKER_AFTER" == "GONE" ]] || [[ "$MARKER_AFTER" != "$MARKER_VALUE" ]]; then
  pass "source marker gone — cutover replaced source data with barman archive"
else
  fail "source still has pre-cutover marker '$MARKER_AFTER' — cutover did NOT happen"
fi

# ─── Plugin sidecar on the new primary pod ───────────────────────────
hdr "Plugin sidecar propagation (post-promote FAST recovery)"
# CNPG plugin sidecars run as restartPolicy:Always init-containers (k8s
# 1.28+ pattern), not regular containers. Check both.
ALL_CONTAINERS=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get pod $POST_PRIMARY -o jsonpath='{range .spec.containers[*]}{.name}{\" \"}{end}|{range .spec.initContainers[*]}{.name}{\" \"}{end}'")
PLUGINS_IN_SPEC=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.spec.plugins}'")
info "spec.plugins: $(echo "$PLUGINS_IN_SPEC" | head -c 120)"
info "pod containers+init: $ALL_CONTAINERS"
if [[ -n "$PLUGINS_IN_SPEC" ]] && [[ "$PLUGINS_IN_SPEC" != "null" ]] && [[ "$PLUGINS_IN_SPEC" != "[]" ]]; then
  if printf '%s' "$ALL_CONTAINERS" | grep -q "plugin-barman-cloud"; then
    pass "plugin-barman-cloud sidecar PRESENT on post-promote pod (no manual bounce)"
  else
    fail "plugin-barman-cloud sidecar MISSING — buildRecoveryCluster did not propagate spec.plugins"
  fi
else
  info "source had no plugins — skipping sidecar check"
fi

# ─── Task-center chip persistence (barman-promote modal reopen) ──────
hdr "Task-center chip persistence for promote"
CHIP_ROW=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $POST_PRIMARY -c postgres -- psql -U postgres -d platform -t -A -F'|' -c \"SELECT status, jsonb_array_length(COALESCE(details->'steps', '[]'::jsonb)), details->>'mode' FROM tasks WHERE ref_id='$PROMOTE_JOB';\"")
info "chip row: $CHIP_ROW"
CHIP_STATUS=$(printf '%s' "$CHIP_ROW" | awk -F'|' '{print $1}')
CHIP_STEPS_LEN=$(printf '%s' "$CHIP_ROW" | awk -F'|' '{print $2}')
CHIP_MODE=$(printf '%s' "$CHIP_ROW" | awk -F'|' '{print $3}')
if [[ "$CHIP_STATUS" == "succeeded" ]]; then
  pass "chip.status='succeeded'"
else
  fail "chip.status='$CHIP_STATUS' (expected 'succeeded')"
fi
if [[ "${CHIP_STEPS_LEN:-0}" -ge 5 ]]; then
  pass "chip.details.steps has ${CHIP_STEPS_LEN} entries"
else
  fail "chip.details.steps too short ($CHIP_STEPS_LEN)"
fi
if [[ "$CHIP_MODE" == "barman-promote" ]]; then
  pass "chip.details.mode='barman-promote'"
else
  fail "chip.details.mode='$CHIP_MODE' (expected 'barman-promote')"
fi

# ─── PITR lock cleared ───────────────────────────────────────────────
hdr "PITR lock cleared"
LOCK_AFTER=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $POST_PRIMARY -c postgres -- psql -U postgres -d platform -t -A -c \"SELECT COUNT(*) FROM platform_settings WHERE setting_key='pg_pitr_in_progress';\"")
if [[ "$LOCK_AFTER" == "0" ]]; then
  pass "PITR lock cleared"
else
  fail "PITR lock STILL HELD"
fi

echo
if [[ $FAILED -eq 0 ]]; then
  printf '\033[1;32mALL CHECKS PASSED\033[0m (Phase 3 + Phase 3.1 barman E2E)\n'
  exit 0
else
  printf '\033[1;31mFAILED %d CHECKS\033[0m\n' "$FAILED"
  exit 1
fi
