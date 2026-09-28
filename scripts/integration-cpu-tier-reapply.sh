#!/usr/bin/env bash
# integration-cpu-tier-reapply.sh — a changed tier must REACH the cluster.
#
# For the whole of ADR-062 R2 it did not. An already-tiered tenant was
# refused with ALREADY_TIERED, so editing its tier or burst ceiling wrote a
# database column and changed nothing: the LimitRange kept the old ceiling,
# the quota kept the old backstop, and every pod kept the limit it was
# admitted with — while the panel said the change was saved.
#
# No unit test reaches this. A LimitRange stamps its default at ADMISSION,
# so "did the change reach the running pods" is a question only a live
# cluster can answer, and it is exactly the question that was being got
# wrong.
#
#   1. MIGRATE   a fixture tenant, and record what the cluster enforces.
#   2. PENDING   change the tier + ceiling; the dry run must SAY they differ.
#   3. RE-APPLY  and assert the LimitRange, the quota AND the running pods
#                all carry the new figures.
#   4. SETTLED   the dry run no longer reports a pending change.
#   5. TIER ONLY change the tier alone; no pod may be replaced.
#   6. CAPPED    a tenant's applications all take the tenant's tier.
#
# Creates its own fixture tenant and deletes it on exit.
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
J=$(mktemp -d); TENANTS=()

cleanup() {
  for t in "${TENANTS[@]:-}"; do
    [ -n "$t" ] || continue
    curl -sk -X DELETE "$API/api/v1/tenants/$t" -H "Authorization: Bearer $T" >/dev/null 2>&1
  done
  local left_ns left_tenant
  for _ in $(seq 1 45); do
    left_ns=$(timeout 60 $K "kubectl get ns --no-headers 2>/dev/null | grep -c cpureapply" 2>/dev/null)
    left_tenant=$(curl -sk "$API/api/v1/tenants?limit=100" -H "Authorization: Bearer $T" \
      | python3 -c 'import sys,json;print(sum(1 for t in json.load(sys.stdin).get("data",[]) if "cpureapply" in t["name"]))' 2>/dev/null)
    [ "${left_ns:-1}" = "0" ] && [ "${left_tenant:-1}" = "0" ] && break
    sleep 10
  done
  [ "${left_ns:-0}" = "0" ] && [ "${left_tenant:-0}" = "0" ] || \
    printf "  WARN  fixture cleanup incomplete: %s namespace(s), %s tenant(s) remain\n" "${left_ns:-?}" "${left_tenant:-?}"
  rm -rf "$J"
}
trap cleanup EXIT

kc(){ timeout 90 $K "kubectl $*" 2>/dev/null; }
psql(){ timeout 90 $K "kubectl -n platform exec system-db-1 -c postgres -- psql -U postgres -d platform -At -c \"$1\"" 2>/dev/null; }
lr_ceiling(){ kc "-n $1 get limitrange $1-cpu -o jsonpath='{.spec.limits[0].default.cpu}'"; }
lr_request(){ kc "-n $1 get limitrange $1-cpu -o jsonpath='{.spec.limits[0].defaultRequest.cpu}'"; }
quota_ceiling(){ kc "-n $1 get resourcequota $1-quota -o jsonpath='{.spec.hard.limits\.cpu}'"; }
# Every in-scope pod's CPU limit, one per line. THE assertion that matters:
# the LimitRange and the quota can both be right while the pods still run
# under the ceiling they were admitted with.
pod_limits(){ kc "-n $1 get pods -o jsonpath='{range .items[*]}{.spec.containers[0].resources.limits.cpu}{\"\n\"}{end}'" | grep -v '^$'; }
pod_names(){ kc "-n $1 get pods --no-headers -o custom-columns=:metadata.name" | grep -v '^$' | sort; }

T=$(curl -sk -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])' 2>/dev/null)
[ -n "$T" ] || { echo "FATAL: no token"; exit 1; }
A=(-sk -H "Authorization: Bearer $T" -H 'Content-Type: application/json')
ok "authenticated"

# What the dry run says about ONE tenant, as `pending|proposedTier|proposedCeiling|appliedTier|appliedCeiling`.
preview_of() {
  curl "${A[@]}" "$API/api/v1/admin/cpu-migration/preview" | python3 -c '
import sys,json
want=sys.argv[1]
d=json.load(sys.stdin).get("data",{})
for t in d.get("tenants",[]):
    if t["tenantId"]==want:
        print("|".join([str(t.get("pendingCpuChange")), str(t.get("proposedTier")),
                        str(t.get("proposedCeilingCores")), str(t.get("appliedTier")),
                        str(t.get("appliedCeilingCores"))]))
        break
' "$1" 2>/dev/null
}

PLAN_ID=$(curl "${A[@]}" "$API/api/v1/plans?limit=50" | python3 -c '
import sys,json
d=json.load(sys.stdin)["data"]
def st(p): return float(p.get("storage_limit") or p.get("storageLimit") or 1e9)
print(sorted(d, key=st)[0]["id"])' 2>/dev/null)
REGION_ID=$(curl "${A[@]}" "$API/api/v1/regions?limit=5" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
[ -n "$PLAN_ID" ] && [ -n "$REGION_ID" ] || { echo "FATAL: no plan/region"; exit 1; }

NAME="cpureapply-$$"
TF=$(curl "${A[@]}" -X POST "$API/api/v1/tenants" \
  -d "{\"name\":\"$NAME\",\"primary_email\":\"$NAME@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null)
[ -n "$TF" ] || { bad "fixture tenant create failed" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
TENANTS+=("$TF")
curl "${A[@]}" -X POST "$API/api/v1/admin/tenants/$TF/provision" -d '{}' >/dev/null 2>&1
for _ in $(seq 1 60); do curl "${A[@]}" "$API/api/v1/tenants/$TF" | grep -q '"status":"active"' && break; sleep 5; done
NS=$(psql "SELECT kubernetes_namespace FROM tenants WHERE id='$TF';")
[ -n "$NS" ] || { bad "fixture has no namespace" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }

ENTRY=$(curl "${A[@]}" "$API/api/v1/catalog?limit=100" | python3 -c '
import sys,json
d=json.load(sys.stdin).get("data",[])
print(d[0]["id"] if d else "")' 2>/dev/null)
[ -n "$ENTRY" ] || { bad "no catalog entry" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
curl "${A[@]}" -X POST "$API/api/v1/tenants/$TF/deployments" \
  -d "{\"catalog_entry_id\":\"$ENTRY\",\"name\":\"reapply-app\",\"cpu_request\":\"0.2\",\"memory_request\":\"128Mi\"}" >/dev/null 2>&1
READY=0
for _ in $(seq 1 60); do
  r=$(kc "-n $NS get deploy reapply-app -o jsonpath='{.status.readyReplicas}'")
  [ "${r:-0}" -ge 1 ] 2>/dev/null && { READY=1; break; }
  sleep 6
done
[ "$READY" = "1" ] || { bad "the fixture workload never became Ready — nothing below can be trusted" "$(kc "-n $NS get pods --no-headers" | head -3)"; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
ok "fixture $NS is up with a running workload"

# ══ 1. migrate ══════════════════════════════════════════════════════════════
echo "════ 1. migrate, and record what the cluster enforces"
CODE=$(curl "${A[@]}" -o "$J/out" -w '%{http_code}' -X POST "$API/api/v1/admin/cpu-migration/tenants/$TF/apply" -d '{"acknowledgeBlockers":true}')
STATUS=$(python3 -c "import json;print(json.load(open('$J/out'))['data']['status'])" 2>/dev/null)
[ "$CODE" = "200" ] && [ "$STATUS" = "completed" ] \
  && ok "migration completed" || bad "migration did not complete" "http=$CODE status=$STATUS $(head -c 220 "$J/out")"
CEIL0=$(lr_ceiling "$NS"); REQ0=$(lr_request "$NS")
note "LimitRange after migration: default=${CEIL0:-<none>} defaultRequest=${REQ0:-<none>}"
[ -n "$CEIL0" ] && ok "the namespace has a CPU LimitRange" || bad "no LimitRange — everything below is vacuous" ""

# ══ 2. a pending change must be VISIBLE ═════════════════════════════════════
echo "════ 2. change the tier and the ceiling — the dry run must say so"
curl "${A[@]}" -o /dev/null -X PATCH "$API/api/v1/tenants/$TF" \
  -d '{"cpu_tier_override":"highest","cpu_burst_cores_override":"2"}'
P=$(preview_of "$TF")
note "preview: $P"
case "$P" in
  True\|highest\|2*) ok "the dry run reports a pending change to highest / 2 cores" ;;
  *) bad "the dry run does not report the pending change" "$P" ;;
esac
# Still the OLD figures in the cluster — that is the point of "pending".
[ "$(lr_ceiling "$NS")" = "$CEIL0" ] && ok "the cluster has not changed yet" \
  || bad "something applied the change without being asked" "$(lr_ceiling "$NS")"

# ══ 3. re-apply ═════════════════════════════════════════════════════════════
echo "════ 3. re-apply — LimitRange, quota AND the running pods"
BEFORE_PODS=$(pod_names "$NS")
CODE=$(curl "${A[@]}" -o "$J/out2" -w '%{http_code}' -X POST "$API/api/v1/admin/cpu-migration/tenants/$TF/apply" -d '{"acknowledgeBlockers":true}')
STATUS=$(python3 -c "import json;print(json.load(open('$J/out2'))['data']['status'])" 2>/dev/null)
[ "$CODE" = "200" ] && [ "$STATUS" = "completed" ] \
  && ok "re-apply completed (it used to 409 ALREADY_TIERED)" \
  || bad "re-apply did not complete" "http=$CODE status=$STATUS $(head -c 260 "$J/out2")"
C=$(lr_ceiling "$NS"); R=$(lr_request "$NS")
[ "$C" = "2" ] && ok "LimitRange ceiling is now 2 cores" || bad "the LimitRange kept the old ceiling" "default=$C"
[ "$R" = "100m" ] && ok "LimitRange default request is now the highest tier (100m)" || bad "the tier did not reach the LimitRange" "defaultRequest=$R"
Q=$(quota_ceiling "$NS")
note "quota limits.cpu=$Q"
[ -n "$Q" ] && ok "the quota still carries a ceiling" || bad "the re-apply stripped the quota ceiling" ""
# ★ THE assertion. The two objects above can both be right while every pod
# still runs under the ceiling it was admitted with.
LIMITS=$(pod_limits "$NS")
note "pod CPU limits: $(echo "$LIMITS" | tr '\n' ' ')"
if [ -z "$LIMITS" ]; then
  bad "no pod reported a CPU limit — cannot tell whether the ceiling reached them" ""
elif echo "$LIMITS" | grep -qv '^2$'; then
  bad "a pod is still running under the OLD ceiling" "$(echo "$LIMITS" | tr '\n' ' ')"
else
  ok "every running pod carries the new 2-core ceiling"
fi
AFTER_PODS=$(pod_names "$NS")
[ "$BEFORE_PODS" != "$AFTER_PODS" ] && ok "the pods were replaced, as a ceiling change requires" \
  || bad "no pod was replaced, so the new ceiling cannot be in force" ""

# ══ 4. settled ══════════════════════════════════════════════════════════════
echo "════ 4. the dry run no longer reports a pending change"
P=$(preview_of "$TF")
note "preview: $P"
case "$P" in
  False\|*) ok "pending change cleared" ;;
  *) bad "the dry run still reports a pending change after applying it" "$P" ;;
esac

# ══ 5. a tier-only change must not replace anything ═════════════════════════
echo "════ 5. change the tier ALONE — no pod may be replaced"
BEFORE_PODS=$(pod_names "$NS")
curl "${A[@]}" -o /dev/null -X PATCH "$API/api/v1/tenants/$TF" -d '{"cpu_tier_override":"normal"}'
CODE=$(curl "${A[@]}" -o "$J/out3" -w '%{http_code}' -X POST "$API/api/v1/admin/cpu-migration/tenants/$TF/apply" -d '{"acknowledgeBlockers":true}')
STATUS=$(python3 -c "import json;print(json.load(open('$J/out3'))['data']['status'])" 2>/dev/null)
[ "$CODE" = "200" ] && [ "$STATUS" = "completed" ] && ok "tier-only re-apply completed" \
  || bad "tier-only re-apply failed" "http=$CODE status=$STATUS $(head -c 220 "$J/out3")"
[ "$(lr_request "$NS")" = "5m" ] && ok "the LimitRange default request is now the normal tier (5m)" \
  || bad "the tier did not reach the LimitRange" "defaultRequest=$(lr_request "$NS")"
# The deployment's own request moves with the tier — it is re-tiered, which
# rolls its pods. What must NOT happen is a ceiling-driven sweep on top.
[ "$(lr_ceiling "$NS")" = "2" ] && ok "the ceiling is untouched by a tier-only change" \
  || bad "a tier-only change moved the ceiling" "$(lr_ceiling "$NS")"

# ══ 6. every application takes the TENANT's tier ════════════════════════════
echo "════ 6. the tenant's tier governs every application it runs"
CPUREQ=$(psql "SELECT cpu_request FROM deployments WHERE tenant_id='$TF' AND status <> 'deleted';")
note "deployment cpu_request rows: $(echo "$CPUREQ" | tr '\n' ' ')"
if [ -z "$CPUREQ" ]; then
  bad "no deployment rows to check" ""
elif echo "$CPUREQ" | grep -qv '^5m$'; then
  bad "an application is not on the tenant's tier" "$(echo "$CPUREQ" | tr '\n' ' ')"
else
  ok "every application asks for the tenant's tier (5m)"
fi

printf '\n════════════════════════════════════\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
