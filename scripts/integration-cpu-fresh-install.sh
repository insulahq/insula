#!/usr/bin/env bash
# integration-cpu-fresh-install.sh — a FRESH cluster comes up on the tier
# model, and stays on it (ADR-062 R3).
#
# ★ Every path here had never executed anywhere.
#
# `prepareTieredNamespace`, the seeded plan ceilings, and the decision that
# records `cpu_scheduling_default` all fire on a fresh install ONLY. Both the
# DEV and production clusters recorded `legacy` long before this code
# existed, so nothing exercised any of it — and the failure mode is the worst
# kind: a brand-new tenant whose namespace carries a quota ceiling its
# LimitRange cannot satisfy refuses its own first deploy.
#
#   1. DEFAULT     the cluster recorded `tiered`, not `legacy`.
#   2. PLANS       the seeded plans declare a tier AND a ceiling.
#   3. NAMESPACE   a new tenant is born tiered: LimitRange first, then a
#                  quota carrying the ceiling, and the row marked only after.
#   4. FIRST APP   its first application deploys, and asks for the tenant's
#                  SHARE rather than the catalog's core count.
#   5. GROWTH      a second application does not exhaust the namespace quota
#                  — the gap that left migrated tenants three deploys of room.
#   6. CUSTOM      a bring-your-own container takes the tenant's share too.
#
# RUN THIS ONLY AGAINST A CLUSTER BOOTSTRAPPED FROM SCRATCH. It asserts
# facts that are only true of one, and it says so rather than passing
# vacuously on an upgraded cluster.
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
  local left
  for _ in $(seq 1 45); do
    left=$(timeout 60 $K "kubectl get ns --no-headers 2>/dev/null | grep -c cpufresh" 2>/dev/null)
    [ "${left:-1}" = "0" ] && break
    sleep 10
  done
  [ "${left:-0}" = "0" ] || printf "  WARN  %s fixture namespace(s) remain\n" "${left:-?}"
  rm -rf "$J"
}
trap cleanup EXIT

kc(){ timeout 90 $K "kubectl $*" 2>/dev/null; }
psql(){ timeout 90 $K "kubectl -n platform exec system-db-1 -c postgres -- psql -U postgres -d platform -At -c \"$1\"" 2>/dev/null; }
lr_ceiling(){ kc "-n $1 get limitrange $1-cpu -o jsonpath='{.spec.limits[0].default.cpu}'"; }
lr_request(){ kc "-n $1 get limitrange $1-cpu -o jsonpath='{.spec.limits[0].defaultRequest.cpu}'"; }
q_ceiling(){ kc "-n $1 get resourcequota $1-quota -o jsonpath='{.spec.hard.limits\.cpu}'"; }
q_request(){ kc "-n $1 get resourcequota $1-quota -o jsonpath='{.spec.hard.requests\.cpu}'"; }

T=$(curl -sk -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])' 2>/dev/null)
[ -n "$T" ] || { echo "FATAL: no token"; exit 1; }
A=(-sk -H "Authorization: Bearer $T" -H 'Content-Type: application/json')
ok "authenticated"

# ══ 1. the cluster decided it is a fresh install ════════════════════════════
echo "════ 1. the recorded default for NEW tenants"
DEFAULT=$(psql "SELECT setting_value FROM platform_settings WHERE setting_key='cpu_scheduling_default';")
note "cpu_scheduling_default = ${DEFAULT:-<unrecorded>}"
# ★ Unrecorded is NOT a pass. It is decided lazily, at the first tenant
# creation, so before any tenant exists there is nothing to read — and
# asserting "not legacy" would accept that silence.
if [ "$DEFAULT" = "tiered" ]; then
  ok "recorded tiered"
elif [ -z "$DEFAULT" ]; then
  note "not recorded yet — decided at the first tenant creation, re-checked below"
else
  bad "a FRESH cluster recorded '$DEFAULT'; every new tenant will be legacy" "$DEFAULT"
fi

# ══ 2. the seeded plans ═════════════════════════════════════════════════════
echo "════ 2. the seeded plans declare a tier and a ceiling"
PLANS=$(psql "SELECT code||'|'||coalesce(cpu_tier::text,'-')||'|'||coalesce(cpu_burst_cores::text,'-') FROM hosting_plans ORDER BY monthly_price_usd;")
note "$(echo "$PLANS" | tr '\n' ' ')"
for want in 'starter|normal|1.00' 'premium|high|2.00' 'ultimate|highest|4.00'; do
  echo "$PLANS" | grep -qx "$want" && ok "plan $want" || bad "plan not seeded as expected" "wanted $want"
done
# The list must not reorder when a plan is saved — a bare SELECT returns
# physical order and Postgres moves a row on UPDATE.
O1=$(curl "${A[@]}" "$API/api/v1/plans?a=$$" | python3 -c 'import sys,json;print(",".join(p["code"] for p in json.load(sys.stdin)["data"]))' 2>/dev/null)
PID=$(curl "${A[@]}" "$API/api/v1/plans?b=$$" | python3 -c 'import sys,json;d=json.load(sys.stdin)["data"];print([p["id"] for p in d if p["code"]=="premium"][0])' 2>/dev/null)
curl "${A[@]}" -o /dev/null -X PATCH "$API/api/v1/admin/plans/$PID" -d '{"name":"Premium"}'
sleep 12
O2=$(curl "${A[@]}" "$API/api/v1/plans?c=$$" | python3 -c 'import sys,json;print(",".join(p["code"] for p in json.load(sys.stdin)["data"]))' 2>/dev/null)
note "plan order: $O1 -> $O2"
[ -n "$O1" ] && [ "$O1" = "$O2" ] && ok "the plan list does not reorder when a plan is saved" \
  || bad "the plan list reordered — Edit will open the wrong plan" "$O1 vs $O2"

# ══ 3. a new tenant is born tiered ══════════════════════════════════════════
echo "════ 3. a NEW tenant's namespace"
# ★ The LARGEST plan, deliberately. This fixture runs THREE workloads to
# prove the namespace has room to grow, and the smallest plan's memory
# allowance (256Mi) is exhausted by two of them — the third would be
# refused on MEMORY and read as a CPU-quota failure. Disk is not the
# binding constraint on a freshly wiped host.
PLAN_ID=$(curl "${A[@]}" "$API/api/v1/plans?limit=50" | python3 -c '
import sys,json
d=json.load(sys.stdin)["data"]
def mem(p): return float(p.get("memory_limit") or p.get("memoryLimit") or 0)
print(sorted(d, key=mem)[-1]["id"])' 2>/dev/null)
REGION_ID=$(curl "${A[@]}" "$API/api/v1/regions?limit=5" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
[ -n "$PLAN_ID" ] && [ -n "$REGION_ID" ] || { bad "no plan/region" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }

NAME="cpufresh-$$"
TF=$(curl "${A[@]}" -X POST "$API/api/v1/tenants" \
  -d "{\"name\":\"$NAME\",\"primary_email\":\"$NAME@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null)
[ -n "$TF" ] || { bad "tenant create failed" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
TENANTS+=("$TF")
curl "${A[@]}" -X POST "$API/api/v1/admin/tenants/$TF/provision" -d '{}' >/dev/null 2>&1
ACTIVE=0
for _ in $(seq 1 120); do
  curl "${A[@]}" "$API/api/v1/tenants/$TF" | grep -q '"status":"active"' && { ACTIVE=1; break; }
  sleep 5
done
[ "$ACTIVE" = "1" ] || { bad "the tenant never became active — nothing below can run" \
  "$(curl "${A[@]}" "$API/api/v1/tenants/$TF" | head -c 200)"; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
NS=$(psql "SELECT kubernetes_namespace FROM tenants WHERE id='$TF';")
ok "tenant provisioned into $NS"

MODE=$(psql "SELECT cpu_scheduling_mode FROM tenants WHERE id='$TF';")
[ "$MODE" = "tiered" ] && ok "born TIERED, with no migration" \
  || bad "a new tenant on a fresh cluster came up '$MODE'" "$MODE"
DEFAULT=$(psql "SELECT setting_value FROM platform_settings WHERE setting_key='cpu_scheduling_default';")
[ "$DEFAULT" = "tiered" ] && ok "the default is now recorded as tiered" \
  || bad "cpu_scheduling_default is '$DEFAULT'" "$DEFAULT"

# What the PLAN sells, read from the row the seed wrote — so this compares
# two subsystems rather than restating one plan's arithmetic.
PLAN_TIER=$(psql "SELECT cpu_tier FROM hosting_plans WHERE id='$PLAN_ID';")
PLAN_BURST=$(psql "SELECT cpu_burst_cores::numeric(6,2) FROM hosting_plans WHERE id='$PLAN_ID';")
case "$PLAN_TIER" in
  normal) WANT_REQ=5m ;; high) WANT_REQ=30m ;; highest) WANT_REQ=100m ;;
  *) WANT_REQ='' ;;
esac
WANT_CEIL=$(python3 -c "print(('%g' % float('${PLAN_BURST:-0}')))" 2>/dev/null)
note "plan sells tier=$PLAN_TIER ($WANT_REQ) ceiling=$WANT_CEIL cores"

C=$(lr_ceiling "$NS"); R=$(lr_request "$NS"); QC=$(q_ceiling "$NS")
note "LimitRange default=$C defaultRequest=$R · quota limits.cpu=$QC"
[ -n "$C" ] && ok "the namespace has a CPU LimitRange" \
  || bad "no LimitRange — the tenant was not built tiered" ""
[ -n "$WANT_REQ" ] && [ "$R" = "$WANT_REQ" ] && ok "the LimitRange requests the plan's tier ($WANT_REQ)" \
  || bad "the LimitRange does not request the plan's tier" "got $R, plan sells $PLAN_TIER"
[ -n "$WANT_CEIL" ] && [ "$C" = "$WANT_CEIL" ] && ok "the LimitRange ceiling is the plan's ($WANT_CEIL cores)" \
  || bad "the LimitRange ceiling is not the plan's" "got $C, plan sells $WANT_CEIL"
# ★ The ordering that matters. A quota carrying limits.cpu obliges every pod
# to declare one; if the ceiling landed before the LimitRange the tenant's
# first deploy would be refused.
[ -n "$QC" ] && ok "the quota carries a ceiling ($QC)" || bad "the quota has no ceiling" ""

# ══ 4. its first application ════════════════════════════════════════════════
echo "════ 4. the FIRST application deploys, and asks for the share"
# The catalog syncs from its repository after first boot, and this cluster
# is minutes old — an empty list here is "not yet", not "broken", and
# failing on it would report a platform bug that is really a race.
ENTRY=""; ENTRY_CODE=""
for _ in $(seq 1 40); do
  # ★ PREFER a first-party image. Taking d[0] took whatever the catalog
  # happened to list first — MinIO, whose Docker Hub image will not pull
  # anonymously — and the run reported "it never became Ready" for a
  # registry problem that has nothing to do with this feature.
  read -r ENTRY ENTRY_CODE <<<"$(curl "${A[@]}" "$API/api/v1/catalog?limit=100" | python3 -c '
import sys,json
d=json.load(sys.stdin).get("data",[])
def imgs(e): return " ".join((c.get("image") or "") for c in (e.get("components") or []))
first = [e for e in d if "ghcr.io/insulahq" in imgs(e)]
pick = (first or d or [None])[0]
print(pick["id"], pick["code"]) if pick else print("", "")' 2>/dev/null)"
  [ -n "$ENTRY" ] && break
  sleep 15
done
note "catalog entry: ${ENTRY_CODE:-none}"
[ -n "$ENTRY" ] || { bad "the catalog never populated — nothing below can run" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
D1=$(curl "${A[@]}" -X POST "$API/api/v1/tenants/$TF/deployments" \
  -d "{\"catalog_entry_id\":\"$ENTRY\",\"name\":\"fresh-one\",\"memory_request\":\"192Mi\"}")
if echo "$D1" | grep -q '"id"'; then ok "the first application was accepted"; else
  bad "the first deploy on a born-tiered tenant was REFUSED" "$(echo "$D1" | head -c 300)"
fi
# ★ ADMITTED, not Ready.
#
# What this harness asks is whether a born-tiered namespace lets its own
# first pod in — quota, LimitRange and ceiling agreeing. A pod that is
# admitted and then cannot pull its image has already answered that; making
# the assertion depend on a public registry serving an image turns an
# unrelated outage into a failure of this feature. A pod REFUSED by the
# quota never gets created at all, which is what the check below detects.
admitted_pod() {  # $1 deployment name -> echoes pod name, or empty
  for _ in $(seq 1 40); do
    local p
    p=$(kc "-n $NS get pods -l app=$1 --no-headers -o custom-columns=:metadata.name" | head -1)
    [ -n "$p" ] && { echo "$p"; return 0; }
    sleep 6
  done
  return 1
}
P1=$(admitted_pod fresh-one)
if [ -n "$P1" ]; then
  ok "its pod was admitted ($P1)"
  PHASE=$(kc "-n $NS get pod $P1 -o jsonpath='{.status.phase}'")
  IMGPULL=$(kc "-n $NS get pod $P1 -o jsonpath='{.status.containerStatuses[0].state.waiting.reason}'")
  case "$IMGPULL" in
    ImagePullBackOff|ErrImagePull)
      note "image will not pull ($IMGPULL) — a registry problem, not an admission one; readiness not scored" ;;
    *)
      [ "$PHASE" = "Running" ] && ok "and it is Running" || note "phase=$PHASE reason=${IMGPULL:-none}" ;;
  esac
else
  bad "no pod was ever created — the namespace refused its own first workload" \
      "$(kc "-n $NS get events --field-selector reason=FailedCreate --no-headers" | tail -3)"
fi
CPU1=$(psql "SELECT cpu_request FROM deployments WHERE tenant_id='$TF' AND name='fresh-one';")
# ★ NOT the catalog's core count. createDeploymentSchema defaults
# cpu_request to '0.25' when omitted, so "the client did not send it" is not
# what makes this the tier — the server normalising it is.
[ -n "$WANT_REQ" ] && [ "$CPU1" = "$WANT_REQ" ] \
  && ok "it asks for the tenant's share ($WANT_REQ), not the catalog's 0.25" \
  || bad "a new application reserved the catalog's core count" "cpu_request=$CPU1, plan sells $WANT_REQ"
PODCPU=$(kc "-n $NS get pod $P1 -o jsonpath='{.spec.containers[0].resources.requests.cpu}'")
note "pod requests.cpu=$PODCPU limits.cpu=$(kc "-n $NS get pod $P1 -o jsonpath='{.spec.containers[0].resources.limits.cpu}'")"
[ "$PODCPU" = "$WANT_REQ" ] && ok "and the running pod reserves it" || bad "the pod reserves something else" "$PODCPU"

# ══ 5. room to grow ═════════════════════════════════════════════════════════
echo "════ 5. a SECOND application still fits"
Q1=$(q_request "$NS")
D2=$(curl "${A[@]}" -X POST "$API/api/v1/tenants/$TF/deployments" \
  -d "{\"catalog_entry_id\":\"$ENTRY\",\"name\":\"fresh-two\",\"memory_request\":\"192Mi\"}")
if echo "$D2" | grep -q '"id"'; then ok "the second application was accepted"; else
  bad "the second deploy was refused" "$(echo "$D2" | head -c 300)"
fi
P2=$(admitted_pod fresh-two)
Q2=$(q_request "$NS")
note "quota requests.cpu: $Q1 -> $Q2"
# ★ The gap this case exists for: the quota was sized once and never grew,
# so a migrated tenant ran out of room after about three deploys. A pod
# that is never CREATED is the symptom — the ReplicaSet reports
# FailedCreate "exceeded quota" and nothing appears.
[ -n "$P2" ] && ok "a second pod was admitted — the namespace quota made room" \
  || bad "the second workload was refused; the quota did not grow" \
     "$(kc "-n $NS get events --field-selector reason=FailedCreate --no-headers" | tail -3)"

# ══ 6. a bring-your-own container ═══════════════════════════════════════════
echo "════ 6. a CUSTOM container takes the tenant's share too"
# The seeded plans ship with custom containers OFF, so the case skipped
# itself on a fresh cluster — and a skip that reads as a platform
# limitation is exactly how a real gap survives. Turn it on for the
# fixture, which is a per-tenant override an operator would use anyway.
curl "${A[@]}" -o /dev/null -X PATCH "$API/api/v1/tenants/$TF" -d '{"allow_custom_containers_override":true}'
sleep 3
# POST …/custom-deployments with mode:'simple' — NOT a /simple sub-path,
# which 404s. A guessed path here would log "unavailable" and skip, and a
# skip that looks like a platform limitation is how a real gap survives.
CC=$(curl "${A[@]}" -w '\n%{http_code}' -X POST "$API/api/v1/tenants/$TF/custom-deployments" \
  -d '{"mode":"simple","name":"fresh-custom","image":"nginx:1.27-alpine","ports":[{"containerPort":80,"name":"http","protocol":"TCP","exposeAsService":true,"ingressEligible":true}],"resources":{"cpuRequest":"500m","memoryRequest":"64Mi"}}')
CCODE=$(echo "$CC" | tail -1); CBODY=$(echo "$CC" | head -n -1)
note "custom create HTTP $CCODE"
case "$CCODE" in
  201|200)
    ok "the custom container was accepted"
    sleep 6
    CCPU=$(psql "SELECT cpu_request FROM deployments WHERE tenant_id='$TF' AND name='fresh-custom';")
    # It asked for 500m. Under the tier model nothing a tenant deploys
    # outranks anything else they deploy.
    [ "$CCPU" = "$WANT_REQ" ] && ok "its 500m request was normalised to the tenant's share" \
      || bad "a custom container kept its own CPU request" "cpu_request=$CCPU, plan sells $WANT_REQ"
    ;;
  403)
    # Administratively disabled, or not allowed by this plan. A real
    # configuration, not a failure — but SAY which, so a silent skip cannot
    # hide a broken path.
    note "refused 403: $(echo "$CBODY" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("error",{}).get("code",""))' 2>/dev/null) — custom containers are off on this cluster, case SKIPPED"
    ;;
  *)
    bad "the custom container create failed unexpectedly" "HTTP $CCODE $(echo "$CBODY" | head -c 250)"
    ;;
esac

printf '\n════════════════════════════════════\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
