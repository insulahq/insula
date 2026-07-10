#!/usr/bin/env bash
# E2E for the snapshot-only Postgres PITR feature on the staging cluster.
#
# WHAT THIS HARNESS PROVES (end-to-end against a real CNPG cluster):
#
#   1. The auto-promote orchestrator wraps an existing Longhorn snapshot,
#      bootstraps a temp CNPG cluster from it, snapshot-handoffs into a
#      new cluster CR with the SAME source name, and removes the temp
#      cluster — all in a single sync HTTP call (≤10 min).
#
#   2. Round-trip semantics: a sentinel row inserted AFTER the snapshot
#      MUST disappear after restore (proves data really came from the
#      snapshot's PITR LSN, not from the live PVC that survived
#      reclaimPolicy=Retain).
#
#   3. Cluster identity preserved: connection string (Service name)
#      unchanged, instance count unchanged, no leftover temp cluster CR
#      and no leaked VolumeSnapshot wrapper resources.
#
#   4. Write-lock middleware blocks general POSTs during PITR with 503
#      RESTORE_IN_PROGRESS but allows status polling.
#
#   5. Chip-persistence + plugin-sidecar propagation + fast/slow path
#      selection (folded 2026-07-02 from the retired
#      integration-postgres-snapshot-restore.sh):
#        - the task-center chip lands in a TERMINAL state with the full
#          step timeline persisted to tasks.details.steps (so re-opening
#          PitrProgressModal renders history, not a blank list);
#        - the plugin-barman-cloud sidecar is present on the recreated
#          primary pod WITHOUT a manual `kubectl delete pod`;
#        - default mode (no recoveryTargetTime) took the FAST-path
#          (create-temp-cluster SKIPPED); WAL mode took the SLOW-path.
#
# MODES:
#   Default (WITH_WAL unset): restore-to-snapshot-LSN. The post-snapshot
#     row MUST be gone; fast-path (temp cluster skipped) expected.
#   WITH_WAL=1: recoveryTargetTime WAL-replay. Two markers wrap the
#     target time — marker A (pre-target) MUST survive, marker B
#     (post-target) MUST be gone — proving WAL replayed up to the target
#     and stopped exactly there. Forces the slow-path (temp cluster +
#     WAL replay from the barman object store). Runs longer (~+5 min).
#     On-demand only; integration-all runs the fast default path.
#
# WHY A SEPARATE HARNESS (vs. integration-system-snapshots.sh):
#   Phase 4a of system-snapshots asserts that the OLD per-PVC restore
#   route refuses CNPG (422). This harness is the proof that the NEW
#   auto-promote path actually works — they cover opposite concerns.
#
# SAFETY:
#   This script intentionally deletes and recreates the platform/system-db
#   cluster. The sentinel row is in a throwaway table created/dropped by
#   this script. Real platform data (users, clients, deployments) lives
#   in the same database — the snapshot is a real backup of that data,
#   and the round-trip restores all of it. Run only on staging.
#
# USAGE:
#   ADMIN_PASSWORD=<…> ./scripts/integration-postgres-pitr.sh
#   WITH_WAL=1 ADMIN_PASSWORD=<…> ./scripts/integration-postgres-pitr.sh

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_HOST="${SSH_HOST:-root@192.0.2.56}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
WITH_WAL="${WITH_WAL:-0}"   # 1 = recoveryTargetTime WAL-replay mode (slow-path)
[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
pass() { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; exit 1; }

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no $SSH_HOST"
KUBECTL="$SSH kubectl"

curl_admin() {
  curl -sS -k -H "Authorization: Bearer $TOKEN" "$@"
}

# EXIT trap clears scratch JSON even when fail() short-circuits the harness
# (avoids tmpfs leftovers — see feedback_e2e_tmp_cleanup).
trap 'rm -f /tmp/snap-take.json /tmp/pitr.json' EXIT

# Run a kubectl command on the staging server. Pass the full kubectl
# argv as a single quoted string to avoid double-shell interpretation
# of SQL/JSON arguments (otherwise parens, semicolons, quotes get
# eaten by the remote shell).
kubectl_remote() {
  $SSH "$@"
}

psql_pg() {
  # Exec into the current primary and run psql. The SQL is passed via
  # stdin (-- < EOF) to sidestep all quoting issues across the
  # local-shell → ssh → remote-shell → kubectl exec → bash hops.
  local primary sql="$1"
  primary=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.status.currentPrimary}' 2>/dev/null)
  [[ -n "$primary" ]] || { echo "psql_pg: no primary found" >&2; return 1; }
  $SSH "kubectl exec -n platform '$primary' -c postgres -i -- psql -tA -d platform" <<EOF
$sql
EOF
}

# psql_ro — RETRIED read-only query. The ssh→kubectl-exec hop can drop a
# connection mid-flight ("unexpected EOF"): a genuine, rare transient that was
# turning a valid SELECT into a suite failure (the rc.20 9b false red). Retries
# up to 3× with a 3s backoff. SAFE FOR READS ONLY — never route an INSERT/DDL
# through this (a committed-then-dropped write would double on retry). This
# also removes a hazard at the call sites: they used `psql_pg … || echo "0"`,
# which masks a dropped exec AS the data value 0 — i.e. a transient could read
# "marker lost" and FALSELY fail a correctness assertion. Retrying first, then
# falling back, keeps the fallback as a genuine-last-resort rather than a
# transient-swallower.
psql_ro() {
  local sql="$1" n=0 out
  while :; do
    n=$((n+1))
    if out=$(psql_pg "$sql" 2>/dev/null); then printf '%s' "$out"; return 0; fi
    (( n >= 3 )) && return 1
    sleep 3
  done
}

# Force a WAL segment switch so a freshly-inserted row is flushed into
# the archived WAL — required in WITH_WAL mode so the temp cluster can
# replay it from the barman object store up to recoveryTargetTime.
flush_wal() {
  psql_pg "SELECT pg_switch_wal();" >/dev/null 2>&1 || true
}

log "1) Login"
# #130: reuse ONE cache-backed admin token across ALL/single-test modes so
# rapid runs don't trip the auth rate limit. Only mints if no token is set
# and the cache is cold; otherwise reads the shared cache file.
if [[ -z "${INTEGRATION_TOKEN:-}" ]] && [[ -f "$(dirname "${BASH_SOURCE[0]}")/integration-token.sh" ]]; then
  # shellcheck source=integration-token.sh
  source "$(dirname "${BASH_SOURCE[0]}")/integration-token.sh"
  INTEGRATION_TOKEN="$(get_admin_token)" && export INTEGRATION_TOKEN || true
fi

if [[ -n "${INTEGRATION_TOKEN:-}" ]]; then
  TOKEN="$INTEGRATION_TOKEN"
  pass "logged in (cached INTEGRATION_TOKEN)"
else
  TOKEN=$(curl -sS -k -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["token"])')
  [[ -n "$TOKEN" ]] && pass "logged in" || fail "login failed"
fi

log "2) Pre-flight: confirm CNPG cluster system-db is healthy"
PHASE=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.status.phase}')
PRIMARY_BEFORE=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.status.currentPrimary}')
INSTANCES_BEFORE=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.spec.instances}')
echo "  phase=$PHASE primary=$PRIMARY_BEFORE instances=$INSTANCES_BEFORE"
[[ "$PHASE" = "Cluster in healthy state" ]] || fail "cluster not healthy: $PHASE"

log "3) Drop+recreate sentinel table BEFORE snapshot, insert pre-snapshot row"
psql_pg "DROP TABLE IF EXISTS e2e_pitr_marker;" >/dev/null
psql_pg "CREATE TABLE e2e_pitr_marker (id INT PRIMARY KEY, label TEXT, inserted_at TIMESTAMPTZ DEFAULT now());" >/dev/null
psql_pg "INSERT INTO e2e_pitr_marker (id, label) VALUES (1, 'pre-snapshot');" >/dev/null
PRE_COUNT=$(psql_pg "SELECT COUNT(*) FROM e2e_pitr_marker;")
echo "  pre-snapshot rows: $PRE_COUNT"
[[ "$PRE_COUNT" = "1" ]] || fail "expected 1 pre-snapshot row, got $PRE_COUNT"
# Force a checkpoint so the row is durable in the snapshot
psql_pg "CHECKPOINT;" >/dev/null

log "4) Take a Longhorn snapshot of system-db primary's PVC via system-snapshots API"
PRIMARY_PVC="$PRIMARY_BEFORE"
LONGHORN_VOL=$($KUBECTL get pvc -n platform "$PRIMARY_PVC" -o jsonpath='{.spec.volumeName}')
echo "  primary pvc=$PRIMARY_PVC volume=$LONGHORN_VOL"
curl_admin -X POST "$ADMIN_HOST/api/v1/admin/system-snapshots/$LONGHORN_VOL/snapshots" \
  -H 'Content-Type: application/json' -d '{"label":"e2e-pitr"}' -o /tmp/snap-take.json
SNAP=$(python3 -c 'import json; print(json.load(open("/tmp/snap-take.json"))["data"]["snapshotName"])')
[[ -n "$SNAP" ]] && pass "snapshot $SNAP requested" || fail "snapshot creation failed: $(cat /tmp/snap-take.json)"

# Wait for snapshot to be ready
for _ in {1..30}; do
  READY=$($KUBECTL get -n longhorn-system snapshot.longhorn.io "$SNAP" -o jsonpath='{.status.readyToUse}' 2>/dev/null || echo "")
  [[ "$READY" = "true" ]] && break
  sleep 2
done
[[ "$READY" = "true" ]] && pass "snapshot ready" || fail "snapshot not ready after 60s"

RECOVERY_TARGET_TIME=""
if [[ "$WITH_WAL" = "1" ]]; then
  log "5) WAL mode: wrap recoveryTargetTime with markers A (pre, survives) + B (post, lost)"
  # Marker A: post-snapshot, BEFORE target. Flush its WAL so it is
  # durable in the archive, THEN capture the target time.
  psql_pg "INSERT INTO e2e_pitr_marker (id, label) VALUES (500, 'marker-A-pre-target-MUST-SURVIVE');" >/dev/null
  flush_wal
  echo "  marker A (id=500) inserted + WAL flushed"
  # Capture target from postgres NOW() (avoids harness/cluster clock skew).
  sleep 3
  RECOVERY_TARGET_TIME=$(psql_pg "SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');" | tr -d ' ')
  echo "  recoveryTargetTime captured: $RECOVERY_TARGET_TIME"
  [[ -n "$RECOVERY_TARGET_TIME" ]] || fail "failed to capture recoveryTargetTime"
  # Marker B: AFTER the target — must be replayed-past and dropped.
  sleep 3
  psql_pg "INSERT INTO e2e_pitr_marker (id, label) VALUES (999, 'marker-B-post-target-MUST-BE-LOST');" >/dev/null
  flush_wal
  echo "  marker B (id=999) inserted POST-target + WAL flushed"
  POST_COUNT=$(psql_pg "SELECT COUNT(*) FROM e2e_pitr_marker;")
  echo "  rows now: $POST_COUNT (should be 3: pre-snapshot + A + B)"
  [[ "$POST_COUNT" = "3" ]] || fail "expected 3 rows in WAL mode, got $POST_COUNT"
else
  log "5) Insert POST-snapshot row that MUST be lost on restore"
  psql_pg "INSERT INTO e2e_pitr_marker (id, label) VALUES (999, 'post-snapshot-MUST-BE-LOST');" >/dev/null
  POST_COUNT=$(psql_pg "SELECT COUNT(*) FROM e2e_pitr_marker;")
  echo "  post-snapshot rows: $POST_COUNT (should be 2)"
  [[ "$POST_COUNT" = "2" ]] || fail "expected 2 rows after second insert"
fi

log "6) Verify status endpoint reports no restore in progress"
STATUS=$(curl_admin "$ADMIN_HOST/api/v1/admin/postgres-restore/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["inProgress"])')
[[ "$STATUS" = "False" ]] && pass "status=in-progress=false (idle)" || fail "expected idle, got inProgress=$STATUS"

log "7) Trigger PITR auto-promote (async — returns 202 immediately)"
if [[ "$WITH_WAL" = "1" ]]; then
  echo "  POST /api/v1/admin/postgres-restore { snapshot=$SNAP, recoveryTargetTime=$RECOVERY_TARGET_TIME }"
  echo "  WAL mode: slow-path — wrap snap → temp cluster (WAL replay to target) → handoff → recreate → cleanup"
  RESTORE_BODY="{\"clusterNamespace\":\"platform\",\"clusterName\":\"system-db\",\"snapshotName\":\"$SNAP\",\"recoveryTargetTime\":\"$RECOVERY_TARGET_TIME\"}"
else
  echo "  POST /api/v1/admin/postgres-restore { snapshot=$SNAP }"
  echo "  this will: wrap snap → temp cluster → handoff → DELETE source → recreate from temp → cleanup"
  RESTORE_BODY="{\"clusterNamespace\":\"platform\",\"clusterName\":\"system-db\",\"snapshotName\":\"$SNAP\"}"
fi
START=$(date +%s)
HTTP=$(curl -sS -k -o /tmp/pitr.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -X POST "$ADMIN_HOST/api/v1/admin/postgres-restore" \
  --max-time 30 \
  -d "$RESTORE_BODY")
ELAPSED=$(( $(date +%s) - START ))
echo "  HTTP=$HTTP in ${ELAPSED}s"
cat /tmp/pitr.json | python3 -m json.tool 2>/dev/null | head -20 || cat /tmp/pitr.json

if [[ "$HTTP" != "202" ]]; then
  fail "POST returned HTTP $HTTP (expected 202): $(cat /tmp/pitr.json)"
fi
# Capture the Job name — it is the tasks.ref_id used by the chip-
# persistence + path-selection assertions below.
JOB_NAME=$(python3 -c 'import json; print(json.load(open("/tmp/pitr.json"))["data"].get("jobName",""))' 2>/dev/null || echo "")
[[ -n "$JOB_NAME" ]] && echo "  jobName=$JOB_NAME" || warn "no jobName in response — chip/path assertions will be skipped"
pass "PITR async accepted in ${ELAPSED}s — orchestration started"

log "7b) Poll status until orchestration completes (≤30 min for HA)"
# Budget covers HA worst-case: 8min temp + 16min recreate-source @
# 3 instances + ~5min snapshot/cleanup + slack. Single-instance
# typically returns in ~6min so the loop exits via the inProgress=False
# success check long before the deadline.
START_POLL=$(date +%s)
LAST_PHASE=""
LAST_PHASE_CHANGE=$START_POLL
HARD_BUDGET=1500       # 25 min absolute (was 30 min unbounded)
STALL_BUDGET=420       # 7 min no phase change → declare stuck

dump_diagnostics() {
  echo ""
  echo "── PITR diagnostics dump ──"
  $KUBECTL get cluster -n platform system-db -o yaml 2>/dev/null | head -80 || true
  echo "── pods in platform ns ──"
  $KUBECTL get pod -n platform -l cnpg.io/cluster=system-db -o wide 2>/dev/null || true
  # An Init-stuck snapshot-recovery pod is the known single-node failure
  # signature (Longhorn volume-from-snapshot never attaching) — describe
  # any non-Running cluster pod so the RCA is in the log, not lost with
  # the cluster state.
  for p in $($KUBECTL get pod -n platform -l cnpg.io/cluster=system-db \
      --field-selector=status.phase!=Running -o name 2>/dev/null); do
    echo "── describe $p (non-Running) ──"
    $KUBECTL describe -n platform "$p" 2>/dev/null | tail -30 || true
  done
  echo "── recent events ──"
  $KUBECTL get events -n platform --sort-by='.lastTimestamp' 2>/dev/null | tail -20 || true
  echo "── postgres-restore status ──"
  curl_admin "$ADMIN_HOST/api/v1/admin/postgres-restore/status" 2>/dev/null | head -50 || true
  echo ""
}

# Best-effort un-brick when the orchestration fails mid-flight. fail()
# exits immediately, which used to skip BOTH the Flux-resume assertion
# (step 13) and the temp-cluster/snapshot cleanup (step 11) — leaving the
# cluster in suspended-Flux limbo with orphaned PITR resources on top of
# whatever broke. This does NOT touch the system-db cluster itself
# (recreating/dropping a system DB is an operator decision — see
# 'STOP before any DROP on a system PVC'); it only restores GitOps flow
# and removes the orchestrator's scratch resources.
recover_best_effort() {
  echo ""
  echo "── best-effort recovery (orchestration failed mid-flight) ──"
  # 1. Resume Flux so manifest changes propagate again. If platform-api
  #    is down (system-db dead) recoverInterruptedRestore can never run,
  #    so this is the only resume path.
  local fs
  fs=$($KUBECTL get kustomization -n flux-system platform -o jsonpath='{.spec.suspend}' 2>/dev/null || echo "missing")
  if [[ "$fs" = "true" ]]; then
    $KUBECTL patch kustomization -n flux-system platform --type=merge -p "'{\"spec\":{\"suspend\":false}}'" >/dev/null 2>&1 \
      && echo "  resumed Flux Kustomization platform/flux-system" \
      || echo "  WARN: could not resume Flux Kustomization (do it manually!)"
  else
    echo "  Flux Kustomization suspend=$fs (no resume needed)"
  fi
  # 2. Remove leftover temp PITR clusters (fire-and-forget). Temp
  #    clusters are pure scratch by this point — the orchestrator only
  #    deletes the source AFTER the handoff out of the temp completed.
  for c in $($KUBECTL get cluster -n platform -l insula.host/pitr-restore=true -o name 2>/dev/null); do
    echo "  deleting leftover temp cluster $c"
    $KUBECTL delete -n platform "$c" --wait=false --timeout=30s 2>&1 | tail -1
  done
  # 3. Deliberately DO NOT delete pitr-vs-* VolumeSnapshots /
  #    pitr-content-* VolumeSnapshotContents / pitr-handoff-* Longhorn
  #    snapshots on the FAILURE path. When the orchestration stalls
  #    mid-recreate, CNPG keeps retrying the snapshot-recovery from the
  #    pitr-vs-* VolumeSnapshot — deleting it converts a recoverable
  #    stall (e.g. transient Longhorn scheduling pressure) into a LOST
  #    RECOVERY SOURCE: the recreated PVC can never clone, and the only
  #    remaining copy is the Retained pre-restore PV (manual DR:
  #    clear claimRef → re-create PVC system-db-1 with the cnpg.io
  #    labels/annotations → delete + Flux-recreate the Cluster CR →
  #    CNPG adopts the PGDATA). Learned the hard way on testing
  #    2026-06-11. Scratch snapshots are cleaned by step 11 on the
  #    SUCCESS path only; on failure they are the operator's safety
  #    net, not litter.
  echo "  NOTE: system-db itself and all pitr-* snapshots were NOT touched."
  echo "  If system-db is unhealthy/missing: CNPG may still self-recover from"
  echo "  the pitr-vs-* VolumeSnapshot once the underlying blocker clears"
  echo "  (e.g. Longhorn 'insufficient storage' → temporarily raise"
  echo "  storage-over-provisioning-percentage). Otherwise recover via the"
  echo "  Retained pre-restore PV per docs/operations/ DR runbooks. Check the"
  echo "  describe output above for the Init-stuck snapshot-recovery signature."
  echo ""
}

RESTORED=false
while :; do
  NOW=$(date +%s)
  ELAPSED_POLL=$((NOW - START_POLL))
  STALL=$((NOW - LAST_PHASE_CHANGE))

  IN_PROGRESS=$(curl_admin "$ADMIN_HOST/api/v1/admin/postgres-restore/status" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["inProgress"])' 2>/dev/null || echo "unreachable")
  CLUSTER_PHASE=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.status.phase}' 2>/dev/null || echo "missing")
  if [[ "$CLUSTER_PHASE" != "$LAST_PHASE" ]]; then
    echo "  [${ELAPSED_POLL}s] inProgress=$IN_PROGRESS  cluster.phase=$CLUSTER_PHASE"
    LAST_PHASE="$CLUSTER_PHASE"
    LAST_PHASE_CHANGE=$NOW
  fi
  if [[ "$IN_PROGRESS" = "False" && "$CLUSTER_PHASE" = "Cluster in healthy state" ]]; then
    pass "orchestration finished after ${ELAPSED_POLL}s — cluster healthy + lock released"
    RESTORED=true
    break
  fi
  if [[ $ELAPSED_POLL -ge $HARD_BUDGET ]]; then
    echo "  [${ELAPSED_POLL}s] HARD-TIMEOUT reached"
    dump_diagnostics
    recover_best_effort
    fail "PITR hard-timeout: ${ELAPSED_POLL}s elapsed without completion (inProgress=$IN_PROGRESS phase=$CLUSTER_PHASE)"
  fi
  if [[ $STALL -ge $STALL_BUDGET ]]; then
    echo "  [${ELAPSED_POLL}s] STALL: phase $CLUSTER_PHASE held ${STALL}s"
    dump_diagnostics
    recover_best_effort
    fail "PITR stuck: cluster.phase=$CLUSTER_PHASE held for ${STALL}s with no change (inProgress=$IN_PROGRESS)"
  fi
  sleep 10
done
TOTAL_ELAPSED=$(( $(date +%s) - START ))
ELAPSED=$TOTAL_ELAPSED  # for final log line

log "8) Confirm source healthy (already verified by status poll above)"
PHASE_AFTER=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.status.phase}' 2>/dev/null || echo "missing")
if [[ "$PHASE_AFTER" != "Cluster in healthy state" ]]; then
  dump_diagnostics
  recover_best_effort
  fail "source not healthy: $PHASE_AFTER"
fi
pass "source healthy: $PHASE_AFTER"

log "9) Round-trip assertion"
ROW_PRE=$(psql_ro "SELECT label FROM e2e_pitr_marker WHERE id=1;" || echo "")
echo "  pre-snapshot row: '$ROW_PRE' (expect 'pre-snapshot')"
[[ "$ROW_PRE" = "pre-snapshot" ]] || fail "pre-snapshot row missing — restore lost data!"
if [[ "$WITH_WAL" = "1" ]]; then
  ROW_A=$(psql_ro "SELECT COUNT(*) FROM e2e_pitr_marker WHERE id=500;" || echo "0")
  ROW_B=$(psql_ro "SELECT COUNT(*) FROM e2e_pitr_marker WHERE id=999;" || echo "0")
  echo "  marker A (id=500, pre-target) count: $ROW_A (expect 1 — WAL replayed up to target)"
  echo "  marker B (id=999, post-target) count: $ROW_B (expect 0 — replay stopped at target)"
  [[ "$ROW_A" = "1" ]] || fail "marker A missing — WAL replay didn't reach target time (target too early?)"
  [[ "$ROW_B" = "0" ]] || fail "marker B survived — WAL replayed BEYOND recoveryTargetTime!"
  pass "WAL round-trip verified: replay reached target (A present) + stopped there (B gone)"
else
  ROW_POST=$(psql_ro "SELECT COUNT(*) FROM e2e_pitr_marker WHERE id=999;" || echo "0")
  echo "  post-snapshot row count: $ROW_POST (expect 0)"
  [[ "$ROW_POST" = "0" ]] || fail "post-snapshot row survived — restore did NOT roll back!"
  pass "round-trip verified: only pre-snapshot data present"
fi

# ── Folded from integration-postgres-snapshot-restore.sh (2026-07-02) ──
# 9a) Fast/slow path selection: WAL mode MUST create the temp cluster
#     (no SKIPPED); default mode MUST skip it (fast-path). 9b) plugin
#     sidecar propagation on the recreated primary (no manual bounce).
#     9c) task chip terminal + step timeline persisted (modal-reopen).
if [[ -n "$JOB_NAME" ]]; then
  NEW_PRIMARY=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.status.currentPrimary}' 2>/dev/null || echo "")

  log "9a) Path selection: create-temp-cluster SKIPPED?"
  CHIP_STEPS_RAW=$(psql_ro "SELECT details->'steps' FROM tasks WHERE ref_id='$JOB_NAME';" || echo "")
  if [[ "$WITH_WAL" = "1" ]]; then
    if printf '%s' "$CHIP_STEPS_RAW" | grep -q 'SKIPPED'; then
      fail "WAL mode took the fast-path (SKIPPED) — slow-path required for WAL replay"
    else
      pass "WAL mode took the slow-path (temp cluster created) — required for WAL replay"
    fi
  else
    if printf '%s' "$CHIP_STEPS_RAW" | grep -q 'SKIPPED'; then
      pass "default mode took the fast-path (temp cluster skipped) — ~3-5 min saved"
    else
      warn "default mode took the slow-path — fast-path may be disabled via PITR_FORCE_TEMP_CLUSTER"
    fi
  fi

  log "9b) Plugin sidecar propagation (no manual pod-bounce)"
  PLUGINS_IN_SPEC=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.spec.plugins}' 2>/dev/null || echo "")
  if [[ -n "$PLUGINS_IN_SPEC" && "$PLUGINS_IN_SPEC" != "null" && "$PLUGINS_IN_SPEC" != "[]" ]]; then
    # Poll, don't snapshot. The orchestration's wait-barman-sidecar step (10d) now
    # forces the injecting recreate + confirms stability before it returns, so the
    # sidecar is normally already present on the first read — but re-resolve
    # currentPrimary each tick and allow a bounded grace before judging.
    #
    # Detect via `-o yaml | grep`, NOT a jsonpath: the suite's $KUBECTL is
    # `$SSH kubectl` (line 77) which does NOT shell-quote remote args, so a
    # jsonpath containing spaces/pipes ({range ...}{" "}{end}|...) is word-split by
    # the remote shell into "unclosed action" errors → a FALSE miss even when the
    # sidecar is present (root-caused 2026-07-09 — this made 9b unreliable since it
    # was added). -o yaml has no shell-special chars and survives. plugin-barman-
    # cloud is a native sidecar: an initContainer named `plugin-barman-cloud`.
    SIDE_OK=0; SIDE_PRIMARY=""
    for _ in $(seq 1 36); do   # 36 × 5s = 3 min
      SIDE_PRIMARY=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.status.currentPrimary}' 2>/dev/null || echo "")
      if [[ -n "$SIDE_PRIMARY" ]]; then
        $KUBECTL get pod -n platform "$SIDE_PRIMARY" -o yaml 2>/dev/null \
          | grep -q "name: plugin-barman-cloud" && { SIDE_OK=1; break; }
      fi
      sleep 5
    done
    if [[ "$SIDE_OK" == "1" ]]; then
      pass "plugin-barman-cloud sidecar PRESENT on recreated primary ${SIDE_PRIMARY} — WAL archiving re-established"
    else
      fail "plugin-barman-cloud sidecar MISSING on ${SIDE_PRIMARY:-primary} after 3m — wait-barman-sidecar did not re-establish WAL archiving"
    fi
  else
    warn "source cluster had no spec.plugins — skipping sidecar check"
  fi

  log "9c) Task-center chip persistence (modal-reopen must render history)"
  CHIP_ROW=$(psql_ro "SELECT status || '|' || jsonb_array_length(COALESCE(details->'steps','[]'::jsonb)) FROM tasks WHERE ref_id='$JOB_NAME';" || echo "")
  CHIP_STATUS="${CHIP_ROW%%|*}"
  CHIP_STEPS_LEN="${CHIP_ROW##*|}"
  echo "  chip: status=$CHIP_STATUS steps=$CHIP_STEPS_LEN"
  if [[ "$CHIP_STATUS" = "succeeded" ]]; then
    pass "chip.status='succeeded' (finalized via finishByRef)"
  else
    fail "chip.status='$CHIP_STATUS' (expected 'succeeded')"
  fi
  if [[ "${CHIP_STEPS_LEN:-0}" =~ ^[0-9]+$ ]] && [[ "${CHIP_STEPS_LEN:-0}" -ge 5 ]]; then
    pass "chip.details.steps has $CHIP_STEPS_LEN entries — modal reopen renders timeline"
  else
    fail "chip.details.steps too short ($CHIP_STEPS_LEN) — modal reopen would be blank"
  fi
else
  warn "no JOB_NAME — skipping path-selection / sidecar / chip assertions"
fi

log "10) Cluster identity: instance count preserved"
INSTANCES_AFTER=$($KUBECTL get cluster -n platform system-db -o jsonpath='{.spec.instances}')
[[ "$INSTANCES_AFTER" = "$INSTANCES_BEFORE" ]] && pass "instances=$INSTANCES_AFTER (preserved)" || warn "instances changed: $INSTANCES_BEFORE → $INSTANCES_AFTER"

# Discover temp clusters by label rather than by name (the HTTP
# response may not have included the name if the request was killed
# mid-cutover). Any cluster carrying the insula.host/
# pitr-restore label is a temp cluster.
log "11) Discover + clean any leftover temp PITR clusters"
LEFTOVER=$($KUBECTL get cluster -n platform -l insula.host/pitr-restore=true -o name 2>/dev/null)
if [[ -n "$LEFTOVER" ]]; then
  warn "leftover temp clusters: $LEFTOVER (cleaning manually — orchestration crash mid-cutover prevented auto-cleanup)"
  for c in $LEFTOVER; do
    $KUBECTL delete -n platform "$c" --wait=false 2>&1 | tail -1
  done
else
  pass "no leftover temp PITR clusters"
fi

LEAKED_VS=$($KUBECTL get volumesnapshot -n platform -o name 2>/dev/null | grep -c "pitr-vs-" || true)
LEAKED_VSC=$($KUBECTL get volumesnapshotcontent -o name 2>/dev/null | grep -c "pitr-content-" || true)
LEAKED_LH=$($KUBECTL get snapshot.longhorn.io -n longhorn-system -o name 2>/dev/null | grep -c "pitr-handoff-" || true)
if [[ "$LEAKED_VS" -gt 0 || "$LEAKED_VSC" -gt 0 || "$LEAKED_LH" -gt 0 ]]; then
  warn "leaked: $LEAKED_VS VolumeSnapshot(s), $LEAKED_VSC VolumeSnapshotContent(s), $LEAKED_LH longhorn snapshot(s) — cleaning"
  for vs in $($KUBECTL get volumesnapshot -n platform -o name 2>/dev/null | grep "pitr-vs-"); do
    $KUBECTL delete -n platform "$vs" --wait=false 2>&1 | tail -1
  done
  for vsc in $($KUBECTL get volumesnapshotcontent -o name 2>/dev/null | grep "pitr-content-"); do
    $KUBECTL delete "$vsc" --wait=false 2>&1 | tail -1
  done
  for lh in $($KUBECTL get snapshot.longhorn.io -n longhorn-system -o name 2>/dev/null | grep "pitr-handoff-"); do
    # --wait=false + --timeout=30s: snapshot finalizers can hang
    # indefinitely when the longhorn-manager controller isn't
    # processing them (observed 2026-05-18: a stuck finalizer kept
    # this call running for 6h41m, blocking the whole suite). Match
    # the fire-and-forget semantics used by the VS / VSC cleanups
    # above — the orphan-snapshot is best-effort cleanup, not a
    # correctness gate.
    $KUBECTL delete -n longhorn-system "$lh" --wait=false --timeout=30s 2>&1 | tail -1
  done
else
  pass "no leaked VolumeSnapshots / VolumeSnapshotContents / longhorn snapshots"
fi

log "11b) Reclaim the superseded pre-restore system-db PV (Longhorn budget)"
# Every auto-promote leaves the PREVIOUS system-db PV Released with
# reclaimPolicy=Retain (deliberate operator safety net — see ROADMAP
# R17 item 3). Its replica keeps pinning the full volume size of
# Longhorn SCHEDULING budget, so on a small single node the NEXT
# PITR's recovery volume fails Longhorn's "insufficient storage"
# precheck and the orchestration stalls mid-cutover with system-db
# down (reproduced twice on testing, 2026-06-10/11 — every second
# full pass). On a TEST cluster the Retained copy's purpose is served
# the moment step 9 verified the round-trip, so reclaim it here: PV
# object AND the volumes.longhorn.io CR (deleting only the PV leaves
# the Longhorn volume — and its budget pin — behind). Production
# operators keep the confirmed-delete flow (R17).
RECLAIMED=0
for PV in $($KUBECTL get pv -o jsonpath="'{range .items[?(@.status.phase==\"Released\")]}{.metadata.name}={.spec.claimRef.namespace}/{.spec.claimRef.name} {end}'" 2>/dev/null); do
  PV_NAME="${PV%%=*}"
  PV_CLAIM="${PV#*=}"
  [[ "$PV_CLAIM" == platform/system-db-* ]] || continue
  echo "  reclaiming superseded $PV_NAME (claim was $PV_CLAIM)"
  $KUBECTL delete pv "$PV_NAME" --wait=false --timeout=30s 2>&1 | tail -1
  $KUBECTL delete -n longhorn-system "volumes.longhorn.io/$PV_NAME" --wait=false --timeout=30s 2>&1 | tail -1
  RECLAIMED=$((RECLAIMED + 1))
done
if [[ "$RECLAIMED" -gt 0 ]]; then
  pass "reclaimed $RECLAIMED superseded system-db PV(s) — Longhorn budget freed for the next run"
else
  pass "no superseded system-db Released PVs to reclaim"
fi

log "12) Write-lock smoke: status endpoint reports idle"
# Re-login because the original token may have expired during the long PITR
TOKEN=$(curl -sS -k -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["data"]["token"])' 2>/dev/null)
STATUS_NOW=$(curl_admin "$ADMIN_HOST/api/v1/admin/postgres-restore/status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["inProgress"])' 2>/dev/null || echo "unreachable")
[[ "$STATUS_NOW" = "False" ]] && pass "post-restore status=idle (lock released)" || warn "lock state: inProgress=$STATUS_NOW (DB lock should clear on next platform-api restart via recoverInterruptedRestore)"

log "13) Flux Kustomization MUST NOT be left suspended"
# PITR suspends the platform Kustomization for the cutover window.
# The orchestrator's finally block + recoverInterruptedRestore are the
# only places that resume it. If we land here with suspend=true the
# cluster is in suspended-Flux limbo (manifest changes don't propagate)
# until an operator notices.
FLUX_SUSPEND=$($KUBECTL get kustomization -n flux-system platform -o jsonpath='{.spec.suspend}' 2>/dev/null || echo "missing")
if [[ "$FLUX_SUSPEND" = "true" ]]; then
  warn "Flux Kustomization platform/flux-system is suspended — auto-resume failed; forcing resume"
  # NOTE: $KUBECTL goes through ssh — the remote shell re-parses the argv,
  # so the JSON needs an extra quoting layer or its double quotes get eaten.
  $KUBECTL patch kustomization -n flux-system platform --type=merge -p "'{\"spec\":{\"suspend\":false}}'" >/dev/null
  fail "PITR left Flux suspended; orchestrator's resume path is broken"
elif [[ "$FLUX_SUSPEND" = "missing" ]]; then
  warn "Flux Kustomization platform/flux-system not found — skipping suspend assertion"
else
  pass "Flux Kustomization resumed (spec.suspend=$FLUX_SUSPEND)"
fi

log "14) Cleanup sentinel table"
psql_pg "DROP TABLE IF EXISTS e2e_pitr_marker;" >/dev/null
pass "sentinel table dropped"

log "DONE: Postgres PITR E2E green (total=${ELAPSED}s, async pattern)"
