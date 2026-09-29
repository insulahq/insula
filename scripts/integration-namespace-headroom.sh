#!/usr/bin/env bash
# integration-namespace-headroom.sh — a tenant namespace must not cap what
# runs in it (ADR-062 amendment).
#
# ★ WHY THIS EXISTS
#
# The tier model shipped with two namespace-wide bounds nobody asked for, and
# every test written for it used a fixture with one or two workloads — the
# only shape that cannot reach either bound. Both were found in production,
# by tenants:
#
#   1. The quota carried `limits.cpu` = burst x 4. A ResourceQuota charges a
#      container its whole CEILING at admission, used or not, so that budget
#      was a cap on the CONTAINER COUNT. A starter tenant got two. The third
#      application was refused, and so was every rolling replacement — a
#      replacement needs a free slot while the old pod still holds one — so
#      the namespace could not even restart, and the tenant's own CPU
#      migration deadlocked trying to.
#
#   2. The LimitRange carried `max` = the ceiling. A LimitRange polices EVERY
#      container in the namespace, and a tenant namespace is not only the
#      tenant's: the platform's file-backup Job runs there and declares 1.5
#      cores. A 1-core `max` refused it, the Job retried to its 29-minute
#      deadline, and the backup reported `partial` — every other component
#      had succeeded, so nothing called it a failure. 24 of 31 namespaces
#      stopped backing up their files.
#
# So this harness does the one thing those tests never did: it fills a
# namespace and then asks it to do ordinary work.
#
#   1. GROWTH    five applications run at once. Four was the old ceiling.
#   2. RESTART   one of them rolls while the others stay up.
#   3. PLATFORM  a pod declaring 1.5 cores — the backup Job's shape — is
#                admitted into the tenant's namespace.
#   4. SHAPE     no quota limits.cpu, no LimitRange max, and the per-container
#                ceiling that DOES bound a tenant is still there.
#   5. BACKUP    a real bundle completes. Not `partial` — that is a failure
#                wearing a softer word, and it is how this hid for a night.
set -uo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
load_integration_env
require_env ADMIN_HOST ADMIN_EMAIL ADMIN_PASSWORD SSH_HOST

API="${ADMIN_HOST}"
K="ssh -i ${SSH_KEY:?set SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=20 ${SSH_HOST}"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  FAIL  %s\n     -> %s\n' "$1" "${2:-}"; }
note(){ printf '        %s\n' "$1"; }
J=$(mktemp -d); TENANTS=(); NS=""

cleanup() {
  [ -n "$NS" ] && timeout 60 $K "kubectl -n $NS delete job hdr-platform-job --ignore-not-found" >/dev/null 2>&1
  for t in "${TENANTS[@]:-}"; do
    [ -n "$t" ] || continue
    curl -sk -X DELETE "$API/api/v1/tenants/$t" -H "Authorization: Bearer $T" >/dev/null 2>&1
  done
  rm -rf "$J"
}
trap cleanup EXIT

kc(){ timeout 90 $K "kubectl $*" 2>/dev/null; }

T=$(curl -sk -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])' 2>/dev/null)
[ -n "$T" ] || { echo "FATAL: no token"; exit 1; }
A=(-sk -H "Authorization: Bearer $T" -H 'Content-Type: application/json')
ok "authenticated"

# ── fixture ────────────────────────────────────────────────────────────────
# The largest plan, for MEMORY headroom only. Five 32Mi containers exceed the
# smallest plan's memory allowance, and a memory refusal here would read as a
# CPU-cap pass — the exact way this class of bug hides.
PLAN_ID=$(curl "${A[@]}" "$API/api/v1/plans?limit=50" | python3 -c '
import sys,json
d=json.load(sys.stdin)["data"]
def mem(p): return float(p.get("memory_limit") or p.get("memoryLimit") or 0)
print(sorted(d, key=mem)[-1]["id"])' 2>/dev/null)
REGION_ID=$(curl "${A[@]}" "$API/api/v1/regions?limit=5" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
[ -n "$PLAN_ID" ] && [ -n "$REGION_ID" ] || { bad "no plan/region" ""; exit 1; }


NAME="hdr-$$"
TID=$(curl "${A[@]}" -X POST "$API/api/v1/tenants" \
  -d "{\"name\":\"$NAME\",\"primary_email\":\"$NAME@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null)
[ -n "$TID" ] || { bad "tenant create failed" ""; exit 1; }
TENANTS+=("$TID")
# Bring-your-own containers are gated per subscription (ADR-036). The
# per-tenant override is the lever that touches nothing else on the
# cluster — the fixture is deleted at the end, and so is the override.
curl "${A[@]}" -o /dev/null -X PATCH "$API/api/v1/tenants/$TID" \
  -d '{"allow_custom_containers_override":true}'
curl "${A[@]}" -X POST "$API/api/v1/admin/tenants/$TID/provision" -d '{}' >/dev/null 2>&1
for _ in $(seq 1 120); do
  curl "${A[@]}" "$API/api/v1/tenants/$TID" | grep -q '"status":"active"' && break
  sleep 5
done
NS=$(curl "${A[@]}" "$API/api/v1/tenants/$TID" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print(d.get("kubernetes_namespace") or d.get("kubernetesNamespace") or "")' 2>/dev/null)
[ -n "$NS" ] || { bad "no namespace for the fixture tenant" ""; exit 1; }
note "namespace $NS"

# ══ 1. five applications at once ═══════════════════════════════════════════
echo "════ 1. a namespace holds five applications"
# Five, because the old budget was burst x 4 divided by a burst-sized
# ceiling: exactly four containers, whatever the plan.
DEPLOYED=0
for i in 1 2 3 4 5; do
  body=$(printf '{"mode":"simple","name":"hdr%s","image":"registry.k8s.io/pause:3.9","resources":{"memoryRequest":"32Mi"}}' "$i")
  code=$(curl "${A[@]}" -o "$J/d$i.json" -w '%{http_code}' \
    -X POST "$API/api/v1/tenants/$TID/custom-deployments" -d "$body")
  [ "$code" = "201" ] || [ "$code" = "200" ] && DEPLOYED=$((DEPLOYED+1)) || note "app $i create -> HTTP $code $(head -c 160 "$J/d$i.json")"
done
[ "$DEPLOYED" = "5" ] && ok "all five accepted by the API" || bad "only $DEPLOYED of 5 accepted" ""

RUNNING=0
for _ in $(seq 1 60); do
  RUNNING=$(kc "-n $NS get pods --no-headers 2>/dev/null | grep -c ' Running '" | tr -d ' ')
  [ "${RUNNING:-0}" -ge 5 ] && break
  sleep 5
done
note "$RUNNING pod(s) Running in $NS"
[ "${RUNNING:-0}" -ge 5 ] \
  && ok "five applications run at the same time" \
  || bad "the namespace stopped at ${RUNNING:-0} running pods" "$(kc "-n $NS get events --sort-by=.lastTimestamp -o jsonpath='{.items[-1].message}'")"

# ══ 2. a rolling restart while the namespace is full ═══════════════════════
echo "════ 2. a full namespace can still roll a pod"
# The wedge was here: a replacement pod needs room BESIDE the one it
# replaces, so a namespace at its cap cannot restart anything at all.
OLD=$(kc "-n $NS get pods -l app=hdr1 --no-headers -o custom-columns=:metadata.name" | head -1)
kc "-n $NS delete pod $OLD --wait=false" >/dev/null
BACK=0
for _ in $(seq 1 40); do
  NEW=$(kc "-n $NS get pods -l app=hdr1 --no-headers 2>/dev/null | grep -c ' Running '" | tr -d ' ')
  [ "${NEW:-0}" -ge 1 ] && { BACK=1; break; }
  sleep 5
done
[ "$BACK" = "1" ] && ok "the replaced pod came back" \
  || bad "a pod could not be recreated in a full namespace" "$(kc "-n $NS get events --sort-by=.lastTimestamp -o jsonpath='{.items[-1].message}'")"

# ══ 3. a platform-owned pod that declares more than the ceiling ════════════
echo "════ 3. the platform's own job shape is admitted"
cat > "$J/job.yaml" <<YAML
apiVersion: batch/v1
kind: Job
metadata: { name: hdr-platform-job, namespace: $NS }
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      priorityClassName: platform-tenant-overhead
      containers:
      - name: files
        image: registry.k8s.io/pause:3.9
        resources:
          requests: { cpu: 100m, memory: 32Mi }
          limits:   { cpu: 1500m, memory: 64Mi }
YAML
$K "cat > /tmp/hdr-job-$$.yaml" < "$J/job.yaml" 2>/dev/null
CREATE=$(timeout 60 $K "kubectl apply -f /tmp/hdr-job-$$.yaml 2>&1; rm -f /tmp/hdr-job-$$.yaml")
POD=0
for _ in $(seq 1 24); do
  POD=$(kc "-n $NS get pods -l job-name=hdr-platform-job --no-headers 2>/dev/null | wc -l" | tr -d ' ')
  [ "${POD:-0}" -ge 1 ] && break
  sleep 5
done
if [ "${POD:-0}" -ge 1 ]; then
  ok "a 1.5-core container is admitted into a 1-core-ceiling namespace"
else
  bad "the tenant LimitRange refused the platform's own job shape" \
      "$(kc "-n $NS get events --sort-by=.lastTimestamp -o jsonpath='{.items[-1].message}') ${CREATE}")"
fi

# ══ 4. the shape of the two objects ════════════════════════════════════════
echo "════ 4. no namespace-wide CPU cap of either kind"
QC=$(kc "-n $NS get resourcequota $NS-quota -o jsonpath='{.spec.hard.limits\.cpu}'")
[ -z "$QC" ] && ok "the quota carries no limits.cpu" || bad "the quota carries a CPU ceiling budget" "limits.cpu=$QC"
MX=$(kc "-n $NS get limitrange $NS-cpu -o jsonpath='{.spec.limits[0].max.cpu}'")
[ -z "$MX" ] && ok "the LimitRange sets no max" || bad "the LimitRange sets a max" "max=$MX"
# ...and the bound that SHOULD be there still is.
DEF=$(kc "-n $NS get limitrange $NS-cpu -o jsonpath='{.spec.limits[0].default.cpu}'")
REQ=$(kc "-n $NS get limitrange $NS-cpu -o jsonpath='{.spec.limits[0].defaultRequest.cpu}'")
note "per-container default=${DEF:-<none>} defaultRequest=${REQ:-<none>}"
[ -n "$DEF" ] && ok "every container still gets the tenant's ceiling" \
  || bad "the per-container ceiling is gone — a tenant is now unbounded" ""
POD_LIM=$(kc "-n $NS get pods -l app=hdr2 -o jsonpath='{.items[0].spec.containers[0].resources.limits.cpu}'")
# ★ Both must be NON-EMPTY as well as equal. An absent ceiling equals an
# absent pod limit, and comparing them alone passed on a namespace that had
# no ceiling at all — which is precisely what a dropped `default` produces.
if [ -n "$POD_LIM" ] && [ "$POD_LIM" = "$DEF" ]; then
  ok "and it reaches a pod that declares nothing ($POD_LIM)"
else
  bad "a pod declaring no CPU did not get the ceiling" "got '${POD_LIM:-<none>}', want '${DEF:-<none>}'"
fi

# ══ 5. a real backup completes ═════════════════════════════════════════════
echo "════ 5. a tenant bundle completes, not 'partial'"
# ★ A tenant-panel endpoint, and an admin token is refused there
# (PANEL_ACCESS_DENIED). Impersonation is how the platform itself crosses
# that line, so the harness uses the same door rather than a special case.
TT=$(curl "${A[@]}" -X POST "$API/api/v1/admin/impersonate/$TID" -d '{}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("token",""))' 2>/dev/null)
TA=(-sk -H "Authorization: Bearer ${TT:-$T}" -H 'Content-Type: application/json')
RN=$(curl "${TA[@]}" -X POST "$API/api/v1/tenants/$TID/bundles/run-now" -d '{}')
BID=$(printf '%s' "$RN" | python3 -c 'import sys,json;d=json.load(sys.stdin).get("data",{}) or {};print(d.get("bundleId") or d.get("bundle_id") or d.get("id") or "")' 2>/dev/null)
if [ -z "$BID" ] && printf '%s' "$RN" | grep -qiE 'no active|not configured|NO_BACKUP_TARGET|TARGET_NOT'; then
  # A cluster with no backup target cannot run this section, and saying so
  # beats a failure this code cannot cause. It is still a gap in coverage,
  # so it is reported, not swallowed.
  note "SKIPPED — this cluster has no active tenant backup target configured"
  note "$(printf '%s' "$RN" | head -c 200)"
elif [ -z "$BID" ]; then
  bad "could not start a bundle" "$(printf '%s' "$RN" | head -c 200)"
else
  ST=""
  for _ in $(seq 1 90); do
    ST=$(curl "${TA[@]}" "$API/api/v1/tenants/$TID/bundles" \
      | python3 -c "
import sys,json
d=json.load(sys.stdin).get('data') or []
if isinstance(d,dict): d=d.get('items') or []
print(next((b.get('status','') for b in d if b.get('id')=='$BID' or b.get('bundleId')=='$BID'),''))" 2>/dev/null)
    case "$ST" in completed|failed|partial) break ;; esac
    sleep 10
  done
  note "bundle $BID -> ${ST:-<no status>}"
  # ★ `partial` is a FAILURE. It is the status 24 namespaces reported all
  # night while their files were not being backed up at all.
  [ "$ST" = "completed" ] && ok "the bundle completed" || bad "the bundle did not complete" "status=$ST"
fi

printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
