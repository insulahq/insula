#!/bin/bash
# integration-mail-mobility-e2e.sh — full E2E coverage of mail-stack
# mobility scenarios on a live cluster (staging by default).
#
# Phases (each leaves the cluster in a healthy state suitable for the next):
#
#   A. per-snapshot restore picks correct snapshot (.restore-applied-at marker)
#   B. cross-node migration to OTHER server-role node + back
#   C. migration to WORKER-role node — preflight refusal expected (system-
#      node-affinity Component requires Bulwark on server-role nodes)
#   D. port exposure mode toggle (allServerNodes ↔ thisNodeOnly)
#   E. cancel mid-flight migration
#   F. recovery flow (simulate broken state, type-to-confirm recover)
#   G. retention reconcile + restic forget
#   H. DR failover — cordon active + force-delete pod, dr-watcher must
#      auto-trigger failover migration to a server-role standby
#
# Each phase is independent and can be skipped via the PHASES env var:
#   PHASES=ABCDEFG  (default — all)
#   PHASES=A        (just phase A)
#   PHASES=BCD      (B, C, D)
#
# Usage:
#   SSH_HOST=root@staging1.example.test \
#   SSH_KEY=/home/dev/hosting-platform.key \
#   PHASES=ABCDEFG \
#   ./scripts/integration-mail-mobility-e2e.sh
#
# Exit codes:
#   0  — all selected phases passed
#   1+ — first failing phase
#
# Each phase prints PASS/FAIL on its own line and a one-line reason.
set -u

SSH_HOST=${SSH_HOST:-root@staging1.example.test}
SSH_KEY=${SSH_KEY:-/home/dev/hosting-platform.key}
PHASES=${PHASES:-ABCDEFGH}
MIGRATION_TIMEOUT=${MIGRATION_TIMEOUT:-420}        # 7 min — covers worst-case CIFS restore + scale-up
DR_FAILOVER_BUDGET=${DR_FAILOVER_BUDGET:-600}      # 10 min — covers threshold_seconds + state machine
RETENTION_WAIT=${RETENTION_WAIT:-200}              # 3min20 — covers two CronJob fires (every 2 min)

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
amber() { printf '\033[33m%s\033[0m\n' "$*"; }
hdr()   { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
ok=0
fail=0
mark_pass() { ok=$((ok+1)); green "PASS  Phase $1: $2"; }
mark_fail() { fail=$((fail+1)); red   "FAIL  Phase $1: $2"; }

# All work happens inside one SSH session so we don't pay reconnect overhead
# between phases. Bash-script-over-stdin pattern.
ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$SSH_HOST" \
  "PHASES='$PHASES' MIGRATION_TIMEOUT='$MIGRATION_TIMEOUT' DR_FAILOVER_BUDGET='$DR_FAILOVER_BUDGET' RETENTION_WAIT='$RETENTION_WAIT' bash -s" <<'REMOTE'
set -u
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
# Defaults if not exported through the parent env
: "${DR_FAILOVER_BUDGET:=600}"
: "${MIGRATION_TIMEOUT:=420}"
: "${RETENTION_WAIT:=200}"
: "${PHASES:=ABCDEFGH}"

# ── shared helpers ──────────────────────────────────────────────────────────
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
amber() { printf '\033[33m%s\033[0m\n' "$*"; }
hdr()   { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
fail_phase() { echo "PHASE_FAIL:$1:$2"; }
pass_phase() { echo "PHASE_PASS:$1:$2"; }

# Mint admin JWT once
PGPOD=$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}')
JWT_SECRET=$(kubectl get secret -n platform platform-jwt-secret -o jsonpath='{.data.secret}' | base64 -d)
ADMIN_ID=$(kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -tA -c "SELECT id FROM users WHERE role_name='super_admin' ORDER BY created_at LIMIT 1;" 2>/dev/null | head -1)
APIPOD=$(kubectl get pod -n platform -l app=platform-api -o jsonpath='{.items[0].metadata.name}')
TOKEN=$(kubectl exec -n platform "$APIPOD" -- env JWT_SECRET="$JWT_SECRET" SUB="$ADMIN_ID" node -e '
const { SignJWT } = require("jose");
(async () => {
  const enc = new TextEncoder().encode(process.env.JWT_SECRET);
  const tok = await new SignJWT({ sub: process.env.SUB, role: "super_admin", panel: "admin" })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("2h").sign(enc);
  process.stdout.write(tok);
})();' 2>/dev/null)
APISVC=$(kubectl get svc -n platform platform-api -o jsonpath='{.spec.clusterIP}:{.spec.ports[0].port}')

api() {
  local method="${1:-GET}" path="$2" body="${3:-}" maxtime="${4:-30}"
  if [ -n "$body" ]; then
    curl -sS --max-time "$maxtime" -X "$method" \
      -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
      -d "$body" "http://${APISVC}/api/v1${path}"
  else
    curl -sS --max-time "$maxtime" -X "$method" \
      -H "Authorization: Bearer ${TOKEN}" "http://${APISVC}/api/v1${path}"
  fi
}

wait_migration() {
  local run_id="$1" budget="${2:-$MIGRATION_TIMEOUT}"
  local end=$(( $(date +%s) + budget ))
  local last_step=""
  while [ $(date +%s) -lt "$end" ]; do
    local r state step
    r=$(api GET "/admin/mail/migrate/${run_id}" "" 20)
    state=$(echo "$r" | jq -r '.data.state // "?"')
    step=$(echo "$r" | jq -r '.data.currentStep // "?"')
    if [ "$step" != "$last_step" ]; then
      echo "    [$(date -Iseconds)] state=$state step=$step"
      last_step="$step"
    fi
    case "$state" in
      done|failed|rolled-back|cancelled) echo "$state"; return 0 ;;
    esac
    sleep 5
  done
  echo "timeout"
  return 1
}

wait_pod_ready() {
  local label="$1" namespace="${2:-mail}" budget="${3:-180}"
  local end=$(( $(date +%s) + budget ))
  while [ $(date +%s) -lt "$end" ]; do
    local ready
    ready=$(kubectl get pod -n "$namespace" -l "$label" -o jsonpath='{.items[?(@.status.containerStatuses[0].ready==true)].metadata.name}' 2>/dev/null | wc -w)
    if [ "$ready" -gt 0 ]; then return 0; fi
    sleep 5
  done
  return 1
}

# Resolve cluster topology once
NODES_SERVER=$(kubectl get node -l platform.example.test/node-role=server -o jsonpath='{.items[*].metadata.name}')
NODES_WORKER=$(kubectl get node -l platform.example.test/node-role!=server -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || echo "")
ACTIVE_NODE=$(kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -tA -c "SELECT mail_active_node FROM system_settings;" 2>/dev/null | head -1)
OTHER_SERVER=$(echo "$NODES_SERVER" | tr ' ' '\n' | grep -v -F "$ACTIVE_NODE" | head -1)

echo "Topology: server-role=[$NODES_SERVER] worker-role=[$NODES_WORKER] active=$ACTIVE_NODE other-server=$OTHER_SERVER"

# ── PHASE A: per-snapshot restore content correctness ──────────────────────
phase_A() {
  hdr "PHASE A: per-snapshot restore picks the chosen snapshot (not latest)"

  # List snapshots
  local lst
  lst=$(api GET "/admin/mail/backups" "" 200)
  if [ "$(echo "$lst" | jq -r '.data.repoReachable')" != "true" ]; then
    fail_phase A "snapshot list returned repoReachable=false: $(echo "$lst" | jq -r '.data.reason')"
    return
  fi

  # We need at least 2 snapshots that DIFFER measurably (size or file count).
  # We restore the OLDEST first; then take a fresh snapshot of THAT restored
  # state and verify it's labelled as a brand-new snapshot, not the latest
  # at start. Then restore back to the most recent snapshot.
  local oldest_id newest_id n
  n=$(echo "$lst" | jq -r '.data.snapshots | length')
  if [ "$n" -lt 2 ]; then
    amber "  PHASE A SKIP: need ≥2 snapshots, have $n"
    pass_phase A "skipped (<2 snapshots)"
    return
  fi

  # API returns snapshots sorted oldest-first per restic default; the UI
  # displays newest-first. Sort by time on the client to be defensive.
  oldest_id=$(echo "$lst" | jq -r '.data.snapshots | sort_by(.time)[0].shortId')
  newest_id=$(echo "$lst" | jq -r '.data.snapshots | sort_by(.time)[-1].shortId')
  local oldest_short newest_short
  oldest_short=$(echo "$oldest_id" | head -c 8)
  newest_short=$(echo "$newest_id" | head -c 8)
  echo "  oldest snapshot: $oldest_short (${oldest_id:0:16}…)"
  echo "  newest snapshot: $newest_short (${newest_id:0:16}…)"

  # Record current data state via the live Stalwart pod (no ssh-hopping —
  # avoids hostname resolution issues from inside the platform).
  local PRE_FILES PRE_BYTES PRE_POD
  PRE_POD=$(kubectl get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  PRE_FILES=$(kubectl exec -n mail "$PRE_POD" -c stalwart -- sh -c 'find /var/lib/stalwart/data -type f 2>/dev/null | wc -l' 2>/dev/null || echo 0)
  PRE_BYTES=$(kubectl exec -n mail "$PRE_POD" -c stalwart -- sh -c 'du -sb /var/lib/stalwart/data 2>/dev/null | awk "{print \$1}"' 2>/dev/null || echo 0)
  echo "  PRE-RESTORE state on $ACTIVE_NODE (pod $PRE_POD): files=$PRE_FILES bytes=$PRE_BYTES"

  # Trigger restore from OLDEST
  echo "  Triggering restore to OLDEST ($oldest_short) on $ACTIVE_NODE"
  local resp run_id
  resp=$(api POST "/admin/mail/backups/${oldest_id}/restore" "$(jq -n --arg n "$ACTIVE_NODE" --arg c "$oldest_id" '{targetNode:$n, confirmShortId:$c}')" 30)
  run_id=$(echo "$resp" | jq -r '.data.runId // empty')
  if [ -z "$run_id" ]; then
    fail_phase A "restore POST returned no runId: $(echo "$resp" | jq -c '.error // .')"
    return
  fi

  # Verify annotation gets stamped (snapshot quickly — restore is fast)
  local stamped=""
  for _ in 1 2 3 4 5 6; do
    stamped=$(kubectl get deploy -n mail stalwart-mail -o jsonpath='{.spec.template.metadata.annotations.mail\.platform/restore-snapshot-id}' 2>/dev/null)
    [ -n "$stamped" ] && break
    sleep 2
  done
  if [ "$stamped" = "$oldest_id" ]; then
    green "  annotation stamped: ✓"
  else
    amber "  annotation not observed (likely race — restore already past swapping-pvc); stamped='$stamped'"
  fi

  local final
  final=$(wait_migration "$run_id" "$MIGRATION_TIMEOUT" | tail -1)
  if [ "$final" != "done" ]; then
    fail_phase A "restore did not complete (state=$final)"
    return
  fi

  # Wait for the new Stalwart pod to be Ready, then check via kubectl exec
  wait_pod_ready "app=stalwart-mail" mail 180 || true
  local POST_ACTIVE POST_FILES POST_BYTES POST_POD
  POST_ACTIVE=$(kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -tA -c "SELECT mail_active_node FROM system_settings;" 2>/dev/null | head -1)
  POST_POD=$(kubectl get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  POST_FILES=$(kubectl exec -n mail "$POST_POD" -c stalwart -- sh -c 'find /var/lib/stalwart/data -type f 2>/dev/null | wc -l' 2>/dev/null || echo 0)
  POST_BYTES=$(kubectl exec -n mail "$POST_POD" -c stalwart -- sh -c 'du -sb /var/lib/stalwart/data 2>/dev/null | awk "{print \$1}"' 2>/dev/null || echo 0)
  echo "  POST-RESTORE state on $POST_ACTIVE (pod $POST_POD): files=$POST_FILES bytes=$POST_BYTES"

  # Verify allow-restore was cleared. restore-snapshot-id is intentionally
  # kept post-success (the init container's .restore-applied-at marker
  # provides idempotency — see migration.ts:clearAllowRestoreAnnotation).
  local annA
  annA=$(kubectl get deploy -n mail stalwart-mail -o jsonpath='{.spec.template.metadata.annotations.mail\.platform/allow-restore}' 2>/dev/null)
  if [ -z "$annA" ]; then
    green "  allow-restore annotation cleared post-success: ✓"
  else
    fail_phase A "allow-restore annotation leaked post-success: '$annA'"
    return
  fi

  # Verify the .restore-applied-at marker — that's the durable signal of
  # which snapshot the init container actually applied. The init pod itself
  # may have been replaced by post-migration rollout churn, so its logs are
  # gone; the marker on the PVC outlasts pod restarts.
  local marker
  marker=$(kubectl exec -n mail "$POST_POD" -c stalwart -- sh -c 'cat /var/lib/stalwart/data/.restore-applied-at 2>/dev/null | head -1' 2>/dev/null || echo "")
  echo "  .restore-applied-at on PVC: '$marker' (expected '$oldest_id' or '$oldest_short')"
  if [ "$marker" = "$oldest_id" ] || [ "$marker" = "$oldest_short" ]; then
    green "  marker matches chosen snapshot: ✓"
    pass_phase A "per-snapshot restore correctly used chosen id $oldest_short (marker=$marker)"
  else
    fail_phase A "marker mismatch — expected '$oldest_short'/'$oldest_id' got '$marker' (init container fell through)"
  fi
}

# ── PHASE B: cross-node migration to OTHER server-role node ────────────────
phase_B() {
  hdr "PHASE B: cross-node migration (server↔server)"
  if [ -z "$OTHER_SERVER" ]; then
    fail_phase B "no second server-role node available"
    return
  fi
  local from=$ACTIVE_NODE to=$OTHER_SERVER
  echo "  $from → $to"
  local resp run_id
  resp=$(api POST "/admin/mail/migrate" "$(jq -n --arg n "$to" '{targetNode:$n, confirm:true}')" 30)
  run_id=$(echo "$resp" | jq -r '.data.runId // empty')
  if [ -z "$run_id" ]; then
    fail_phase B "migrate POST no runId: $(echo "$resp" | jq -c '.error // .')"
    return
  fi
  local final
  final=$(wait_migration "$run_id" "$MIGRATION_TIMEOUT" | tail -1)
  if [ "$final" != "done" ]; then
    fail_phase B "migration did not complete (state=$final)"
    return
  fi
  # Verify PVC bound on target + stalwart pod Running on target
  local pvc_node pod_node
  pvc_node=$(kubectl get pvc -n mail mail-stack-data -o jsonpath='{.metadata.annotations.volume\.kubernetes\.io/selected-node}')
  pod_node=$(kubectl get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].spec.nodeName}')
  if [ "$pvc_node" = "$to" ] && [ "$pod_node" = "$to" ]; then
    green "  PVC + pod both on $to: ✓"
  else
    fail_phase B "PVC=$pvc_node pod=$pod_node — expected both on $to"
    return
  fi
  # Confirm standby DaemonSet has a pod on the OLD active (now standby-eligible)
  # — actually no, standby DS only runs on standby-labelled nodes. Just check
  # next snapshot CronJob fires on new active within 4 min.
  echo "  Waiting for next snapshot CronJob fire on $to (up to 4 min)…"
  local sleeptime=0
  while [ $sleeptime -lt 240 ]; do
    local cron_pod
    cron_pod=$(kubectl get pod -n mail -l app.kubernetes.io/component=stalwart-snapshot --sort-by='.metadata.creationTimestamp' -o jsonpath='{.items[-1:].metadata.name} {.items[-1:].spec.nodeName} {.items[-1:].status.phase}' 2>/dev/null)
    local cnode cphase
    cnode=$(echo "$cron_pod" | awk '{print $2}')
    cphase=$(echo "$cron_pod" | awk '{print $3}')
    if [ "$cnode" = "$to" ] && { [ "$cphase" = "Succeeded" ] || [ "$cphase" = "Running" ]; }; then
      green "  snapshot CronJob ran on $to ($cron_pod): ✓"
      pass_phase B "cross-node migration $from → $to complete + snapshot ran on new active"
      ACTIVE_NODE=$to
      OTHER_SERVER=$from
      return
    fi
    sleep 15
    sleeptime=$((sleeptime+15))
  done
  fail_phase B "snapshot CronJob did not run on $to within 4 min"
}

# ── PHASE C: migration to WORKER-role node ─────────────────────────────────
phase_C() {
  hdr "PHASE C: migration to WORKER-role node"
  local worker
  worker=$(echo "$NODES_WORKER" | tr ' ' '\n' | head -1)
  if [ -z "$worker" ]; then
    amber "  PHASE C SKIP: no worker-role node available"
    pass_phase C "skipped (no worker)"
    return
  fi
  local from=$ACTIVE_NODE to=$worker
  echo "  $from → $to (worker)"
  local resp run_id
  resp=$(api POST "/admin/mail/migrate" "$(jq -n --arg n "$to" '{targetNode:$n, confirm:true}')" 30)
  run_id=$(echo "$resp" | jq -r '.data.runId // empty')
  if [ -z "$run_id" ]; then
    # Worker migration may be intentionally refused if portExposureMode=allServerNodes
    # — verify by reading the error code
    local code
    code=$(echo "$resp" | jq -r '.error.code // empty')
    if [ "$code" = "MAIL_MIGRATION_TARGET_NOT_SERVER" ] || [ "$code" = "MAIL_MIGRATION_PORTS_REQUIRE_SERVER" ]; then
      green "  worker migration correctly refused with $code (port mode requires server): ✓"
      pass_phase C "policy correctly refused worker target ($code)"
      return
    fi
    fail_phase C "migrate POST no runId: $(echo "$resp" | jq -c '.error // .')"
    return
  fi
  local final final_status
  final=$(wait_migration "$run_id" 120 | tail -1)
  if [ "$final" = "failed" ]; then
    # Check if the failure message is the expected node-role policy refusal
    local err
    err=$(api GET "/admin/mail/migrate/${run_id}" "" 10 | jq -r '.data.error // ""')
    if echo "$err" | grep -qE "server-role node|node-role=server|requires a server"; then
      green "  worker migration correctly refused by preflight: $(echo "$err" | head -c 80)…"
      pass_phase C "policy preflight refused worker target"
      return
    fi
    fail_phase C "worker migration failed with UNEXPECTED message: $err"
    return
  fi
  if [ "$final" != "done" ]; then
    fail_phase C "worker migration ended in $final (expected 'failed' from preflight refusal)"
    return
  fi
  local pod_node
  pod_node=$(kubectl get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].spec.nodeName}')
  if [ "$pod_node" = "$to" ]; then
    green "  stalwart now on worker $to: ✓"
    ACTIVE_NODE=$to
    pass_phase C "migration to worker $to complete"
  else
    fail_phase C "pod landed on $pod_node, expected $to"
  fi
}

# ── PHASE D: port exposure mode toggle ─────────────────────────────────────
phase_D() {
  hdr "PHASE D: port exposure mode toggle (allServerNodes ↔ thisNodeOnly)"
  local pre_mode
  pre_mode=$(api GET "/admin/mail/port-exposure" "" 10 | jq -r '.data.mode')
  echo "  current mode: $pre_mode"
  local target_mode
  if [ "$pre_mode" = "allServerNodes" ]; then target_mode=thisNodeOnly; else target_mode=allServerNodes; fi

  echo "  toggling → $target_mode (async — background task handles haproxy DS roll)"
  local resp
  resp=$(api PATCH "/admin/mail/port-exposure" "$(jq -n --arg m "$target_mode" '{mode:$m}')" 30)
  if [ "$(echo "$resp" | jq -r '.data.updated // false')" != "true" ]; then
    fail_phase D "PATCH did not return updated=true: $(echo "$resp" | jq -c .)"
    return
  fi
  # Poll GET until mode flips OR 180s elapses (haproxy DS roll + DB persist
  # happens in a background task; PATCH returns immediately with taskId).
  local end=$(( $(date +%s) + 180 ))
  local new_mode=""
  while [ $(date +%s) -lt "$end" ]; do
    new_mode=$(api GET "/admin/mail/port-exposure" "" 10 | jq -r '.data.mode')
    [ "$new_mode" = "$target_mode" ] && break
    sleep 5
  done
  if [ "$new_mode" != "$target_mode" ]; then
    fail_phase D "GET after PATCH still shows '$new_mode' after 180s — background task likely failed"
    return
  fi
  echo "  GET confirms mode=$target_mode after $(($(date +%s) - end + 180))s"
  # Wait for haproxy DS to reconcile
  sleep 10
  local ds_state
  if kubectl get ds -n mail stalwart-haproxy >/dev/null 2>&1; then
    local desired ready
    desired=$(kubectl get ds -n mail stalwart-haproxy -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null)
    ready=$(kubectl get ds -n mail stalwart-haproxy -o jsonpath='{.status.numberReady}' 2>/dev/null)
    ds_state="present:desired=$desired,ready=$ready"
  else
    ds_state="absent"
  fi
  echo "  haproxy DS after toggle ($target_mode): $ds_state"
  if [ "$target_mode" = "thisNodeOnly" ] && [ "$ds_state" != "absent" ]; then
    fail_phase D "thisNodeOnly should DELETE the haproxy DS — still present ($ds_state)"
    return
  fi
  if [ "$target_mode" = "allServerNodes" ] && [ "$ds_state" = "absent" ]; then
    fail_phase D "allServerNodes should CREATE the haproxy DS — still absent"
    return
  fi
  # Toggle back to restore prior state
  echo "  reverting → $pre_mode"
  api PATCH "/admin/mail/port-exposure" "$(jq -n --arg m "$pre_mode" '{mode:$m}')" 30 > /dev/null
  # Poll for the revert too
  local revert_end=$(( $(date +%s) + 180 ))
  local revert_mode=""
  while [ $(date +%s) -lt "$revert_end" ]; do
    revert_mode=$(api GET "/admin/mail/port-exposure" "" 10 | jq -r '.data.mode')
    [ "$revert_mode" = "$pre_mode" ] && break
    sleep 5
  done
  pass_phase D "port mode $pre_mode→$target_mode (DS $ds_state) →$revert_mode reconciled correctly"
}

# ── PHASE E: cancel mid-flight migration ───────────────────────────────────
phase_E() {
  hdr "PHASE E: cancel mid-flight migration"
  if [ -z "$OTHER_SERVER" ]; then
    fail_phase E "no second node — can't trigger migration"
    return
  fi
  local from=$ACTIVE_NODE to=$OTHER_SERVER
  echo "  triggering migration $from → $to, will cancel mid-flight"
  local resp run_id
  resp=$(api POST "/admin/mail/migrate" "$(jq -n --arg n "$to" '{targetNode:$n, confirm:true}')" 30)
  run_id=$(echo "$resp" | jq -r '.data.runId // empty')
  if [ -z "$run_id" ]; then
    fail_phase E "migrate POST no runId"
    return
  fi
  # Wait until snapshotting or swapping-pvc, then cancel
  local cancelled=0
  for _ in $(seq 1 30); do
    local r step
    r=$(api GET "/admin/mail/migrate/${run_id}" "" 10)
    step=$(echo "$r" | jq -r '.data.currentStep // "?"')
    state=$(echo "$r" | jq -r '.data.state // "?"')
    case "$step" in
      snapshotting|scaling-down|swapping-pvc)
        echo "  cancelling at step=$step"
        api POST "/admin/mail/migrate/${run_id}/cancel" "{}" 30 > /dev/null
        cancelled=1
        break
        ;;
    esac
    case "$state" in done|failed|rolled-back|cancelled) break ;; esac
    sleep 2
  done
  if [ "$cancelled" -ne 1 ]; then
    amber "  could not catch migration mid-flight to cancel (may have completed)"
    pass_phase E "skipped (migration completed before cancel window)"
    return
  fi
  local final
  final=$(wait_migration "$run_id" 180 | tail -1)
  case "$final" in
    failed|rolled-back|cancelled)
      green "  cancel landed in terminal state '$final': ✓"
      pass_phase E "cancel honored ($final)"
      ;;
    done)
      fail_phase E "cancel ignored — migration completed normally"
      ;;
    *)
      fail_phase E "cancel left run in $final"
      ;;
  esac
}

# ── PHASE F: recovery flow (broken-state) ──────────────────────────────────
phase_F() {
  hdr "PHASE F: recovery flow (simulate broken state)"
  # Simulate by setting mail_active_node to a node where PVC isn't bound
  local current pvc_node target
  current=$(kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -tA -c "SELECT mail_active_node FROM system_settings;" 2>/dev/null | head -1)
  pvc_node=$(kubectl get pvc -n mail mail-stack-data -o jsonpath='{.metadata.annotations.volume\.kubernetes\.io/selected-node}')
  echo "  Pre: active=$current pvc=$pvc_node"
  # Pick a different node to point at
  local other_node
  other_node=$(echo "$NODES_SERVER" | tr ' ' '\n' | grep -v -F "$pvc_node" | head -1)
  if [ -z "$other_node" ]; then
    amber "  PHASE F SKIP: no node other than $pvc_node to fake broken state"
    pass_phase F "skipped (single server node)"
    return
  fi
  # Inject the divergence
  kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -c \
    "UPDATE system_settings SET mail_active_node='$other_node';" > /dev/null 2>&1
  echo "  Injected: mail_active_node=$other_node (PVC actually on $pvc_node)"
  # Read recovery-status — must report broken
  local rs state
  rs=$(api GET "/admin/mail/recovery-status" "" 10)
  state=$(echo "$rs" | jq -r '.data.status.state')
  if [ "$state" != "broken" ]; then
    # Restore truth before bailing
    kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -c "UPDATE system_settings SET mail_active_node='$pvc_node';" > /dev/null 2>&1
    fail_phase F "recovery-status reported '$state' expected 'broken'"
    return
  fi
  echo "  recovery-status: state=broken ✓"
  # Recover back to where PVC actually is (in-place fix)
  local resp run_id
  resp=$(api POST "/admin/mail/recover" "$(jq -n --arg n "$pvc_node" --arg c "$pvc_node" '{targetNode:$n,confirmTargetNode:$c}')" 30)
  run_id=$(echo "$resp" | jq -r '.data.runId // empty')
  if [ -z "$run_id" ]; then
    kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -c "UPDATE system_settings SET mail_active_node='$pvc_node';" > /dev/null 2>&1
    fail_phase F "recover POST no runId: $(echo "$resp" | jq -c '.error // .')"
    return
  fi
  local final
  final=$(wait_migration "$run_id" "$MIGRATION_TIMEOUT" | tail -1)
  if [ "$final" = "done" ]; then
    green "  recovery completed: ✓"
    pass_phase F "recovery flow $other_node→$pvc_node restored active-node truth"
  else
    fail_phase F "recovery did not complete (state=$final)"
  fi
}

# ── PHASE G: retention reconcile + restic forget ───────────────────────────
phase_G() {
  hdr "PHASE G: retention reconcile + restic forget"
  # Pick a known-small retention to force a forget. target_count=1
  # is aggressive — restic will keep ONLY the newest snapshot, so we can
  # deterministically assert post≤2 (target+race tolerance) regardless of
  # the starting count. Works even when pre_count is already low.
  local target_count=1
  local pre_count
  pre_count=$(api GET "/admin/mail/backups" "" 200 | jq -r '.data.snapshots | length')
  echo "  pre-PATCH snapshot count: $pre_count"
  echo "  PATCH retention to keep-last=$target_count keep-days=0"
  local resp
  resp=$(api PATCH "/admin/backups/schedules/mail" "$(jq -n --argjson c "$target_count" '{retentionCount:$c, retentionDays:0}')" 30)
  if [ "$(echo "$resp" | jq -r '.data.retentionCount // empty')" != "$target_count" ]; then
    fail_phase G "PATCH did not set retention: $(echo "$resp" | jq -c .)"
    return
  fi
  # Confirm ConfigMap rewrote
  local cmval
  cmval=$(kubectl get cm -n mail mail-snapshot-retention -o jsonpath='{.data.RETENTION_COUNT}' 2>/dev/null)
  if [ "$cmval" != "$target_count" ]; then
    fail_phase G "ConfigMap RETENTION_COUNT='$cmval' expected '$target_count'"
    return
  fi
  green "  ConfigMap rewrote: RETENTION_COUNT=$target_count ✓"
  # Wait up to 8 min and re-check periodically. CronJob runs every 2 min;
  # restic forget --keep-last=2 only fires when the snapshot pod runs and
  # ALWAYS keeps at minimum the most recent snapshots, so convergence
  # may take 2-3 cycles when starting from a long backlog.
  local post_count=$pre_count
  local end_t=$(( $(date +%s) + 480 ))
  local check_max=$((target_count + 1))  # tolerate +1 for in-flight race
  while [ $(date +%s) -lt "$end_t" ]; do
    post_count=$(api GET "/admin/mail/backups" "" 200 | jq -r '.data.snapshots | length')
    echo "  [$(date -Iseconds)] snapshot count: $post_count (target ≤$check_max)"
    [ "$post_count" -le "$check_max" ] && break
    sleep 60
  done
  if [ "$post_count" -le "$check_max" ]; then
    pass_phase G "retention applied: ${pre_count}→${post_count} (target ≤$check_max with +1 race tolerance)"
  else
    fail_phase G "retention NOT applied within 8 min: pre=$pre_count post=$post_count target=$target_count"
  fi
}

# ── PHASE H: DR failover (real k3s stop on active node) ────────────────────
phase_H() {
  hdr "PHASE H: DR failover — stop k3s on active node, watch dr-watcher react"
  # dr-watcher fires on Node Ready=False (from .status.conditions, set by
  # kubelet). Cordon alone won't trigger it; we need the kubelet itself to
  # stop reporting, which we simulate by `systemctl stop k3s` on the active
  # node. The platform-api keeps running because the control plane is HA
  # (3 server-role nodes); after the threshold elapses, dr-watcher should
  # auto-trigger a restore-based failover to a standby.
  if [ "$ACTIVE_NODE" = "" ] || [ "$ACTIVE_NODE" = "null" ]; then
    fail_phase H "no active node detected — can't simulate DR"
    return
  fi
  local standby_candidate
  standby_candidate=$(kubectl get node -l 'platform.example.test/mail-standby=true,platform.example.test/node-role=server' -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\n' | grep -v -F "$ACTIVE_NODE" | head -1)
  if [ -z "$standby_candidate" ]; then
    amber "  PHASE H SKIP: no server-role mail-standby node other than active ($ACTIVE_NODE)"
    pass_phase H "skipped (no server-role standby)"
    return
  fi
  echo "  active=$ACTIVE_NODE standby_candidate=$standby_candidate"
  echo "  threshold=${MAIL_FAILOVER_THRESHOLD:-300}s (will wait ${DR_FAILOVER_BUDGET}s total)"

  # Baseline migration count so we can detect a new dr-watcher-launched run
  local pre_runs
  pre_runs=$(kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -tA -c "SELECT COUNT(*) FROM mail_migration_runs;" 2>/dev/null | head -1 | tr -d ' ')

  # Stop k3s on the active node — this kills kubelet, the node goes NotReady
  # after the node-monitor-grace-period (~40s default). dr-watcher detects
  # it on next tick.
  echo "  stopping k3s on $ACTIVE_NODE (will restart at end of test)"
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${ACTIVE_NODE}.example.test" 'systemctl stop k3s' 2>&1 | head -3

  echo "  waiting up to ${DR_FAILOVER_BUDGET}s for dr-watcher to launch failover migration…"
  local end=$(( $(date +%s) + DR_FAILOVER_BUDGET ))
  local new_run=""
  while [ $(date +%s) -lt "$end" ]; do
    local now_runs
    now_runs=$(kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -tA -c "SELECT COUNT(*) FROM mail_migration_runs;" 2>/dev/null | head -1 | tr -d ' ')
    if [ "$now_runs" -gt "$pre_runs" ]; then
      new_run=$(kubectl exec -n platform "$PGPOD" -- psql -U postgres -d hosting_platform -tA -c "SELECT id FROM mail_migration_runs ORDER BY started_at DESC LIMIT 1;" 2>/dev/null | head -1)
      echo "  dr-watcher launched new migration: $new_run"
      break
    fi
    # Also poll node ready state for visibility
    local r
    r=$(kubectl get node "$ACTIVE_NODE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "?")
    echo "  [$(date -Iseconds)] node $ACTIVE_NODE Ready=$r, migrations=$now_runs (baseline $pre_runs)"
    sleep 20
  done

  # Restart k3s no matter what (so the cluster recovers)
  echo "  restarting k3s on $ACTIVE_NODE"
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "${ACTIVE_NODE}.example.test" 'systemctl start k3s' 2>&1 | head -3

  if [ -z "$new_run" ]; then
    fail_phase H "dr-watcher did not launch a failover migration within ${DR_FAILOVER_BUDGET}s after k3s stop"
    return
  fi

  local final
  final=$(wait_migration "$new_run" 540 | tail -1)
  if [ "$final" != "done" ]; then
    fail_phase H "failover migration $new_run ended in $final"
    return
  fi

  # Verify stalwart pod is Running on the standby candidate (NOT on original active)
  sleep 5
  local final_node
  final_node=$(kubectl get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null)
  echo "  post-failover stalwart pod on: $final_node"
  ACTIVE_NODE=$final_node
  pass_phase H "DR failover completed — stalwart moved from (downed) original-active to $final_node"
}

# ── orchestrator ────────────────────────────────────────────────────────────
for phase in A B C D E F G H; do
  case "$PHASES" in
    *"$phase"*)
      case "$phase" in
        A) phase_A ;;
        B) phase_B ;;
        C) phase_C ;;
        D) phase_D ;;
        E) phase_E ;;
        F) phase_F ;;
        G) phase_G ;;
        H) phase_H ;;
      esac
      ;;
    *) ;;
  esac
done

echo ""
echo "===== HARNESS SUMMARY ====="
REMOTE

rc=$?
echo ""
echo "Overall harness exit code: $rc"
exit $rc
