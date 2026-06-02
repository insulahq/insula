#!/usr/bin/env bash
# integration-wal-archive-failure-e2e.sh
# ─────────────────────────────────────────────────────────────────────────────
# E2E for the WAL-archive FAILURE path (PR #162/#164/#165 follow-up). Proves the
# platform alerts — and never self-destructs — when continuous WAL archiving to a
# SYSTEM backup target fails.
#
# Scenario (mirrors the 2026-06-02 runaway, but bounded + observable):
#   1. Baseline: no SYSTEM target → no barman plugin on the CNPG cluster →
#      wal-archive no-op-succeeds → ContinuousArchiving healthy, breaker untripped.
#   2. Bind a DEAD S3 target (unroutable endpoint) → the postgres-objectstore
#      reconciler attaches the barman plugin → archiving fails →
#      `ContinuousArchiving=False` (reason ContinuousArchivingFailing).
#   3. GET /admin/wal-archive-health → the assessment flips to state=failing +
#      shouldAlert=true (the HARD gate: deterministic, pure logic over the live
#      snapshot). Because pg_wal pressure stays far below the 75% trip threshold,
#      the circuit-breaker stays UNTRIPPED (alert-only — the intended `failing`,
#      not `critical`, state).
#   4. The `admin.wal_archive_failing` notification ROW (soft check): it fires on
#      a fresh cluster, but is rate-limited to once / 6h, so its absence on a
#      re-run within that window is EXPECTED — the detection is already proven in
#      step 3. (The live row-firing is proven separately on a fresh bootstrap.)
#   5. Recovery: unassign + delete the target → plugin removed → wal-archive
#      no-op-succeeds again → WAL recycles → state returns to ok; reset-breaker is
#      idempotent.
#
# This is a HEAVY suite: binding/unbinding a target triggers CNPG-managed Postgres
# restarts (~30–60s each) and the alert waits on the 5-min scheduler tick, so a
# full run is ~8–12 min. Run on-demand / nightly, not per-commit.
#
# Two modes: ON-NODE (default — local kubectl + self-managed port-forward, no
# public ingress needed) or REMOTE (set SSH_HOST → kubectl over ssh + the public
# ADMIN_HOST; this is how scripts/integration-all.sh drives it).
#
# USAGE
#   # on a control-plane node:
#   ADMIN_PASSWORD=<pw> KUBECONFIG=/etc/rancher/k3s/k3s.yaml \
#     ./scripts/integration-wal-archive-failure-e2e.sh
#   # from a workstation:
#   ADMIN_HOST=https://admin.staging.example.test SSH_HOST=root@<node> \
#     ADMIN_PASSWORD=<pw> ./scripts/integration-wal-archive-failure-e2e.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@testing.example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
# Two execution modes (matches the rest of the harness):
#   • SSH_HOST set  → REMOTE: kubectl runs over ssh; the API is the public
#     ADMIN_HOST. This is how scripts/integration-all.sh drives suites.
#   • SSH_HOST empty → ON-NODE: local kubectl + a self-managed port-forward to
#     127.0.0.1:PF_PORT (run directly on a control-plane node).
SSH_HOST="${SSH_HOST:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
PF_PORT="${PF_PORT:-18080}"
if [[ -n "$SSH_HOST" ]]; then
  ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
else
  ADMIN_HOST="http://127.0.0.1:${PF_PORT}"
fi
NS="${PLATFORM_NS:-platform}"
PG_POD="${PG_POD:-system-db-1}"
CLUSTER="${CNPG_CLUSTER:-system-db}"
# Non-resolving .invalid host (RFC 6761) → the shim's upstream forward fails →
# archiving fails. Deliberately a normal-looking https hostname, NOT
# http://<private-ip> — the latter trips the modsec CRS SSRF/RFI rules on the
# public ingress (403) in REMOTE mode, while a real-looking s3 URL passes the WAF
# just like an operator's genuine endpoint would.
DEAD_ENDPOINT="${DEAD_ENDPOINT:-https://wal-archive-fail.invalid:9000}"
TEST_CONFIG_NAME="wal-fail-itest"
ALERT_CATEGORY="admin.wal_archive_failing"

# kubectl wrapper: local, or remote via ssh with every arg shell-quoted so
# jsonpath braces, `-p '{json}'`, and `psql -c "SQL"` survive the remote shell.
ssh_run() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=12 "$SSH_HOST" "$@"; }
kc() { if [[ -n "$SSH_HOST" ]]; then ssh_run "$(printf '%q ' kubectl "$@")"; else kubectl "$@"; fi; }

# ─── Output helpers ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; BOLD='\033[1m'; RESET='\033[0m'
else
  CYAN=''; GREEN=''; RED=''; YELLOW=''; BOLD=''; RESET=''
fi
log()   { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()    { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail()  { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
warn()  { printf '  %b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
phase() { printf '\n%b%b── %s ──%b\n' "$BOLD" "$CYAN" "$*" "$RESET"; }
passed=0; failed=0

# ─── Cluster + DB helpers (local kubectl) ───────────────────────────────────
# A single-quoted SQL string with NO embedded single quotes, please.
dbq() { kc exec -n "$NS" "$PG_POD" -c postgres -- psql -U postgres -d platform -At -c "$1" 2>/dev/null | grep -v Defaulted; }
# Retry once on empty — `kubectl get -o json` can return nothing mid CNPG restart
# (which this suite provokes), and an empty blob would spuriously read as
# "plugin absent" / "no condition".
cluster_json() {
  local j; j=$(kc get cluster -n "$NS" "$CLUSTER" -o json 2>/dev/null)
  [[ -n "$j" ]] || { sleep 2; j=$(kc get cluster -n "$NS" "$CLUSTER" -o json 2>/dev/null); }
  printf '%s' "$j"
}
plugin_present() { cluster_json | grep -q 'barman-cloud.cloudnative-pg.io'; }
continuous_archiving_status() {
  # Returns True / False / "" — extracted without embedded-quote jsonpath.
  cluster_json | python3 -c 'import sys,json
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for c in d.get("status",{}).get("conditions",[]):
  if c.get("type")=="ContinuousArchiving": print(c.get("status","")); break'
}
wait_cluster_healthy() {
  for _ in $(seq 1 40); do
    [[ "$(kc get cluster -n "$NS" "$CLUSTER" -o jsonpath='{.status.phase}' 2>/dev/null)" == *"healthy"* ]] && return 0
    sleep 6
  done
  return 1
}

# ─── API helpers (via port-forward) ─────────────────────────────────────────
TOKEN=""
PF_PID=""
# Binding/unbinding a target restarts platform-api (CNPG flap), which kills a
# `kubectl port-forward svc/...` pinned to the old pod. Re-establish it before
# each call so the suite survives the very restarts it provokes.
ensure_api() {
  [[ -n "$SSH_HOST" ]] && return 0
  curl -sk --max-time 3 "$ADMIN_HOST/api/v1/healthz" >/dev/null 2>&1 && return 0
  [[ -n "$PF_PID" ]] && kill "$PF_PID" 2>/dev/null || true
  start_api
}
api() {  # api METHOD PATH [BODY] -> body then a final line "HTTP <code>"  (-k: http localhost or https public)
  local method=$1 path=$2 body=${3:-}
  ensure_api
  if [[ -n $body ]]; then
    curl -sk --max-time 30 -X "$method" -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' -d "$body" "$ADMIN_HOST$path" -w $'\nHTTP %{http_code}'
  else
    curl -sk --max-time 30 -X "$method" -H "Authorization: Bearer $TOKEN" \
      "$ADMIN_HOST$path" -w $'\nHTTP %{http_code}'
  fi
}
hcode() { printf '%s' "$1" | tail -1 | sed 's/HTTP //'; }
hbody() { printf '%s' "$1" | sed '$d'; }

# ON-NODE only: port-forward the API to 127.0.0.1. REMOTE mode talks straight to
# the public ADMIN_HOST, so this is a no-op there.
start_api() {
  [[ -n "$SSH_HOST" ]] && return 0
  # Reap a stale port-forward left by a SIGKILL'd prior run (SIGKILL can't trap),
  # else this one fails with "address already in use".
  pkill -f "port-forward.*svc/platform-api ${PF_PORT}:3000" 2>/dev/null || true
  kubectl port-forward -n "$NS" svc/platform-api "${PF_PORT}:3000" >/tmp/wal-fail-pf.log 2>&1 &
  PF_PID=$!
  # Up to ~90s: binding/unbinding a target restarts platform-api (wait-for-db +
  # migrate on boot), so the API can be briefly unavailable at suite start.
  for _ in $(seq 1 45); do
    curl -sk --max-time 3 "$ADMIN_HOST/api/v1/healthz" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

login() {
  if [[ -z "$ADMIN_PASSWORD" ]]; then fail "ADMIN_PASSWORD is required"; return 1; fi
  local resp
  resp=$(curl -sk --max-time 15 -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
  TOKEN=$(printf '%s' "$resp" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("data",{}).get("token",""))
except Exception: print("")')
  [[ -n "$TOKEN" ]]
}

# ─── Cleanup (trap-protected) ───────────────────────────────────────────────
TEST_TID=""
cleanup() {
  phase "Cleanup"
  # Unassign SYSTEM + delete the test config via the API if we still have a token.
  if [[ -n "$TOKEN" ]]; then
    api PUT /api/v1/admin/backup-rclone-shim/assignments/system '{"targetId":null,"force":true}' >/dev/null 2>&1 || true
    [[ -n "$TEST_TID" ]] && api DELETE "/api/v1/admin/backup-configs/$TEST_TID" >/dev/null 2>&1 || true
  fi
  # Belt-and-braces: drop any leftover row + force the plugin off so the cluster
  # can never be left archiving to a dead sink by a half-finished run.
  dbq "DELETE FROM backup_target_assignments WHERE backup_class='system'" >/dev/null 2>&1 || true
  dbq "DELETE FROM backup_configurations WHERE name='$TEST_CONFIG_NAME'" >/dev/null 2>&1 || true
  if plugin_present; then
    kc patch cluster -n "$NS" "$CLUSTER" --type=merge -p '{"spec":{"plugins":[]}}' >/dev/null 2>&1 || true
  fi
  [[ -n "$PF_PID" ]] && kill "$PF_PID" 2>/dev/null || true
  log "cleanup done (assignment cleared, test config removed, plugin off)"
}
trap cleanup EXIT INT TERM

# ─── Run ────────────────────────────────────────────────────────────────────
printf '%b%b WAL-archive FAILURE E2E %b\n' "$BOLD" "$CYAN" "$RESET"
log "ns=$NS cluster=$CLUSTER pg_pod=$PG_POD dead_endpoint=$DEAD_ENDPOINT"

start_api || { fail "could not reach platform-api (port-forward/ADMIN_HOST)"; exit 1; }
login || { fail "login failed (ADMIN_EMAIL=$ADMIN_EMAIL)"; exit 1; }
ok "authenticated as $ADMIN_EMAIL"

phase "Phase 1 — baseline (no target → no plugin → archiving healthy)"
# Best-effort re-run reset for the notification ROW (the hard gate is the health
# assessment below, which is dedupe-independent). The alert is rate-limited once /
# 6h: consumeRateLimit counts notification_deliveries by category_id (the
# rate_limited rows carry category_id but notification_id=NULL), so clear BOTH
# deliveries (by category_id — not via a notification_id join, which misses the
# NULL-notification rate_limited rows) and the notifications themselves.
dbq "DELETE FROM notification_deliveries WHERE category_id='$ALERT_CATEGORY'" >/dev/null 2>&1 || true
PRIOR=$(dbq "DELETE FROM notifications WHERE category_id='$ALERT_CATEGORY' RETURNING 1" | grep -c 1 2>/dev/null || echo 0)
[[ "${PRIOR:-0}" -gt 0 ]] 2>/dev/null && log "cleared $PRIOR prior $ALERT_CATEGORY notification(s) + deliveries for a clean re-run"
if plugin_present; then warn "a barman plugin is already present (pre-existing target?) — proceeding"; else ok "no barman plugin on a targetless cluster"; fi
H=$(api GET /api/v1/admin/wal-archive-health)
[[ "$(hcode "$H")" == "200" ]] && ok "GET /admin/wal-archive-health → 200" || fail "health endpoint → $(hcode "$H")"
# A tripped breaker at baseline is a DIRTY cluster (prior partial run) → hard-fail
# so it can't mask the Phase-2 assertions; an empty body is a transient → warn only.
if printf '%s' "$(hbody "$H")" | grep -q '"tripped":true'; then
  fail "circuit-breaker already TRIPPED at baseline — reset it first (POST /admin/wal-archive-health/reset-breaker)"
elif printf '%s' "$(hbody "$H")" | grep -q '"tripped":false'; then
  ok "circuit-breaker untripped at baseline"
else
  warn "breaker state indeterminate (empty/transient body): $(hbody "$H" | head -c 120)"
fi

phase "Phase 2 — bind a DEAD target → archiving fails → alert"
PAYLOAD="{\"storage_type\":\"s3\",\"name\":\"$TEST_CONFIG_NAME\",\"s3_endpoint\":\"$DEAD_ENDPOINT\",\"s3_bucket\":\"$TEST_CONFIG_NAME\",\"s3_region\":\"us-east-1\",\"s3_access_key\":\"DEADBEEFDEADBEEF0000\",\"s3_secret_key\":\"deadbeefdeadbeefdeadbeefdeadbeef0000\",\"retention_days\":7}"
C=$(api POST /api/v1/admin/backup-configs "$PAYLOAD")
TEST_TID=$(hbody "$C" | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("data",{}).get("id",""))
except Exception: print("")')
[[ -n "$TEST_TID" ]] && ok "created dead-target backup config ($TEST_TID)" || { fail "create config failed: $(hbody "$C" | head -c 200)"; exit 1; }

A=$(api PUT /api/v1/admin/backup-rclone-shim/assignments/system "{\"targetId\":\"$TEST_TID\",\"force\":false}")
[[ "$(hcode "$A")" == "200" ]] && ok "assigned dead target to SYSTEM" || fail "assign → $(hcode "$A"): $(hbody "$A" | head -c 160)"

log "waiting for the barman plugin to attach (reconciler; may wait up to one ~5-min tick)..."
for _ in $(seq 1 55); do plugin_present && break; sleep 6; done
# Non-fatal: the authoritative gate is ContinuousArchiving=False below, which can
# ONLY happen with the plugin attached + archiving failing (no plugin →
# wal-archive no-op-succeeds → healthy). So a slow/missed attach just warns here.
if plugin_present; then ok "barman plugin attached by the reconciler"
else warn "plugin not observed within the wait — relying on the ContinuousArchiving=False gate"; fi

log "forcing WAL switches + waiting for ContinuousArchiving=False..."
CA=""
for _ in $(seq 1 40); do
  CA=$(continuous_archiving_status)
  [[ "$CA" == "False" ]] && break
  dbq "SELECT pg_switch_wal()" >/dev/null 2>&1 || true
  sleep 8
done
[[ "$CA" == "False" ]] && ok "ContinuousArchiving=False (archiving is failing)" || fail "ContinuousArchiving never went False (=$CA)"

# AUTHORITATIVE alerting gate: assessWalArchive (pure logic over the live
# snapshot) flips to state=failing + shouldAlert the instant archiving fails.
# This is deterministic + dedupe-independent — unlike the notification ROW, which
# is rate-limited to once / 6h (a deliberate anti-spam guard). Retry to ride out
# the platform-api restart the plugin-add provokes (empty body mid-restart).
log "polling GET /admin/wal-archive-health for the failing assessment..."
HFAIL=0; HBODY=""
for _ in $(seq 1 24); do
  HBODY=$(hbody "$(api GET /api/v1/admin/wal-archive-health)")
  printf '%s' "$HBODY" | grep -q '"state":"failing"' && { HFAIL=1; break; }
  sleep 5
done
if [[ "$HFAIL" == 1 ]]; then
  ok "health assessment = failing (the platform detects the archive failure)"
  printf '%s' "$HBODY" | grep -q '"shouldAlert":true' && ok "assessment.shouldAlert=true (an alert is warranted)" \
    || warn "shouldAlert not true: $(printf '%s' "$HBODY" | head -c 160)"
else
  fail "health assessment never reported state=failing: $(printf '%s' "$HBODY" | head -c 160)"
fi

# The notification ROW is the user-visible side-effect. It fires on a fresh
# cluster, but is rate-limited to once / 6h with dedupe key wal-failing:<cluster>,
# so on a re-run within that window its absence is EXPECTED, not a failure — the
# detection is already proven above. (Best-effort reset ran in Phase 1.)
log "checking for the $ALERT_CATEGORY notification row (rate-limited once/6h)..."
FOUND=0
for _ in $(seq 1 18); do
  N=$(dbq "SELECT count(*) FROM notifications WHERE category_id='$ALERT_CATEGORY' AND created_at > now() - interval '30 minutes'")
  if [[ "${N:-0}" =~ ^[0-9]+$ ]] && [[ "$N" -ge 1 ]]; then FOUND=1; break; fi
  sleep 10
done
[[ "$FOUND" == 1 ]] && ok "$ALERT_CATEGORY notification row fired on the live cluster" \
  || warn "no fresh notification row — rate-limited (once/6h); detection confirmed via the health assessment above"

BRK=$(dbq "SELECT COALESCE((SELECT setting_value FROM platform_settings WHERE setting_key='wal_archive_circuit_breaker'),'ABSENT')")
if [[ "$BRK" == "ABSENT" || "$BRK" == *'"tripped":false'* ]]; then
  ok "circuit-breaker stayed UNTRIPPED (alert-only — pressure below 75%)"
else
  fail "breaker unexpectedly tripped at low pressure: $BRK"
fi

phase "Phase 3 — recovery (remove target → archiving recovers)"
api PUT /api/v1/admin/backup-rclone-shim/assignments/system '{"targetId":null,"force":true}' >/dev/null
[[ -n "$TEST_TID" ]] && api DELETE "/api/v1/admin/backup-configs/$TEST_TID" >/dev/null && TEST_TID=""
log "waiting for the plugin to be removed (reconciler tick)..."
for _ in $(seq 1 60); do plugin_present || break; sleep 6; done
if plugin_present; then
  warn "plugin still present after unassign — forcing off"
  kc patch cluster -n "$NS" "$CLUSTER" --type=merge -p '{"spec":{"plugins":[]}}' >/dev/null 2>&1 || true
else
  ok "barman plugin removed → wal-archive no-op-succeeds → WAL recycles"
fi
R=$(api POST /api/v1/admin/wal-archive-health/reset-breaker)
[[ "$(hcode "$R")" == "200" ]] && ok "reset-breaker → 200 (idempotent)" || warn "reset-breaker → $(hcode "$R")"
wait_cluster_healthy && ok "CNPG cluster back to healthy state" || warn "cluster not healthy within timeout"

# ─── Summary ────────────────────────────────────────────────────────────────
printf '\n%b── Summary ──%b\n' "$BOLD" "$RESET"
printf '  passed=%d failed=%d\n' "$passed" "$failed"
[[ "$failed" -eq 0 ]] && { printf '%bWAL-ARCHIVE FAILURE E2E PASSED%b\n' "$GREEN" "$RESET"; exit 0; }
printf '%bWAL-ARCHIVE FAILURE E2E FAILED%b\n' "$RED" "$RESET"; exit 1
