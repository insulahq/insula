#!/usr/bin/env bash
# integration-cpu-quota-preservation.sh — a tiered namespace keeps its CPU
# model through every writer of its quota. (ADR-062)
#
# `applyResourceQuota` is called by provisioning, the boot sweep, a plan edit,
# a tenant limit edit and namespace-integrity repair. Against a tiered
# namespace each of those once rewrote the quota in the old shape. The
# invariants on a tiered namespace today:
#
#   - the burst CEILING lives in the namespace's LimitRange (`default.cpu`),
#     never on the quota — `limits.cpu` on a quota is a container-count cap
#     wearing the clothes of a CPU limit (ci-no-tenant-cpu-ceiling-quota.sh);
#   - the quota's `requests.cpu` is the sum of the workloads' tier values,
#     not a figure from the plan.
#
#   1. MIGRATE    — the fixture ends tiered, with a LimitRange ceiling.
#   2. TENANT EDIT — PATCH a tenant limit (memory: CPU cores are retired).
#                   Ceiling and requests.cpu must survive.
#   3. PLAN EDIT  — PATCH the plan (the fan-out that caused the outage).
#                   Both must survive on every tenant on that plan.
#   4. NO QUOTA CEILING — after all of it, the quota carries no limits.cpu.
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
ceiling_of(){ kc "-n $1 get limitrange $1-cpu -o jsonpath='{.spec.limits[0].default.cpu}'"; }
quota_ceiling_of(){ kc "-n $1 get resourcequota $1-quota -o jsonpath='{.spec.hard.limits\.cpu}'"; }
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
print(p["id"], g(p,"memory_limit","memoryLimit"))' 2>/dev/null)"
REGION_ID=$(curl "${A[@]}" "$API/api/v1/regions?limit=5" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
[ -n "$PLAN_ID" ] && [ -n "$REGION_ID" ] && [ -n "$PLAN_CPU" ] || { echo "FATAL: no plan/region"; exit 1; }
note "plan $PLAN_ID memory_limit=$PLAN_CPU"

# ── fixture ─────────────────────────────────────────────────────────────────
NAME="cpukeep-$$"
TF=$(curl "${A[@]}" -X POST "$API/api/v1/tenants" \
  -d "{\"name\":\"$NAME\",\"primary_email\":\"$NAME@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null)
[ -n "$TF" ] || { bad "fixture tenant create failed" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
TENANTS+=("$TF")
curl "${A[@]}" -X POST "$API/api/v1/admin/tenants/$TF/provision" -d '{}' >/dev/null 2>&1
# ★ ABORT if it never goes active, and give it long enough.
#
# The first run of this harness waited five minutes, gave up SILENTLY, and
# then created a deployment against a half-provisioned tenant. That call
# failed, its response was discarded, and the run spent another six minutes
# waiting for a workload that had never been asked for — reporting, at the
# end, that the workload "never became Ready". The cause was nowhere in the
# output.
ACTIVE=0
for _ in $(seq 1 120); do
  curl "${A[@]}" "$API/api/v1/tenants/$TF" | grep -q '"status":"active"' && { ACTIVE=1; break; }
  sleep 5
done
if [ "$ACTIVE" != "1" ]; then
  bad "the fixture tenant never became active — nothing below can run" \
      "$(curl "${A[@]}" "$API/api/v1/tenants/$TF" | python3 -c 'import sys,json;d=json.load(sys.stdin).get("data",{});print("status=",d.get("status"),"provisioning=",d.get("provisioningStatus"))' 2>/dev/null)"
  printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1
fi
NS=$(psql "SELECT kubernetes_namespace FROM tenants WHERE id='$TF';")
[ -n "$NS" ] || { bad "fixture has no namespace" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }

# ★ PREFER a first-party image. Taking d[0] took whatever the catalog
# listed first — MinIO, whose Docker Hub image will not pull anonymously —
# and the fixture then sat in ImagePullBackOff while the run reported "the
# workload never became Ready". It passed for months only because that
# image happened to be cached on the node; a freshly wiped host has no
# cache, which is exactly when a harness should still work.
ENTRY=$(curl "${A[@]}" "$API/api/v1/catalog?limit=100" | python3 -c '
import sys,json
d=json.load(sys.stdin).get("data",[])
def imgs(e): return " ".join((c.get("image") or "") for c in (e.get("components") or []))
first=[e for e in d if "ghcr.io/insulahq" in imgs(e)]
pick=(first or d or [None])[0]
print(pick["id"] if pick else "")' 2>/dev/null)
[ -n "$ENTRY" ] || { bad "no catalog entry — the fixture would have no workload" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
# Report WHY. A discarded response is how the first run mistook a refused
# create for a workload that would not start.
DRESP=$(curl "${A[@]}" -X POST "$API/api/v1/tenants/$TF/deployments" \
  -d "{\"catalog_entry_id\":\"$ENTRY\",\"name\":\"keep-app\",\"cpu_request\":\"0.2\",\"memory_request\":\"128Mi\"}")
if ! echo "$DRESP" | grep -q '"id"'; then
  bad "the fixture deployment was refused — nothing below can run" "$(echo "$DRESP" | head -c 300)"
  printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1
fi
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
note "after migration: LimitRange ceiling=${CEIL0:-<none>} quota requests.cpu=${REQ0:-<none>}"
[ -n "$CEIL0" ] && ok "the namespace has a burst ceiling in its LimitRange" || bad "no LimitRange ceiling after migration — everything below is vacuous" ""
MODE=$(psql "SELECT cpu_scheduling_mode FROM tenants WHERE id='$TF';")
[ "$MODE" = "tiered" ] && ok "tenant is tiered in the database" || bad "tenant is not tiered" "mode=$MODE"

# ══ 2. a tenant limit edit ══════════════════════════════════════════════════
echo "════ 2. PATCH a tenant limit — the ceiling must survive"
if [ -z "$CEIL0" ]; then
  bad "skipped: no ceiling to preserve" ""
else
  # Memory: the edit runs the same quota writer, and CPU cores are no longer
  # a tenant override.
  curl "${A[@]}" -o /dev/null -X PATCH "$API/api/v1/tenants/$TF" -d "{\"memory_limit_override\":$PLAN_CPU}"
  sleep 8
  C=$(ceiling_of "$NS"); R=$(request_of "$NS")
  [ "$C" = "$CEIL0" ] && ok "ceiling unchanged after a tenant edit ($C)" \
    || bad "a tenant edit changed the ceiling" "before=$CEIL0 after=${C:-<none>}"
  # requests.cpu is the migration's tiered figure; nothing from the plan may
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
  # Re-send the value the plan ALREADY has. The cascade fires on
  # memory_limit being present in the body, not on it differing, so this
  # exercises the exact path without changing what any tenant is sold.
  # /admin/plans/:id — NOT /plans/:id, which is the read route and 404s on
  # PATCH. A guessed path here does nothing and the assertion below then
  # passes against a fan-out that never ran.
  PCODE=$(curl "${A[@]}" -o "$J/plan" -w '%{http_code}' -X PATCH "$API/api/v1/admin/plans/$PLAN_ID" -d "{\"memory_limit\":\"$PLAN_CPU\"}")
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
  NOW=$(psql "SELECT memory_limit FROM hosting_plans WHERE id='$PLAN_ID';")
  [ "$(python3 -c "print(float('$NOW')==float('$PLAN_CPU'))" 2>/dev/null)" = "True" ] \
    && ok "the plan is unchanged ($NOW)" || bad "the harness altered the plan" "was=$PLAN_CPU now=$NOW"
fi

# ══ 4. the quota never carries a CPU ceiling ════════════════════════════════
echo "════ 4. after every writer, the quota carries no limits.cpu"
QC=$(quota_ceiling_of "$NS")
[ -z "$QC" ] && ok "no limits.cpu on the quota" || bad "a writer put a CPU ceiling on the quota" "limits.cpu=$QC"

printf '\n════════════════════════════════════\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
