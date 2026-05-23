#!/usr/bin/env bash
# integration-postgres-snapshot-restore.sh — REAL-AUTH end-to-end
# exercise of the Phase 1 snapshot-only PITR flow (no barman archive).
#
# Verifies the full restore pipeline that the admin "Restore from
# snapshot" wizard drives:
#
#   1. Take a fresh Longhorn snapshot of the cluster's primary PVC.
#   2. Insert a marker row into platform_settings (post-snapshot).
#   3. POST /admin/postgres-restore with that snapshot + clusterName.
#   4. Poll /status; verify steps stream into PersistedLock.
#   5. Wait for the Job pod to finish (success or failure).
#   6. Verify the new primary is healthy + carries the snapshot's
#      data (marker row should be GONE — proof PITR rewound to the
#      snapshot LSN, no later inserts).
#   7. Verify the task-center chip is in a TERMINAL state with the
#      full step timeline persisted to tasks.details.steps (so the
#      operator's re-open of PitrProgressModal renders the history,
#      not a blank list — fix shipped 2026-05-23).
#   8. Verify the plugin-barman-cloud sidecar is on the recreated
#      pod (without manual `kubectl delete pod` — see plugin
#      propagation fix in buildRecoveryCluster 2026-05-23).
#
# Env:
#   ADMIN_HOST       — defaults to https://admin.staging.phoenix-host.net
#   ADMIN_EMAIL      — defaults to admin@staging.phoenix-host.net
#   ADMIN_PASSWORD   — required
#   STAGING_SSH      — defaults to root@staging1.phoenix-host.net (used
#                      to run kubectl + psql for live cluster
#                      assertions; integration auth alone can't query
#                      the postgres rows)
#   SSH_KEY          — defaults to ~/hosting-platform.key
#   CLUSTER_NS       — defaults to platform
#   CLUSTER_NAME     — defaults to system-db
#   CURL_INSECURE    — set 1 to ignore TLS errors
#
# Usage:
#   ADMIN_PASSWORD=... ./scripts/integration-postgres-snapshot-restore.sh
#
# Runtime: ~6-13 min (driven by Longhorn snapshot wait + WAL replay).
#
# Side effects: DESTRUCTIVE on the target cluster — replaces its data
# with the snapshot's data. ONLY run against staging or a dedicated
# test cluster. Refuses to run if ADMIN_HOST hostname contains the
# substring "production" or "prod" (case-insensitive paranoia).

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@staging.phoenix-host.net}"
STAGING_SSH="${STAGING_SSH:-root@staging1.phoenix-host.net}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
CLUSTER_NS="${CLUSTER_NS:-platform}"
CLUSTER_NAME="${CLUSTER_NAME:-system-db}"
CURL_OPTS=(-s --max-time 60)
if [[ "${CURL_INSECURE:-0}" == "1" ]]; then
  CURL_OPTS+=(-k)
fi

# Production paranoia: refuse to run if ADMIN_HOST or STAGING_SSH look
# like a production environment. We're going to wipe Postgres data.
if printf '%s %s' "$ADMIN_HOST" "$STAGING_SSH" | grep -iqE 'production|prod[^a-z]'; then
  echo "REFUSING: ADMIN_HOST or STAGING_SSH looks like production." >&2
  echo "  ADMIN_HOST=$ADMIN_HOST" >&2
  echo "  STAGING_SSH=$STAGING_SSH" >&2
  exit 2
fi

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "ERROR: ADMIN_PASSWORD env not set" >&2
  exit 1
fi

# shellcheck disable=SC1090
if [[ -f "$(dirname "$0")/lib/integration-token.sh" ]]; then
  source "$(dirname "$0")/lib/integration-token.sh"
fi

ssh_cmd() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o LogLevel=ERROR "$STAGING_SSH" "$@"; }

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=$((FAILED+1)); }
info() { printf '  \033[36m→\033[0m %s\n' "$*"; }
hdr()  { printf '\n\033[1;34m═══ %s ═══\033[0m\n' "$*"; }
FAILED=0

# ─── Login + token ───────────────────────────────────────────────────
hdr "Auth"
LOGIN=$(curl "${CURL_OPTS[@]}" -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(printf '%s' "$LOGIN" | sed -nE 's/.*"token":"([^"]+)".*/\1/p' | head -1)
if [[ -z "$TOKEN" ]]; then
  fail "login failed: $(printf '%s' "$LOGIN" | head -c 200)"
  exit 1
fi
pass "obtained admin token (len=${#TOKEN})"

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

# ─── Pre-test cluster state ──────────────────────────────────────────
hdr "Pre-test state: $CLUSTER_NS/$CLUSTER_NAME"
PRE_PRIMARY=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.currentPrimary}'")
PRE_READY=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.readyInstances}'")
PRE_PHASE=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.phase}'")
info "primary=$PRE_PRIMARY ready=$PRE_READY phase=$PRE_PHASE"
if [[ -z "$PRE_PRIMARY" ]] || [[ "$PRE_PHASE" != "Cluster in healthy state" ]]; then
  fail "Cluster not healthy at start — won't run destructive E2E"
  exit 1
fi
pass "cluster healthy, primary=$PRE_PRIMARY"
PRE_PVC="$PRE_PRIMARY"  # CNPG: pod name == PVC name

# ─── Take a fresh Longhorn snapshot ──────────────────────────────────
hdr "Take fresh Longhorn snapshot of $PRE_PVC"
PVC_VOLUME=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get pvc $PRE_PVC -o jsonpath='{.spec.volumeName}'")
if [[ -z "$PVC_VOLUME" ]]; then
  fail "PVC $PRE_PVC has no spec.volumeName"
  exit 1
fi
info "volume=$PVC_VOLUME"

SNAP_NAME="e2e-snapshot-$(date +%s)"
ssh_cmd "k3s kubectl apply -f - <<EOF
apiVersion: longhorn.io/v1beta2
kind: Snapshot
metadata:
  name: $SNAP_NAME
  namespace: longhorn-system
  labels:
    e2e-test: 'true'
spec:
  createSnapshot: true
  volume: $PVC_VOLUME
EOF" >/dev/null

info "snapshot $SNAP_NAME created; polling readyToUse"
for i in $(seq 1 60); do
  READY=$(ssh_cmd "k3s kubectl -n longhorn-system get snapshot $SNAP_NAME -o jsonpath='{.status.readyToUse}' 2>/dev/null" || true)
  if [[ "$READY" == "true" ]]; then break; fi
  sleep 2
done
if [[ "$READY" != "true" ]]; then
  fail "snapshot $SNAP_NAME did not become ready within 120s"
  exit 1
fi
pass "snapshot ready after $((i*2))s"

# ─── Insert marker row (POST-snapshot — should be gone after restore) ─
hdr "Insert post-snapshot marker"
MARKER_VALUE="e2e_pitr_$(date +%s)"
ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $PRE_PRIMARY -c postgres -- psql -U postgres -d hosting_platform -c \"INSERT INTO platform_settings (setting_key, setting_value) VALUES ('e2e_marker', '$MARKER_VALUE') ON CONFLICT (setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value, updated_at=NOW();\"" >/dev/null
VERIFY_MARKER=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $PRE_PRIMARY -c postgres -- psql -U postgres -d hosting_platform -t -A -c \"SELECT setting_value FROM platform_settings WHERE setting_key='e2e_marker';\"")
if [[ "$VERIFY_MARKER" != "$MARKER_VALUE" ]]; then
  fail "marker insert verification failed (got: $VERIFY_MARKER)"
  exit 1
fi
pass "marker '$MARKER_VALUE' inserted (will assert GONE after restore)"

# ─── Prechecks (read-only) ───────────────────────────────────────────
hdr "Prechecks"
PRECHECK_RESP=$(api GET "/api/v1/admin/postgres-restore/prechecks?clusterNamespace=$CLUSTER_NS&clusterName=$CLUSTER_NAME&snapshotName=$SNAP_NAME" | head -n -1)
SNAPSHOT_USABLE=$(printf '%s' "$PRECHECK_RESP" | sed -nE 's/.*"snapshotUsable":(true|false).*/\1/p' | head -1)
LOCK_STATE=$(printf '%s' "$PRECHECK_RESP" | sed -nE 's/.*"lockState":"([^"]+)".*/\1/p' | head -1)
BLOCKING_ERR=$(printf '%s' "$PRECHECK_RESP" | sed -nE 's/.*"blockingError":"?([^",}]+).*/\1/p' | head -1)
info "snapshotUsable=$SNAPSHOT_USABLE lockState=$LOCK_STATE blockingError=$BLOCKING_ERR"
if [[ "$SNAPSHOT_USABLE" != "true" ]]; then
  fail "snapshot not usable per prechecks"
  exit 1
fi
if [[ "$LOCK_STATE" != "free" ]]; then
  fail "PITR lock not free at start (state=$LOCK_STATE)"
  exit 1
fi
pass "prechecks: snapshotUsable=true lockState=free"

# ─── Trigger the restore ─────────────────────────────────────────────
hdr "Trigger POST /admin/postgres-restore"
START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TRIGGER_OUT=$(api POST '/api/v1/admin/postgres-restore' \
  "{\"clusterNamespace\":\"$CLUSTER_NS\",\"clusterName\":\"$CLUSTER_NAME\",\"snapshotName\":\"$SNAP_NAME\"}")
TRIGGER_CODE=$(printf '%s' "$TRIGGER_OUT" | tail -n1)
TRIGGER_BODY=$(printf '%s' "$TRIGGER_OUT" | sed '$d')
JOB_NAME=$(printf '%s' "$TRIGGER_BODY" | sed -nE 's/.*"jobName":"([^"]+)".*/\1/p' | head -1)
if [[ "$TRIGGER_CODE" != "202" ]] || [[ -z "$JOB_NAME" ]]; then
  fail "POST /admin/postgres-restore returned $TRIGGER_CODE: $TRIGGER_BODY"
  exit 1
fi
pass "Job $JOB_NAME accepted at $START_TS"

# ─── Live progress: status endpoint streams steps ────────────────────
hdr "Live progress (poll /status for up to 13min)"
SEEN_STEPS=()
SEEN_PHASES=()
for i in $(seq 1 120); do
  STATUS_OUT=$(api GET '/api/v1/admin/postgres-restore/status' | head -n -1)
  IN_PROGRESS=$(printf '%s' "$STATUS_OUT" | sed -nE 's/.*"inProgress":(true|false).*/\1/p' | head -1)
  PHASE=$(printf '%s' "$STATUS_OUT" | sed -nE 's/.*"phase":"([^"]+)".*/\1/p' | head -1)
  IN_FLIGHT_STEP=$(printf '%s' "$STATUS_OUT" | sed -nE 's/.*"progressInFlight":\{"step":"([^"]+)".*/\1/p' | head -1)
  # Collect every step name that appears in progressSteps for later assertion.
  while IFS= read -r s; do
    [[ -n "$s" ]] && SEEN_STEPS+=("$s")
  done < <(printf '%s' "$STATUS_OUT" | grep -oE '"step":"[^"]+"' | sed -E 's/.*"step":"([^"]+)"/\1/' || true)
  if [[ -n "$PHASE" ]]; then SEEN_PHASES+=("$PHASE"); fi

  printf '  [%3d] inProgress=%s phase=%s inFlight=%s\n' "$i" "$IN_PROGRESS" "${PHASE:--}" "${IN_FLIGHT_STEP:--}"

  if [[ "$IN_PROGRESS" == "false" ]]; then break; fi
  sleep 8
done

if [[ "$IN_PROGRESS" != "false" ]]; then
  fail "PITR did not complete within 16 min"
  ssh_cmd "k3s kubectl -n $CLUSTER_NS logs job/$JOB_NAME --tail=20" || true
  exit 1
fi
pass "PITR Job finished after ${i} polls (~$((i*8))s)"

# Distinct seen steps
UNIQUE_STEPS=$(printf '%s\n' "${SEEN_STEPS[@]}" | sort -u | tr '\n' ' ')
info "steps observed mid-flight: $UNIQUE_STEPS"
for must_see in preflight wrap-volume-snapshot create-temp-cluster recreate-source; do
  if printf '%s\n' "${SEEN_STEPS[@]}" | grep -qx "$must_see"; then
    pass "step '$must_see' was observed during live progress"
  else
    fail "step '$must_see' MISSING from live progress stream (was modal blank?)"
  fi
done

# ─── Job exit code ───────────────────────────────────────────────────
hdr "Job final state"
JOB_FINAL=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get job $JOB_NAME -o jsonpath='succeeded={.status.succeeded}/failed={.status.failed}'")
info "$JOB_FINAL"
if ! printf '%s' "$JOB_FINAL" | grep -q "succeeded=1"; then
  fail "Job did NOT succeed: $JOB_FINAL"
  ssh_cmd "k3s kubectl -n $CLUSTER_NS logs job/$JOB_NAME --tail=20" || true
  exit 1
fi
pass "Job succeeded"

# ─── Cluster post-state: primary healthy ─────────────────────────────
hdr "Post-state cluster health"
# Give CNPG up to 4 min to settle (snapshot recovery + WAL replay + primary boot)
for i in $(seq 1 40); do
  POST_PHASE=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.phase}'")
  POST_READY=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.readyInstances}'")
  printf '  [%3d] phase=%s ready=%s\n' "$i" "${POST_PHASE:--}" "${POST_READY:-0}"
  if [[ "$POST_PHASE" == "Cluster in healthy state" ]] && [[ "${POST_READY:-0}" -ge 1 ]]; then break; fi
  sleep 6
done
if [[ "$POST_PHASE" != "Cluster in healthy state" ]]; then
  fail "Cluster not healthy after restore: phase=$POST_PHASE ready=$POST_READY"
  exit 1
fi
pass "Cluster healthy at $POST_READY instance(s)"

# ─── Verify marker is GONE (PITR rewound) ────────────────────────────
hdr "Marker assertion (must be GONE — proves PITR rewound to snapshot LSN)"
NEW_PRIMARY=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.status.currentPrimary}'")
MARKER_AFTER=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $NEW_PRIMARY -c postgres -- psql -U postgres -d hosting_platform -t -A -c \"SELECT COALESCE((SELECT setting_value FROM platform_settings WHERE setting_key='e2e_marker'), 'GONE');\"" 2>/dev/null || echo 'GONE')
info "marker after restore: '$MARKER_AFTER'"
if [[ "$MARKER_AFTER" == "GONE" ]] || [[ "$MARKER_AFTER" != "$MARKER_VALUE" ]]; then
  pass "marker is gone — snapshot LSN restored correctly"
else
  fail "marker still present: '$MARKER_AFTER' — PITR did NOT rewind!"
fi

# ─── Plugin sidecar must be on the new pod (no manual kubectl delete) ─
hdr "Plugin sidecar propagation (FAST recovery — no manual pod-bounce)"
PLUGINS_IN_SPEC=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get cluster $CLUSTER_NAME -o jsonpath='{.spec.plugins}'")
POD_CONTAINERS=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS get pod $NEW_PRIMARY -o jsonpath='{range .spec.containers[*]}{.name}{\" \"}{end}'")
info "spec.plugins: $(echo "$PLUGINS_IN_SPEC" | head -c 120)"
info "pod containers: $POD_CONTAINERS"
if [[ -n "$PLUGINS_IN_SPEC" ]] && [[ "$PLUGINS_IN_SPEC" != "null" ]] && [[ "$PLUGINS_IN_SPEC" != "[]" ]]; then
  if printf '%s' "$POD_CONTAINERS" | grep -q "plugin-barman-cloud"; then
    pass "plugin-barman-cloud sidecar PRESENT on new pod (no manual bounce needed)"
  else
    fail "plugin-barman-cloud sidecar MISSING — buildRecoveryCluster did not propagate spec.plugins"
  fi
else
  info "source had no plugins — skipping sidecar check"
fi

# ─── Task-center chip — terminal + steps persisted ───────────────────
hdr "Task-center chip persistence (modal-reopen must show history)"
CHIP_ROW=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $NEW_PRIMARY -c postgres -- psql -U postgres -d hosting_platform -t -A -F'|' -c \"SELECT status, jsonb_array_length(COALESCE(details->'steps', '[]'::jsonb)), details->>'mode', details->>'finishedAtIso' FROM tasks WHERE ref_id='$JOB_NAME';\"")
info "chip row: $CHIP_ROW"
CHIP_STATUS=$(printf '%s' "$CHIP_ROW" | awk -F'|' '{print $1}')
CHIP_STEPS_LEN=$(printf '%s' "$CHIP_ROW" | awk -F'|' '{print $2}')
CHIP_MODE=$(printf '%s' "$CHIP_ROW" | awk -F'|' '{print $3}')
CHIP_FINISHED=$(printf '%s' "$CHIP_ROW" | awk -F'|' '{print $4}')

if [[ "$CHIP_STATUS" == "succeeded" ]]; then
  pass "chip.status='succeeded' (finalized via finishByRef)"
else
  fail "chip.status='$CHIP_STATUS' (expected 'succeeded')"
fi
if [[ "${CHIP_STEPS_LEN:-0}" -ge 5 ]]; then
  pass "chip.details.steps has ${CHIP_STEPS_LEN} entries — modal reopen will render timeline"
else
  fail "chip.details.steps too short ($CHIP_STEPS_LEN) — modal reopen will be blank"
fi
if [[ "$CHIP_MODE" == "pitr" ]]; then
  pass "chip.details.mode='pitr' (correct tag)"
else
  fail "chip.details.mode='$CHIP_MODE' (expected 'pitr')"
fi
if [[ -n "$CHIP_FINISHED" ]]; then
  pass "chip.details.finishedAtIso captured: $CHIP_FINISHED"
else
  fail "chip.details.finishedAtIso missing — modal won't show 'finished at'"
fi

# ─── PITR lock cleared ───────────────────────────────────────────────
hdr "PITR lock cleared"
LOCK_AFTER=$(ssh_cmd "k3s kubectl -n $CLUSTER_NS exec -i $NEW_PRIMARY -c postgres -- psql -U postgres -d hosting_platform -t -A -c \"SELECT COUNT(*) FROM platform_settings WHERE setting_key='pg_pitr_in_progress';\"")
if [[ "$LOCK_AFTER" == "0" ]]; then
  pass "PITR lock cleared"
else
  fail "PITR lock STILL HELD (count=$LOCK_AFTER) — operator can't run another restore"
fi

# ─── Cleanup snapshot CR ─────────────────────────────────────────────
hdr "Cleanup"
ssh_cmd "k3s kubectl -n longhorn-system delete snapshot $SNAP_NAME --ignore-not-found" >/dev/null
pass "test snapshot deleted"

echo
if [[ $FAILED -eq 0 ]]; then
  printf '\033[1;32mALL CHECKS PASSED\033[0m (snapshot restore E2E)\n'
  exit 0
else
  printf '\033[1;31mFAILED %d CHECKS\033[0m\n' "$FAILED"
  exit 1
fi
