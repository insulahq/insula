#!/usr/bin/env bash
# integration-cpu-quota-preservation.sh — a tiered namespace must KEEP its
# CPU ceiling, and get it back if it ever lost one. (ADR-062)
#
# `applyResourceQuota` writes the legacy quota shape — requests.cpu from the
# plan, no limits.cpu — and five separate paths call it: provisioning, the
# boot sweep, a plan edit, a tenant limit edit and namespace-integrity
# repair. Against a migrated namespace each of those silently removed the
# burst ceiling the migration had installed. It happened on production: a
# plan edit took the ceiling off the nine tenants migrated before it, and
# the next API restart would have taken all thirty.
#
# No unit test reaches this. The bug lives in the interaction between a
# database-driven writer and a live Kubernetes object that something ELSE
# owns half of, so the only honest check is against a real cluster:
#
#   1. MIGRATE   a fixture tenant and confirm the ceiling is really there.
#   2. TENANT EDIT — PATCH the tenant's CPU limit. Ceiling must survive.
#   3. PLAN EDIT  — PATCH the plan (the fan-out that caused the outage).
#                   Ceiling must survive on every tenant on that plan.
#   4. RESTORE    — strip the ceiling by hand, restart the API, and watch
#                   the boot sweep put it back. This is the repair path for
#                   namespaces already damaged before the fix shipped.
#   5. REVERT     — leaves the namespace legacy, with NO stale ceiling.
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
  # Wait the namespaces out — deletion is an async lifecycle transition, and
  # fixtures that outlive their run fill the node for every later run.
  local left_ns left_tenant
  for _ in $(seq 1 45); do
    left_ns=$(timeout 60 $K "kubectl get ns --no-headers 2>/dev/null | grep -c cpukeep" 2>/dev/null)
    left_tenant=$(curl -sk "$API/api/v1/tenants?limit=100" -H "Authorization: Bearer $T" \
      | python3 -c 'import sys,json;print(sum(1 for t in json.load(sys.stdin).get("data",[]) if "cpukeep" in t["name"]))' 2>/dev/null)
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
ceiling_of(){ kc "-n $1 get resourcequota $1-quota -o jsonpath='{.spec.hard.limits\.cpu}'"; }
request_of(){ kc "-n $1 get resourcequota $1-quota -o jsonpath='{.spec.hard.requests\.cpu}'"; }

T=$(curl -sk -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])' 2>/dev/null)
[ -n "$T" ] || { echo "FATAL: no token"; exit 1; }
A=(-sk -H "Authorization: Bearer $T" -H 'Content-Type: application/json')
ok "authenticated"

# Smallest plan by storage: these fixtures provision a real volume and the
# test cluster runs out of disk long before it runs out of CPU.
read -r PLAN_ID PLAN_CPU <<<"$(curl "${A[@]}" "$API/api/v1/plans?limit=50" | python3 -c '
import sys,json
d=json.load(sys.stdin)["data"]
def g(p,*k):
    for x in k:
        if p.get(x) is not None: return p[x]
    return None
p=sorted(d, key=lambda p: float(g(p,"storage_limit","storageLimit") or 1e9))[0]
print(p["id"], g(p,"cpu_limit","cpuLimit"))' 2>/dev/null)"
REGION_ID=$(curl "${A[@]}" "$API/api/v1/regions?limit=5" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
[ -n "$PLAN_ID" ] && [ -n "$REGION_ID" ] && [ -n "$PLAN_CPU" ] || { echo "FATAL: no plan/region"; exit 1; }
note "plan $PLAN_ID cpu_limit=$PLAN_CPU"

# ── fixture ─────────────────────────────────────────────────────────────────
NAME="cpukeep-$$"
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
[ -n "$ENTRY" ] || { bad "no catalog entry — the fixture would have no workload" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
curl "${A[@]}" -X POST "$API/api/v1/tenants/$TF/deployments" \
  -d "{\"catalog_entry_id\":\"$ENTRY\",\"name\":\"keep-app\",\"cpu_request\":\"0.2\",\"memory_request\":\"128Mi\"}" >/dev/null 2>&1
READY=0
for _ in $(seq 1 60); do
  r=$(kc "-n $NS get deploy keep-app -o jsonpath='{.status.readyReplicas}'")
  [ "${r:-0}" -ge 1 ] 2>/dev/null && { READY=1; break; }
  sleep 6
done
# A namespace with no running workload passes every assertion below without
# testing anything: the migration has nothing to re-tier and the quota keeps
# whatever it had.
[ "$READY" = "1" ] || { bad "the fixture workload never became Ready — nothing below can be trusted" "$(kc "-n $NS get pods --no-headers" | head -3)"; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
ok "fixture $NS is up with a running workload"

# ══ 1. migrate ══════════════════════════════════════════════════════════════
echo "════ 1. migrate the fixture to the tier model"
CODE=$(curl "${A[@]}" -o "$J/out" -w '%{http_code}' -X POST "$API/api/v1/admin/cpu-migration/tenants/$TF/apply" -d '{"acknowledgeBlockers":true}')
STATUS=$(python3 -c "import json;print(json.load(open('$J/out'))['data']['status'])" 2>/dev/null)
[ "$CODE" = "200" ] && [ "$STATUS" = "completed" ] \
  && ok "migration completed" || bad "migration did not complete" "http=$CODE status=$STATUS $(head -c 200 "$J/out")"
CEIL0=$(ceiling_of "$NS"); REQ0=$(request_of "$NS")
note "after migration: limits.cpu=${CEIL0:-<none>} requests.cpu=${REQ0:-<none>}"
[ -n "$CEIL0" ] && ok "the namespace has a burst ceiling" || bad "no limits.cpu after migration — everything below is vacuous" ""
MODE=$(psql "SELECT cpu_scheduling_mode FROM tenants WHERE id='$TF';")
[ "$MODE" = "tiered" ] && ok "tenant is tiered in the database" || bad "tenant is not tiered" "mode=$MODE"

# ══ 2. a tenant limit edit ══════════════════════════════════════════════════
echo "════ 2. PATCH the tenant's CPU limit — the ceiling must survive"
if [ -z "$CEIL0" ]; then
  bad "skipped: no ceiling to preserve" ""
else
  curl "${A[@]}" -o /dev/null -X PATCH "$API/api/v1/tenants/$TF" -d '{"cpu_limit_override":"0.5"}'
  sleep 8
  C=$(ceiling_of "$NS"); R=$(request_of "$NS")
  [ "$C" = "$CEIL0" ] && ok "ceiling unchanged after a tenant edit ($C)" \
    || bad "a tenant edit changed the ceiling" "before=$CEIL0 after=${C:-<none>}"
  # requests.cpu is the migration's tiered figure; the plan's 0.5 must not
  # land on top of it. Tightening is the dangerous direction — Kubernetes
  # accepts a quota below `used` and then refuses every pod.
  [ "$R" = "$REQ0" ] && ok "requests.cpu still the tiered value ($R)" \
    || bad "a tenant edit rewrote requests.cpu" "before=$REQ0 after=${R:-<none>}"
fi

# ══ 3. a plan edit — the fan-out that caused the production outage ══════════
echo "════ 3. PATCH the plan — the fan-out over every tenant on it"
if [ -z "$CEIL0" ]; then
  bad "skipped: no ceiling to preserve" ""
else
  # Re-send the value the plan ALREADY has. The cascade fires on cpu_limit
  # being present in the body, not on it differing, so this exercises the
  # exact path without changing what any tenant is sold.
  # /admin/plans/:id — NOT /plans/:id, which is the read route and 404s on
  # PATCH. A guessed path here does nothing and the assertion below then
  # passes against a fan-out that never ran.
  PCODE=$(curl "${A[@]}" -o "$J/plan" -w '%{http_code}' -X PATCH "$API/api/v1/admin/plans/$PLAN_ID" -d "{\"cpu_limit\":\"$PLAN_CPU\"}")
  [ "$PCODE" = "200" ] && ok "plan PATCH accepted" || bad "plan PATCH failed" "http=$PCODE $(head -c 200 "$J/plan")"
  sleep 10
  C=$(ceiling_of "$NS")
  if [ "$PCODE" != "200" ]; then
    # ★ Do NOT score this. The fan-out is the whole case, and a ceiling that
    # "survived" an edit the server refused is the vacuous pass this suite
    # exists to avoid.
    note "fan-out never ran, so the ceiling check below proves nothing"
  elif [ "$C" = "$CEIL0" ]; then
    ok "ceiling survived the plan fan-out ($C)"
  else
    bad "THE PRODUCTION BUG: a plan edit removed the ceiling" "before=$CEIL0 after=${C:-<none>}"
  fi
  NOW=$(psql "SELECT cpu_limit FROM hosting_plans WHERE id='$PLAN_ID';")
  [ "$(python3 -c "print(float('$NOW')==float('$PLAN_CPU'))" 2>/dev/null)" = "True" ] \
    && ok "the plan is unchanged ($NOW)" || bad "the harness altered the plan" "was=$PLAN_CPU now=$NOW"
fi

# ══ 4. restore a ceiling that was already lost ══════════════════════════════
echo "════ 4. strip the ceiling by hand, then let the boot sweep repair it"
if [ -z "$CEIL0" ]; then
  bad "skipped: no ceiling to strip" ""
else
  # `null` in a merge patch DELETES the key — the same end state the ten
  # damaged production namespaces are in.
  kc "-n $NS patch resourcequota $NS-quota --type=merge -p '{\"spec\":{\"hard\":{\"limits.cpu\":null}}}'" >/dev/null
  C=$(ceiling_of "$NS")
  [ -z "$C" ] && ok "ceiling stripped, reproducing the damaged state" || bad "could not strip the ceiling" "still=$C"
  if [ -z "$C" ]; then
    # Delete the pod and let the ReplicaSet recreate it. NOT `rollout
    # restart` — Flux treats the restart annotation as drift and scales the
    # new ReplicaSet back to zero.
    POD=$(kc "-n platform get pod -l app=platform-api -o jsonpath='{.items[0].metadata.name}'")
    kc "-n platform delete pod $POD --wait=false" >/dev/null
    note "deleted $POD; waiting for the API to come back"
    UP=0
    for _ in $(seq 1 40); do
      curl -sk -o /dev/null -m 10 "$API/api/v1/health" && { UP=1; break; }
      sleep 6
    done
    [ "$UP" = "1" ] && ok "platform-api is serving again" || bad "the API did not come back" ""
    # The sweep is fire-and-forget on onReady and walks every tenant.
    BACK=""
    for _ in $(seq 1 30); do
      BACK=$(ceiling_of "$NS"); [ -n "$BACK" ] && break
      sleep 6
    done
    [ -n "$BACK" ] && ok "the boot sweep restored the ceiling ($BACK)" \
      || bad "the ceiling was NOT restored — damaged namespaces stay damaged" ""
    [ "$BACK" = "$CEIL0" ] && ok "restored to the resolved value ($BACK)" \
      || note "restored to $BACK, migration had written $CEIL0"
  fi
fi

# ══ 5. revert ═══════════════════════════════════════════════════════════════
echo "════ 5. revert — a legacy namespace must not keep a tiered ceiling"
curl "${A[@]}" -o /dev/null -X POST "$API/api/v1/admin/cpu-migration/tenants/$TF/revert"
RM=""
for _ in $(seq 1 40); do
  RM=$(psql "SELECT cpu_scheduling_mode FROM tenants WHERE id='$TF';")
  [ "$RM" = "legacy" ] && break
  sleep 6
done
[ "$RM" = "legacy" ] && ok "tenant reverted to legacy" || bad "revert did not finish" "mode=$RM"
C=$(ceiling_of "$NS")
[ -z "$C" ] && ok "the ceiling is gone with the tier" || bad "a legacy namespace kept its ceiling" "limits.cpu=$C"

printf '\n════════════════════════════════════\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
