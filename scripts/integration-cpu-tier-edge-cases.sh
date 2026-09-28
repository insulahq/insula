#!/usr/bin/env bash
# integration-cpu-tier-edge-cases.sh — ADR-062 R2 edge cases on a live cluster.
#
# The happy path lives in integration-cpu-tier-migration.sh. This one covers
# the cases that only appear under conditions a normal cluster does not
# happen to be in, and that no unit test can reach because they are
# Kubernetes behaviours rather than our logic:
#
#   A. ZERO-SLACK QUOTA. The legacy quota is provisioned with requests.cpu
#      exactly equal to the plan allowance. Replacing a pod leaves it
#      Terminating while still holding its full reservation, so old+new
#      briefly exceed that quota and the ReplicaSet is refused. Before the
#      fix this aborted the migration with the pod already gone. Asserts the
#      migration now succeeds anyway.
#
#   B. AT-TIER RECREATE. A deployment whose request already equals its tier
#      value gets no template change, so nothing rolls and its pods keep
#      running without a ceiling — the readiness check could then never pass.
#      Asserts it is recreated and the migration completes.
#
#   C. NEEDS REVIEW. A deployment that pins its own CPU must block an
#      unacknowledged apply server-side, not merely warn in the UI.
#
#   D. CRASH RECOVERY. mark_tiered is the last step, so a killed process
#      leaves mode=legacy with artifacts in place. Revert must still be
#      reachable, rather than refusing NOT_TIERED until the orphan reaper
#      runs 24h later.
#
# It CREATES its own fixture tenants and deletes them on exit. Fixtures left
# lying around on a shared cluster rot: another agent deletes them, a later
# release changes their shape, and the suite then tests something nobody
# meant. Everything here is built and torn down per run.
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
  # ★ WAIT for the namespaces to go. Tenant deletion is an async lifecycle
  # transition, so a cleanup that fires and walks away leaves the workloads
  # running — six of them accumulated across earlier runs and took the node
  # to 91% of its memory requests, after which nothing could schedule and
  # every later fixture failed for a reason that had nothing to do with the
  # code under test.
  # Wait on the TENANT being gone, which is authoritative, AND on the
  # namespace, which is what actually holds the resources. Watching only
  # the namespace let a tenant row survive the run; watching only the
  # tenant would let the workloads outlive it.
  for _ in $(seq 1 45); do
    local left_ns left_tenant
    left_ns=$(timeout 60 $K "kubectl get ns --no-headers 2>/dev/null | grep -c cpufix" 2>/dev/null)
    left_tenant=$(curl -sk "$API/api/v1/tenants?limit=100" -H "Authorization: Bearer $T" \
      | python3 -c 'import sys,json;print(sum(1 for t in json.load(sys.stdin).get("data",[]) if "cpufix" in t["name"]))' 2>/dev/null)
    [ "${left_ns:-1}" = "0" ] && [ "${left_tenant:-1}" = "0" ] && break
    sleep 10
  done
  # Say so, rather than leaving the next run to meet it as a capacity
  # failure whose message points nowhere near the cause.
  if [ "${left_ns:-0}" != "0" ] || [ "${left_tenant:-0}" != "0" ]; then
    printf "  WARN  fixture cleanup incomplete: %s namespace(s), %s tenant(s) remain\n" \
      "${left_ns:-?}" "${left_tenant:-?}"
  fi
  rm -rf "$J"
}
trap cleanup EXIT

kc(){ timeout 90 $K "kubectl $*" 2>/dev/null; }
psql(){ timeout 90 $K "kubectl -n platform exec system-db-1 -c postgres -- psql -U postgres -d platform -At -c \"$1\"" 2>/dev/null; }

T=$(curl -sk -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])' 2>/dev/null)
[ -n "$T" ] || { echo "FATAL: no token"; exit 1; }
A=(-sk -H "Authorization: Bearer $T" -H 'Content-Type: application/json')
ok "authenticated"

# ★ The SMALLEST plan, by storage. These fixtures exist to exercise CPU
# behaviour, and each one provisions a real tenant with a real volume — on a
# test cluster the binding constraint is disk, not CPU. Taking the largest
# plan (which an earlier version did, contradicting its own comment) filled
# the node after the first fixture and the rest failed to create.
PLAN_ID=$(curl "${A[@]}" "$API/api/v1/plans?limit=50" | python3 -c '
import sys,json
d=json.load(sys.stdin)["data"]
def storage(p): return float(p.get("storage_limit") or p.get("storageLimit") or 1e9)
print(sorted(d, key=storage)[0]["id"])' 2>/dev/null)
REGION_ID=$(curl "${A[@]}" "$API/api/v1/regions?limit=5" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
[ -n "$PLAN_ID" ] && [ -n "$REGION_ID" ] || { echo "FATAL: no plan/region"; exit 1; }

# ── fixture helpers ─────────────────────────────────────────────────────────

make_tenant() {  # $1 = short label -> echoes tenant id
  local name="cpufix-$1-$$"
  local id resp
  # ★ No cpu_limit_override / memory_limit_override here, deliberately.
  # createTenantSchema does not declare them, so Zod strips them and the
  # create returns 200 having ignored them — the fixture then gets the PLAN's
  # limits while the harness believes it asked for more, and its deployment
  # is refused by a quota it did not expect. (That silent-drop is a
  # pre-existing API wart, not something this suite should paper over;
  # scripts/integration-burstable-qos.sh sends the same fields.) The fixture
  # therefore sizes itself to fit the plan it will actually get.
  resp=$(curl "${A[@]}" -X POST "$API/api/v1/tenants" -d "{\"name\":\"$name\",\"primary_email\":\"$name@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\"}")
  id=$(echo "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null)
  # Report WHY. "tenant create failed" with no body sent me looking at the
  # harness when the cluster was simply out of disk.
  if [ -z "$id" ]; then
    note "create failed: $(echo "$resp" | python3 -c 'import sys,json;e=json.load(sys.stdin).get("error",{});print(e.get("code",""),"-",e.get("message",""))' 2>/dev/null | head -c 200)"
    return 1
  fi
  TENANTS+=("$id")
  curl "${A[@]}" -X POST "$API/api/v1/admin/tenants/$id/provision" -d '{}' >/dev/null 2>&1
  for _ in $(seq 1 60); do
    curl "${A[@]}" "$API/api/v1/tenants/$id" | grep -q '"status":"active"' && break
    sleep 5
  done
  echo "$id"
}

ns_of(){ psql "SELECT kubernetes_namespace FROM tenants WHERE id='$1';"; }

deploy_app() {  # $1 tenant  $2 name  $3 cpu_request
  # /api/v1/catalog — NOT /catalog/entries, which 404s. A guessed path here
  # returns nothing, the fixture quietly has no workload, and every
  # assertion downstream then passes against an empty namespace. That is how
  # the first run of this harness reported three green checks for tests that
  # never ran.
  local entry resp id
  entry=$(curl "${A[@]}" "$API/api/v1/catalog?limit=100" | python3 -c '
import sys,json
d=json.load(sys.stdin).get("data",[])
print(d[0]["id"] if d else "")' 2>/dev/null)
  if [ -z "$entry" ]; then bad "fixture: no catalog entry available" ""; return 1; fi
  resp=$(curl "${A[@]}" -X POST "$API/api/v1/tenants/$1/deployments" \
    -d "{\"catalog_entry_id\":\"$entry\",\"name\":\"$2\",\"cpu_request\":\"$3\",\"memory_request\":\"128Mi\"}")
  id=$(echo "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null)
  if [ -z "$id" ]; then bad "fixture: deployment create failed" "$(echo "$resp" | head -c 220)"; return 1; fi
  echo "$id"
}

# ★ Waits for a NAMED deployment to be Ready, not for "nothing unready".
#
# The earlier version counted deployments whose readyReplicas < replicas and
# returned as soon as that count hit zero — which it does instantly when the
# Deployment object does not exist yet, because the tenant is still
# provisioning. The fixture was then measured before it existed: quota used=0,
# no workload, and every assertion downstream evaluated against an empty
# namespace. An empty set satisfies every condition asked of it.
wait_ready() {  # $1 namespace  $2 deployment name
  for _ in $(seq 1 60); do
    local ready
    ready=$(kc "-n $1 get deploy $2 -o jsonpath='{.status.readyReplicas}'")
    [ "${ready:-0}" -ge 1 ] 2>/dev/null && return 0
    sleep 6
  done
  return 1
}

# Every other in-scope workload settled, so a migration is not racing a
# half-started namespace.
wait_all_ready() {  # $1 namespace
  for _ in $(seq 1 40); do
    local nr
    nr=$(kc "-n $1 get deploy -o json" | python3 -c '
import sys,json
try: items=json.load(sys.stdin).get("items",[])
except Exception: print(1); sys.exit()
print(sum(1 for d in items
          if (d.get("spec",{}).get("replicas") or 0) > 0
          and (d.get("status",{}).get("readyReplicas") or 0) < (d.get("spec",{}).get("replicas") or 0)))' 2>/dev/null)
    [ "${nr:-1}" = "0" ] && return 0
    sleep 6
  done
  return 1
}

apply_migration() { # $1 tenant  $2 ack -> writes body to $J/out, echoes status
  curl "${A[@]}" -o "$J/out" -w '%{http_code}' -X POST \
    "$API/api/v1/admin/cpu-migration/tenants/$1/apply" -d "{\"acknowledgeBlockers\":$2}"
}

# ── ONE fixture tenant, reused ──────────────────────────────────────────────
#
# The node this runs against sits at ~90% of its memory requests before the
# harness starts. Three separate fixtures did not fit, and the failures that
# produced said nothing about the code under test. One tenant, reverted
# between cases, covers the same ground.
echo "════ fixture: one tenant, reused across every case"
TF=$(make_tenant one) || TF=""
if [ -z "$TF" ]; then
  bad "could not create the fixture tenant — nothing below can run" ""
  printf '\n════════════════════════════════════\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
  exit 1
fi
NSF=$(ns_of "$TF")
# Inside the starter plan's 250m, or the quota refuses the pod outright.
APP_ID=$(deploy_app "$TF" "edge-app" "0.2") || APP_ID=""
[ -n "$APP_ID" ] || { bad "fixture deployment was not created" ""; printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"; exit 1; }
if wait_ready "$NSF" "edge-app"; then
  ok "fixture tenant $NSF is up with a running workload"
else
  bad "the fixture workload never became Ready — no case below can be trusted" \
      "$(kc "-n $NSF get pods --no-headers" | head -3)"
  printf '\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
  exit 1
fi

reset_tenant() {  # back to clean legacy, so each case starts from the same place
  curl "${A[@]}" -o /dev/null -X POST "$API/api/v1/admin/cpu-migration/tenants/$TF/revert" 2>/dev/null
  for _ in $(seq 1 40); do
    local m b st
    m=$(psql "SELECT cpu_scheduling_mode FROM tenants WHERE id='$TF';")
    b=$(psql "SELECT count(*) FROM deployments WHERE tenant_id='$TF' AND cpu_request_pre_migration IS NOT NULL;")
    # ★ Also wait for the deployment to be `running` again. A revert
    # redeploys, so the row sits at `deploying` for a while — and the dry
    # run only lists RUNNING deployments, so a case that reads the preview
    # immediately after a reset sees a tenant with no applications and
    # cannot find a tier to park on. That is not the product failing; it is
    # this harness reading during a rollout.
    st=$(psql "SELECT status FROM deployments WHERE id='$APP_ID';")
    [ "$m" = "legacy" ] && [ "${b:-1}" = "0" ] && [ "$st" = "running" ] && return 0
    sleep 6
  done
  note "reset gave up with mode=$m baselines=$b deployment=$st"
  return 1
}

# ══ A. zero-slack quota ═════════════════════════════════════════════════════
echo "════ A. a quota with NO slack — the grace-period rejection"
USED=$(kc "-n $NSF get resourcequota $NSF-quota -o jsonpath='{.status.used.requests\.cpu}'")
note "used=${USED}"
if [ -z "$USED" ] || [ "$USED" = "0" ]; then
  bad "no CPU in use — a zero-slack quota over an empty namespace tests nothing" "used=$USED"
else
  kc "-n $NSF patch resourcequota $NSF-quota --type=merge -p '{\"spec\":{\"hard\":{\"requests.cpu\":\"'"$USED"'\"}}}'" >/dev/null
  HARD=$(kc "-n $NSF get resourcequota $NSF-quota -o jsonpath='{.spec.hard.requests\.cpu}'")
  [ "$HARD" = "$USED" ] && ok "quota tightened to zero slack (hard=used=$HARD)" || bad "could not tighten the quota" "hard=$HARD"
  CODE=$(apply_migration "$TF" true)
  STATUS=$(python3 -c "import json;print(json.load(open('$J/out'))['data']['status'])" 2>/dev/null)
  [ "$CODE" = "200" ] && [ "$STATUS" = "completed" ] \
    && ok "migration completed against a zero-slack quota" \
    || bad "the zero-slack case failed — this is the CRITICAL" "$(head -c 260 "$J/out")"
  wait_all_ready "$NSF" && ok "workloads still Ready afterwards" || bad "workloads down after the zero-slack migration" ""
  reset_tenant && ok "reset to legacy for the next case" || bad "could not reset after A" ""
fi

# ══ B. already at its tier ══════════════════════════════════════════════════
echo "════ B. a deployment already AT its tier value"
TIER=$(curl "${A[@]}" "$API/api/v1/admin/cpu-migration/preview" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
t=[x for x in d['tenants'] if x['tenantId']=='$TF']
if not t:
    print('NO_TENANT')
elif not t[0]['deployments']:
    print('NO_DEPLOYMENTS')
else:
    print(t[0]['deployments'][0]['proposedMillis'])" 2>/dev/null)
case "$TIER" in
  NO_TENANT)      bad "the dry run does not list the fixture tenant at all" ""; TIER="" ;;
  NO_DEPLOYMENTS) bad "the dry run lists the tenant with no applications" "the deployment is probably not 'running' yet"; TIER="" ;;
esac
if [ -z "$TIER" ]; then
  bad "could not read a proposed tier from the dry run" "the at-tier case did not run"
else
  note "proposed tier = ${TIER}m"
  curl "${A[@]}" -o /dev/null -X PATCH "$API/api/v1/tenants/$TF/deployments/$APP_ID/resources" -d "{\"cpu_request\":\"${TIER}m\"}"
  wait_ready "$NSF" "edge-app" >/dev/null
  CUR=$(psql "SELECT cpu_request FROM deployments WHERE id='$APP_ID';")
  [ "$CUR" = "${TIER}m" ] && ok "deployment parked exactly at its tier ($CUR)" || bad "resize landed at '$CUR'" ""
  CODE=$(apply_migration "$TF" true)
  STATUS=$(python3 -c "import json;print(json.load(open('$J/out'))['data']['status'])" 2>/dev/null)
  [ "$STATUS" = "completed" ] && ok "at-tier deployment migrated (recreated, not skipped)" \
    || bad "an at-tier deployment blocked the migration" "$(head -c 280 "$J/out")"
  NOLIM=$(kc "-n $NSF get pods -o json" | python3 -c '
import sys,json
try: items=json.load(sys.stdin).get("items",[])
except Exception: print("PARSE"); sys.exit()
bad=[]
for p in items:
  if p["metadata"].get("deletionTimestamp"): continue
  if p.get("status",{}).get("phase") in ("Succeeded","Failed"): continue
  if (p.get("spec",{}).get("priorityClassName") or "") != "tenant-default": continue
  for c in p["spec"].get("containers",[]):
    if not (c.get("resources",{}).get("limits",{}) or {}).get("cpu"): bad.append(p["metadata"]["name"])
print(",".join(sorted(set(bad))) if bad else "NONE")')
  [ "$NOLIM" = "NONE" ] && ok "every in-scope pod carries a ceiling" || bad "pods without a ceiling: $NOLIM" ""
  reset_tenant && ok "reset to legacy for the next case" || bad "could not reset after B" ""
fi

# ══ C. needs review is enforced server-side ═════════════════════════════════
echo "════ C. a flagged tenant is refused without an acknowledgement"
psql "UPDATE deployments SET source='custom', custom_spec='{\"services\":{\"web\":{\"resources\":{\"cpuRequest\":\"500m\"}}}}'::jsonb WHERE id='$APP_ID';" >/dev/null
CODE=$(apply_migration "$TF" false)
if [ "$CODE" = "409" ] && grep -q "CPU_MIGRATION_NEEDS_REVIEW" "$J/out"; then
  ok "409 CPU_MIGRATION_NEEDS_REVIEW without an acknowledgement"
  note "$(python3 -c "import json;print(json.load(open('$J/out'))['error']['message'][:150])" 2>/dev/null)"
else
  bad "a flagged tenant was NOT refused" "HTTP $CODE $(head -c 220 "$J/out")"
fi
# The retry the refusal invites must work — it did not, until the task claim
# was moved after the checks.
CODE=$(apply_migration "$TF" true)
[ "$CODE" = "200" ] && ok "the same request succeeds once acknowledged" \
  || bad "the acknowledged retry was refused with $CODE" "$(head -c 220 "$J/out")"

# ══ D. crash recovery ═══════════════════════════════════════════════════════
echo "════ D. a half-migrated tenant can still be reverted"
# The flag is written LAST, so clearing it reproduces exactly what a killed
# process leaves behind: artifacts in place, mode still legacy.
psql "UPDATE tenants SET cpu_scheduling_mode='legacy' WHERE id='$TF';" >/dev/null
psql "UPDATE tasks SET status='running', updated_at=NOW() - INTERVAL '30 minutes' WHERE kind='cpu_migration' AND ref_id='$TF';" >/dev/null
CODE=$(curl "${A[@]}" -o "$J/rev" -w '%{http_code}' -X POST "$API/api/v1/admin/cpu-migration/tenants/$TF/revert")
[ "$CODE" = "200" ] && ok "revert reachable on a half-migrated tenant (was NOT_TIERED for 24h)" \
  || bad "revert refused a half-migrated tenant with $CODE" "$(head -c 250 "$J/rev")"
CODE=$(apply_migration "$TF" true)
[ "$CODE" = "200" ] && ok "a stale running task does not block a new apply" \
  || bad "apply blocked by a dead task with $CODE" "$(head -c 250 "$J/out")"

printf '\n════════════════════════════════════\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
