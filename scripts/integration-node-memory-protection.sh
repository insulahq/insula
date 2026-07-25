#!/usr/bin/env bash
# integration-node-memory-protection.sh — node memory-protection E2E
# (operator decision 2026-07-25; ships in v2026.7.2).
#
# Exercises the four protection layers against a real cluster:
#   1. Host layer: kubelet drop-in (eviction-hard=memory.available<256Mi +
#      system-reserved=1Gi) — proven via the node Allocatable gap (capacity −
#      allocatable ≥ 1280Mi on EVERY node) + the drop-in file + swap off +
#      the `cluster doctor` swap check on the control host.
#   2. Eviction ordering: platform-critical PriorityClass (10000) exists and
#      every platform/mail Deployment/StatefulSet pod carries ≥ 10000
#      (host-agent DaemonSets: system-node-critical), while a fresh pod with
#      no class lands on tenant-default (0) via the globalDefault.
#   3. Observability: an injected synthetic SystemOOM Event is ingested by
#      the node-health reconciler exactly once (dedupe on re-reconcile),
#      served by GET /admin/node-health/memory-events, and an admin
#      notification exists within the dedupe window.
#   4. Metric alerting: node-kernel-oom + system-container-oom SLO rules are
#      registered, container_oom_events_total flows into vmsingle, and a
#      CONTAINED cgroup OOM (64Mi-limited hog — kills inside its own limit,
#      ZERO node pressure, parallel-safe by design) increments it.
#
# Deliberately NOT tested here: a real node-level OOM/eviction storm. A
# limit-less burst was E2E-proven on DEV (2026-07-25: three kernel OOMs all
# killed the tenant hog, system pods survived) but on shared staging it can
# blip the control plane — the contained cgroup leg covers the metric path
# with none of the blast radius.
#
# FEATURE GATE: the suite self-SKIPs (exit 77) when the deployed release
# predates the feature (GET /admin/node-health/memory-events → 404), so the
# full run stays green on clusters still running ≤ v2026.7.1.
#
# ENV (same shape as the other suites; integration-all supplies these):
#   ADMIN_HOST / ADMIN_EMAIL / ADMIN_PASSWORD (required)
#   SSH_KEY (default ~/hosting-platform.key) · STAGING_SSH_HOST / SSH_HOST
set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -q}"
if [[ -z "$ADMIN_PASSWORD" ]]; then echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; fi

CONTROL_HOST="${STAGING_SSH_HOST:-${SSH_HOST:-192.0.2.58}}"
CONTROL_HOST="${CONTROL_HOST#*@}"

RUN_ID="e2e-memprot-$$-$(date +%s)"
E2E_NS="${RUN_ID}"

PASS=0; FAIL=0
pass() { echo "PASS: $*"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }

k() { ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" kubectl "$@"; }
sshc() { ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" "$@"; }
psql_q() { ssh $SSH_OPTS -i "$SSH_KEY" "root@${CONTROL_HOST}" \
  "kubectl exec -i -n platform system-db-1 -c postgres -- psql -U postgres -d platform -tA" <<<"$1" 2>/dev/null; }
api() { curl -sk -H "Authorization: Bearer $TOKEN" "$@"; }
# vmsingle query from inside the cluster (URL-encoded MetricsQL; note the
# mandatory -http.pathPrefix=/metrics on vmsingle). Runs node's fetch inside
# the platform-api pod — the quoting shape is the one proven against DEV.
vm_query() {
  sshc "kubectl exec -n platform deploy/platform-api -- node -e \"fetch('http://vmsingle.monitoring.svc:8428/metrics/api/v1/query?query=$1').then(r=>r.json()).then(d=>console.log(JSON.stringify(d.data.result))).catch(()=>console.log('[]'))\"" 2>/dev/null | tail -1
}

cleanup() {
  k delete namespace "$E2E_NS" --wait=false >/dev/null 2>&1 || true
  k delete event -n default "${RUN_ID}-oom" >/dev/null 2>&1 || true
}
trap cleanup EXIT

TOKEN=$(curl -fsSk -X POST "$ADMIN_HOST/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r '.data.token')
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then echo "ERROR: login failed" >&2; exit 2; fi

# ── 0. Feature gate ──────────────────────────────────────────────────────────
echo "→ 0. feature gate (memory-events endpoint)"
GATE_CODE=$(api -o /dev/null -w '%{http_code}' "$ADMIN_HOST/api/v1/admin/node-health/memory-events?limit=1")
if [[ "$GATE_CODE" == "404" ]]; then
  echo "SKIP: deployed release predates node memory protection (memory-events endpoint → 404; ships in v2026.7.2)"
  exit 77
elif [[ "$GATE_CODE" != "200" ]]; then
  fail "memory-events endpoint returned HTTP $GATE_CODE (expected 200 or 404)"
  echo "PASS: $PASS  FAIL: $FAIL"; exit 1
fi
pass "memory-events endpoint present (feature deployed)"

# ── 1. Host layer: allocatable gap + drop-in + swap + doctor ─────────────────
echo "→ 1. kubelet memory headroom on every node"
# capacity − allocatable ≥ 1280Mi (1Gi system-reserved + 256Mi eviction-hard).
GAP_BAD=$(k get nodes -o json | jq -r '
  [.items[] | {
     name: .metadata.name,
     cap:  (.status.capacity.memory  | sub("Ki$";"") | tonumber),
     allo: (.status.allocatable.memory | sub("Ki$";"") | tonumber)
   } | select((.cap - .allo) < 1310720) | .name] | join(",")')
if [[ -z "$GAP_BAD" ]]; then
  pass "every node reserves ≥1280Mi (capacity − allocatable): kubelet drop-in active fleet-wide"
else
  fail "nodes missing the memory reservation (gap <1280Mi): $GAP_BAD — kubelet drop-in not converged"
fi

DROPIN=/etc/rancher/k3s/config.yaml.d/50-memory-protection.yaml
if sshc "grep -q 'eviction-hard=memory.available<256Mi' $DROPIN" 2>/dev/null; then
  pass "kubelet drop-in present on control host ($DROPIN)"
else
  fail "kubelet drop-in missing/wrong on control host ($DROPIN)"
fi

SWAP_LINES=$(sshc "wc -l < /proc/swaps" 2>/dev/null | tr -d '[:space:]')
if [[ "${SWAP_LINES:-0}" -le 1 ]]; then
  pass "swap OFF on control host"
else
  fail "ACTIVE swap on control host (/proc/swaps has ${SWAP_LINES} lines) — k8s nodes must run swap-less"
fi

DOCTOR=$(sshc "platform-ops cluster doctor --json" 2>/dev/null)
SWAP_CHECK=$(echo "$DOCTOR" | jq -r '[.checks[]? | select(.name=="swap disabled")][0].status // empty' 2>/dev/null)
if [[ "$SWAP_CHECK" == "ok" ]]; then
  pass "cluster doctor swap-disabled check: ok"
elif [[ -z "$SWAP_CHECK" ]]; then
  # platform-ops predates the check (self-upgrade lag, or the deliberately
  # frozen DEV host layer). The direct /proc/swaps assert above already
  # covered the actual invariant — note it, don't fail the suite on binary
  # version skew that other suites own.
  echo "NOTE: platform-ops binary has no swap-disabled doctor check yet ($(sshc 'platform-ops --version 2>/dev/null' | head -1)) — /proc/swaps asserted directly above"
else
  fail "cluster doctor swap-disabled check not ok (got '$SWAP_CHECK')"
fi

# ── 2. Eviction ordering: priority classes ───────────────────────────────────
echo "→ 2. tenant-first eviction ordering (PriorityClasses)"
PC_VAL=$(k get priorityclass platform-critical -o jsonpath='{.value}' 2>/dev/null)
if [[ "$PC_VAL" == "10000" ]]; then
  pass "PriorityClass platform-critical exists (value 10000)"
else
  fail "PriorityClass platform-critical missing/wrong (value '$PC_VAL')"
fi

# Every Running platform/mail pod owned by a Deployment/StatefulSet must sit
# at ≥10000. CNPG instance pods are exempt until their next instance roll
# (spec.priorityClassName only applies on pod recreation) — the durable
# contract is asserted on the Cluster CR below.
LOW_PODS=""
for ns in platform mail; do
  NS_LOW=$(k get pods -n "$ns" -o json 2>/dev/null | jq -r '
    [.items[]?
     | select(.status.phase=="Running")
     | select((.metadata.labels["cnpg.io/cluster"] // "") == "")
     | select([.metadata.ownerReferences[]?.kind] | any(. == "ReplicaSet" or . == "StatefulSet"))
     | select((.spec.priority // 0) < 10000)
     | .metadata.namespace + "/" + .metadata.name] | join(",")')
  [[ -n "$NS_LOW" ]] && LOW_PODS="${LOW_PODS:+$LOW_PODS,}$NS_LOW"
done
if [[ -z "$LOW_PODS" ]]; then
  pass "all platform/mail Deployment+StatefulSet pods at priority ≥10000"
else
  fail "system pods below platform-critical priority: $LOW_PODS"
fi

CNPG_PC=$(k get cluster.postgresql.cnpg.io -n platform system-db -o jsonpath='{.spec.priorityClassName}' 2>/dev/null)
if [[ "$CNPG_PC" == "platform-critical" ]]; then
  pass "CNPG system-db spec.priorityClassName=platform-critical (applies on instance roll)"
else
  fail "CNPG system-db spec.priorityClassName missing (got '$CNPG_PC')"
fi

AGENT_LOW=$(k get pods -n platform-system -o json 2>/dev/null | jq -r '
  [.items[] | select(.status.phase=="Running")
   | select([.metadata.ownerReferences[]?.kind] | any(. == "DaemonSet"))
   | select((.spec.priority // 0) < 2000000000)
   | .metadata.name] | join(",")')
if [[ -z "$AGENT_LOW" ]]; then
  pass "host-agent DaemonSet pods at system-node-critical (≥2e9)"
else
  fail "host-agent DaemonSet pods below system-node-critical: $AGENT_LOW"
fi

# A fresh pod with NO class must fall to tenant-default (0) — the
# globalDefault that keeps tenant workloads first in the eviction order.
k create namespace "$E2E_NS" >/dev/null 2>&1
k run "${RUN_ID}-probe" -n "$E2E_NS" --image=rancher/mirrored-pause:3.6 --restart=Never >/dev/null 2>&1
PROBE_PC=$(k get pod -n "$E2E_NS" "${RUN_ID}-probe" -o jsonpath='{.spec.priorityClassName}/{.spec.priority}' 2>/dev/null)
if [[ "$PROBE_PC" == "tenant-default/0" ]]; then
  pass "classless pod defaulted to tenant-default/0 (tenants evicted first)"
else
  fail "classless pod got '$PROBE_PC' (expected tenant-default/0)"
fi

# ── 3. Memory-events observability pipeline ──────────────────────────────────
echo "→ 3. SystemOOM event → reconciler → API → notification"
NODE_NAME=$(k get nodes -o jsonpath='{.items[0].metadata.name}')
NODE_UID=$(k get node "$NODE_NAME" -o jsonpath='{.metadata.uid}')
OOM_MSG="System OOM encountered, victim process: ${RUN_ID}, pid: 424242"
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Event
metadata:
  name: ${RUN_ID}-oom
  namespace: default
involvedObject:
  kind: Node
  name: ${NODE_NAME}
  uid: ${NODE_UID}
reason: SystemOOM
message: "${OOM_MSG}"
type: Warning
source:
  component: kubelet
  host: ${NODE_NAME}
firstTimestamp: ${NOW_TS}
lastTimestamp: ${NOW_TS}
count: 1
EOF

api -X POST "$ADMIN_HOST/api/v1/admin/node-health/reconcile" >/dev/null
FOUND=""
for i in $(seq 1 6); do
  FOUND=$(api "$ADMIN_HOST/api/v1/admin/node-health/memory-events?limit=100" \
    | jq -r --arg m "$OOM_MSG" '[.data.events[] | select(.message==$m)][0] // empty')
  [[ -n "$FOUND" ]] && break
  sleep 5
  api -X POST "$ADMIN_HOST/api/v1/admin/node-health/reconcile" >/dev/null
done
if [[ -n "$FOUND" ]]; then
  KIND=$(echo "$FOUND" | jq -r '.kind'); SYSW=$(echo "$FOUND" | jq -r '.systemWorkload'); ENODE=$(echo "$FOUND" | jq -r '.nodeName')
  if [[ "$KIND" == "system-oom" && "$SYSW" == "true" && "$ENODE" == "$NODE_NAME" ]]; then
    pass "injected SystemOOM ingested + served (kind=system-oom, systemWorkload=true, node=$ENODE)"
  else
    fail "injected SystemOOM served with wrong shape (kind=$KIND systemWorkload=$SYSW node=$ENODE)"
  fi
else
  fail "injected SystemOOM never appeared in GET /admin/node-health/memory-events"
fi

# Exactly-once: a second reconcile must NOT duplicate the row (uid×count dedupe).
api -X POST "$ADMIN_HOST/api/v1/admin/node-health/reconcile" >/dev/null
DUP=$(api "$ADMIN_HOST/api/v1/admin/node-health/memory-events?limit=100" \
  | jq -r --arg m "$OOM_MSG" '[.data.events[] | select(.message==$m)] | length')
if [[ "$DUP" == "1" ]]; then
  pass "re-reconcile did not duplicate the event (dedupe on uid×count)"
else
  fail "expected exactly 1 recorded event after re-reconcile, got $DUP"
fi

# Admin notification within the hour-scoped dedupe window (a run <1h after a
# previous one is deduped against the earlier dispatch — either way a recent
# notification must exist).
NOTIF=$(psql_q "SELECT COUNT(*) FROM notifications WHERE title LIKE 'Node memory event%' AND created_at > now() - interval '60 minutes';" | tr -d '[:space:]')
if [[ "${NOTIF:-0}" -ge 1 ]]; then
  pass "admin in-app notification present within the dedupe window ($NOTIF)"
else
  fail "no 'Node memory event' admin notification in the last 60 min"
fi

# ── 4. Metric-based kernel-OOM alerting ──────────────────────────────────────
echo "→ 4. cgroup OOM metric + SLO rules"
SLO=$(api "$ADMIN_HOST/api/v1/admin/monitoring/slo")
rule_present() { echo "$SLO" | jq -e --arg r "$1" '([..|objects|select((.id//.ruleId)==$r)]|length)>0' >/dev/null 2>&1; }
for r in node-kernel-oom system-container-oom; do
  if rule_present "$r"; then pass "monitoring rule '$r' registered"; else fail "monitoring rule '$r' MISSING"; fi
done

SERIES=$(vm_query 'count%28container_oom_events_total%29')
if echo "$SERIES" | jq -e '.[0].value[1] | tonumber > 0' >/dev/null 2>&1; then
  pass "container_oom_events_total flowing into vmsingle ($(echo "$SERIES" | jq -r '.[0].value[1]') series)"
else
  fail "container_oom_events_total absent from vmsingle (scrape keep-list not applied?)"
fi

# Contained cgroup OOM: a 64Mi-limited hog OOM-kills inside its own cgroup
# (zero node pressure). Two layers asserted:
#   KERNEL TRUTH (always strict) — the pod cgroup slice's memory.events
#     oom_kill counter on the host. The hog is pinned to the control node so
#     the suite can read /sys/fs/cgroup over the existing ssh path.
#   METRIC LAYER (strict when honest) — cadvisor's container_oom_events_total
#     is fed by its kmsg oomparser, NOT by cgroup memory.events (proven
#     2026-07-25: pod slice oom_kill=6 while cadvisor reported 0 on a node
#     whose parser had died with "/dev/kmsg: broken pipe"). When the control
#     node's parser is provably dead, the missing metric is the KNOWN
#     upstream cadvisor gap — NOTE it and rely on the kernel-truth assert;
#     on a healthy-parser node (all 4 staging nodes) a missing metric is a
#     real pipeline regression and FAILS.
# restartPolicy OnFailure is LOAD-BEARING for the metric leg: a Never pod's
# container cgroup is destroyed seconds after the kill — before the next
# vmsingle scrape (60s) — while the restarting pod's slice (and its
# hierarchical oom_kill count) persists as the scrapeable container=""
# series. The pod is deleted right after the assert to stop the crash loop.
CONTROL_NODE=$(sshc hostname 2>/dev/null | tr -d '[:space:]')
k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${RUN_ID}-hog
  namespace: ${E2E_NS}
spec:
  restartPolicy: OnFailure
  nodeName: ${CONTROL_NODE}
  containers:
    - name: hog
      image: $(k get deploy -n platform platform-api -o jsonpath='{.spec.template.spec.containers[0].image}')
      command: ["node", "-e", "const a=[];setInterval(()=>{a.push(Buffer.alloc(16<<20,1));},200);"]
      resources:
        requests: { cpu: 50m, memory: 32Mi }
        limits: { memory: 64Mi }
EOF
OOMED=""
for i in $(seq 1 12); do
  ST=$(k get pod -n "$E2E_NS" "${RUN_ID}-hog" -o jsonpath='{.status.containerStatuses[0].state.terminated.reason}{.status.containerStatuses[0].lastState.terminated.reason}' 2>/dev/null)
  case "$ST" in *OOMKilled*|*Error*) OOMED="$ST"; break;; esac
  sleep 5
done
if [[ -n "$OOMED" ]]; then
  pass "limited hog cgroup-killed inside its 64Mi limit (reason=$OOMED, node unaffected)"
else
  fail "limited hog did not terminate within 60s"
fi

# Kernel truth: the pod slice's memory.events counted the kill(s).
HOG_UID=$(k get pod -n "$E2E_NS" "${RUN_ID}-hog" -o jsonpath='{.metadata.uid}' 2>/dev/null)
CG_OOM=$(sshc "cat /sys/fs/cgroup/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod${HOG_UID//-/_}.slice/memory.events 2>/dev/null" | awk '/^oom_kill /{print $2}')
if [[ "${CG_OOM:-0}" -ge 1 ]]; then
  pass "kernel counted the kill: pod cgroup memory.events oom_kill=$CG_OOM"
else
  fail "pod cgroup memory.events oom_kill not incremented (got '${CG_OOM:-unreadable}')"
fi

METRIC_OK=""
for i in $(seq 1 12); do
  INC=$(vm_query "sum%28increase%28container_oom_events_total%7Bnamespace%3D%22${E2E_NS}%22%7D%5B10m%5D%29%29")
  if echo "$INC" | jq -e '.[0].value[1] | tonumber > 0' >/dev/null 2>&1; then METRIC_OK=1; break; fi
  sleep 15
done
k delete pod -n "$E2E_NS" "${RUN_ID}-hog" --wait=false >/dev/null 2>&1
if [[ -n "$METRIC_OK" ]]; then
  pass "container_oom_events_total incremented for the hog namespace (metric alert path live)"
else
  PARSER_DEAD=$(sshc "journalctl -u k3s -u k3s-agent --since '-14d' --no-pager 2>/dev/null | grep -c 'exiting analyzeLines'" 2>/dev/null | tr -d '[:space:]')
  if [[ "${PARSER_DEAD:-0}" -ge 1 ]]; then
    echo "NOTE: cadvisor kmsg oomparser is dead on $CONTROL_NODE ($PARSER_DEAD 'exiting analyzeLines' hits in 14d) — container_oom_events_total cannot increment there (known upstream cadvisor gap; the kernel-truth cgroup assert above covers the invariant)"
  else
    fail "hog OOM never surfaced in container_oom_events_total with a HEALTHY oomparser (waited 3 min) — metric pipeline regression"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "PASS: $PASS  FAIL: $FAIL"
echo "─────────────────────────────────────────────"
[[ "$FAIL" -gt 0 ]] && exit 1
exit 0
