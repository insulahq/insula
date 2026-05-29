#!/bin/bash
# integration-mail-dr-failover.sh — live DR failover E2E.
#
# Unlike the rest of the mobility harness, this test needs to SSH to
# MULTIPLE nodes (one to stop k3s, another to read kubectl), so it
# runs from the local workstation rather than from within a single
# SSH wrapper.
#
# What it does:
#   1. Identifies the current active mail node + a server-role standby.
#   2. Stops k3s on the active node via SSH.
#   3. Polls kubectl (via SSH to the standby) for:
#       a. The active node going NotReady (kubelet stops reporting).
#       b. mail_dr_state transitioning healthy → degraded.
#       c. After failoverThresholdSeconds: dr-watcher launches a
#          restore-based failover migration to standby.
#       d. New stalwart pod Running on standby.
#   4. Restarts k3s on the original active.
#
# Total runtime budget: ~12 min (threshold 300s + scale + restore + cleanup).
#
# Usage:
#   SSH_KEY=/home/dev/hosting-platform.key ./scripts/integration-mail-dr-failover.sh
set -u

SSH_KEY=${SSH_KEY:-/home/dev/hosting-platform.key}
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -i $SSH_KEY"
DR_FAILOVER_BUDGET=${DR_FAILOVER_BUDGET:-720}  # 12 min

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
amber() { printf '\033[33m%s\033[0m\n' "$*"; }
hdr()   { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }

# Pick any node to run kubectl through — prefer one that ISN'T the active
# mail node (so we still have kubectl access after stopping k3s on active).
# Default to staging2 as the kubectl bastion.
BASTION_HOST=root@staging2.phoenix-host.net
KUBECTL="ssh $SSH_OPTS $BASTION_HOST 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml &&'"

run_kubectl() {
  ssh $SSH_OPTS "$BASTION_HOST" "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && $*"
}

hdr "DR FAILOVER LIVE TEST"

ACTIVE_NODE=$(run_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT mail_active_node FROM system_settings;\" 2>/dev/null | head -1")
echo "active_mail_node=$ACTIVE_NODE"

if [ "$ACTIVE_NODE" = "$(echo $BASTION_HOST | sed 's/root@//;s/\.phoenix-host\.net//')" ]; then
  amber "active is the bastion ($ACTIVE_NODE) — switching bastion to another server-role node"
  for try in staging1 staging2 staging3; do
    if [ "$try" != "$ACTIVE_NODE" ]; then
      BASTION_HOST="root@${try}.phoenix-host.net"
      echo "new bastion: $BASTION_HOST"
      break
    fi
  done
fi

STANDBY_CANDIDATE=$(run_kubectl "kubectl get node -l 'insula.host/mail-standby=true,insula.host/node-role=server' -o jsonpath='{.items[*].metadata.name}' 2>/dev/null" | tr ' ' '\n' | grep -v -F "$ACTIVE_NODE" | head -1)
echo "standby_candidate=$STANDBY_CANDIDATE"

THRESHOLD=$(run_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT mail_failover_threshold_seconds FROM system_settings;\" 2>/dev/null | head -1")
echo "failover_threshold=${THRESHOLD}s, total budget=${DR_FAILOVER_BUDGET}s"

if [ -z "$STANDBY_CANDIDATE" ]; then
  red "SKIP: no server-role standby candidate (need a different node than active)"
  exit 0
fi

PRE_RUNS=$(run_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT COUNT(*) FROM mail_migration_runs;\" 2>/dev/null" | head -1 | tr -d ' ')
echo "pre_migration_runs=$PRE_RUNS"

# Stop k3s on the active node — kubelet stops, node goes NotReady after
# node-monitor-grace-period (~40s). dr-watcher detects and triggers failover.
hdr "STEP 1: stop k3s on $ACTIVE_NODE (via SSH from local)"
ssh $SSH_OPTS "root@${ACTIVE_NODE}.phoenix-host.net" 'systemctl stop k3s' 2>&1 | head -3 || {
  red "failed to stop k3s on $ACTIVE_NODE — aborting"
  exit 1
}
echo "k3s stopped"

# Trap to always restart k3s on exit (success OR fail), so cluster recovers
trap "echo 'CLEANUP: restarting k3s on $ACTIVE_NODE'; ssh $SSH_OPTS root@${ACTIVE_NODE}.phoenix-host.net 'systemctl start k3s' 2>&1 | head -2 || true" EXIT

hdr "STEP 2: wait for dr-watcher to launch failover migration (up to ${DR_FAILOVER_BUDGET}s)"
END=$(( $(date +%s) + DR_FAILOVER_BUDGET ))
NEW_RUN=""
DEGRADED_OBSERVED=0
while [ $(date +%s) -lt "$END" ]; do
  NOW_RUNS=$(run_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT COUNT(*) FROM mail_migration_runs;\" 2>/dev/null" | head -1 | tr -d ' ')
  NODE_READY=$(run_kubectl "kubectl get node $ACTIVE_NODE -o jsonpath='{.status.conditions[?(@.type==\"Ready\")].status}' 2>/dev/null" | head -1)
  DR_STATE=$(run_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT mail_dr_state FROM system_settings;\" 2>/dev/null" | head -1)
  echo "  [$(date -Iseconds)] node $ACTIVE_NODE Ready=$NODE_READY dr_state=$DR_STATE migrations=$NOW_RUNS (baseline $PRE_RUNS)"

  if [ "$DR_STATE" = "degraded" ] && [ "$DEGRADED_OBSERVED" = "0" ]; then
    green "  dr-watcher observed degraded state — failover will fire after $THRESHOLD s"
    DEGRADED_OBSERVED=1
  fi

  if [ "$NOW_RUNS" -gt "$PRE_RUNS" ]; then
    NEW_RUN=$(run_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT id FROM mail_migration_runs ORDER BY started_at DESC LIMIT 1;\" 2>/dev/null" | head -1 | tr -d ' ')
    green "  dr-watcher launched failover migration: $NEW_RUN"
    break
  fi
  sleep 25
done

if [ -z "$NEW_RUN" ]; then
  red "FAIL: dr-watcher did not launch a failover migration within ${DR_FAILOVER_BUDGET}s"
  exit 1
fi

hdr "STEP 3: wait for failover migration to complete"
END=$(( $(date +%s) + 540 ))
LAST_STEP=""
FINAL=""
while [ $(date +%s) -lt "$END" ]; do
  R=$(run_kubectl "kubectl exec -n platform \$(kubectl get pod -n platform -l cnpg.io/cluster=system-db -o jsonpath='{.items[0].metadata.name}') -- psql -U postgres -d platform -tA -c \"SELECT state || ':' || COALESCE(current_step,'?') FROM mail_migration_runs WHERE id='$NEW_RUN';\" 2>/dev/null" | head -1 | tr -d ' ')
  if [ "$R" != "$LAST_STEP" ]; then
    echo "  [$(date -Iseconds)] $R"
    LAST_STEP="$R"
  fi
  case "$R" in
    done:*) FINAL=done; break ;;
    failed:*|rolled-back:*|cancelled:*) FINAL=${R%%:*}; break ;;
  esac
  sleep 5
done

if [ "$FINAL" != "done" ]; then
  red "FAIL: failover migration ended in '$FINAL' (state: $LAST_STEP)"
  exit 1
fi

hdr "STEP 4: verify mail-stack pod on new active"
sleep 5
FINAL_NODE=$(run_kubectl "kubectl get pod -n mail -l app=stalwart-mail -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null" | head -1)
echo "stalwart pod now on: $FINAL_NODE"
if [ "$FINAL_NODE" = "$ACTIVE_NODE" ]; then
  red "FAIL: stalwart still on (downed) active $ACTIVE_NODE — failover didn't move"
  exit 1
fi
green "PASS: DR failover moved stalwart from $ACTIVE_NODE (k3s down) → $FINAL_NODE"

# Trap will restart k3s on $ACTIVE_NODE
exit 0
