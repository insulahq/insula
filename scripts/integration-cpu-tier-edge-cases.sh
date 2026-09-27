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
    [ -n "$t" ] && curl -sk -X DELETE "$API/api/v1/tenants/$t" -H "Authorization: Bearer $T" >/dev/null 2>&1
  done
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

PLAN_ID=$(curl "${A[@]}" "$API/api/v1/plans?limit=50" | python3 -c '
import sys,json
d=json.load(sys.stdin)["data"]
# Smallest plan that still grants a whole core, so the burst ceiling is a
# round number and the quota arithmetic below is easy to read.
print(sorted(d, key=lambda p: float(p.get("cpu_limit") or p.get("cpuLimit") or 0))[-1]["id"])' 2>/dev/null)
REGION_ID=$(curl "${A[@]}" "$API/api/v1/regions?limit=5" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
[ -n "$PLAN_ID" ] && [ -n "$REGION_ID" ] || { echo "FATAL: no plan/region"; exit 1; }

# ── fixture helpers ─────────────────────────────────────────────────────────

make_tenant() {  # $1 = short label -> echoes tenant id
  local name="cpufix-$1-$$"
  local id
  id=$(curl "${A[@]}" -X POST "$API/api/v1/tenants" -d "{\"name\":\"$name\",\"primary_email\":\"$name@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"cpu_limit_override\":1,\"memory_limit_override\":2}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null)
  [ -n "$id" ] || return 1
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
  local entry
  entry=$(curl "${A[@]}" "$API/api/v1/catalog/entries?limit=100" | python3 -c '
import sys,json
d=json.load(sys.stdin)["data"]
# A single-container runtime keeps the arithmetic legible.
for e in d:
  if (e.get("code") or "").startswith("static") or (e.get("entryType") or e.get("entry_type"))=="static":
    print(e["id"]); break
else: print(d[0]["id"])' 2>/dev/null)
  curl "${A[@]}" -X POST "$API/api/v1/tenants/$1/deployments" \
    -d "{\"catalog_entry_id\":\"$entry\",\"name\":\"$2\",\"cpu_request\":\"$3\",\"memory_request\":\"256Mi\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null
}

wait_ready() {  # $1 namespace
  for _ in $(seq 1 40); do
    local nr
    nr=$(kc "-n $1 get deploy -o json" | python3 -c '
import sys,json
try: items=json.load(sys.stdin).get("items",[])
except Exception: print(1); sys.exit()
print(sum(1 for d in items if (d.get("status",{}).get("readyReplicas") or 0) < (d.get("spec",{}).get("replicas") or 0)))' 2>/dev/null)
    [ "${nr:-1}" = "0" ] && return 0
    sleep 6
  done
  return 1
}

apply_migration() { # $1 tenant  $2 ack -> writes body to $J/out, echoes status
  curl "${A[@]}" -o "$J/out" -w '%{http_code}' -X POST \
    "$API/api/v1/admin/cpu-migration/tenants/$1/apply" -d "{\"acknowledgeBlockers\":$2}"
}

# ══ A. zero-slack quota ═════════════════════════════════════════════════════
echo "════ A. a quota with NO slack — the grace-period rejection"
TA=$(make_tenant a) || { bad "fixture A: tenant create failed"; TA=""; }
if [ -n "$TA" ]; then
  NSA=$(ns_of "$TA")
  deploy_app "$TA" "slack-app" "0.3" >/dev/null
  sleep 8; wait_ready "$NSA"
  USED=$(kc "-n $NSA get resourcequota $NSA-quota -o jsonpath='{.status.used.requests\.cpu}'")
  note "tenant $NSA  used=${USED}"
  # Tighten the quota to EXACTLY what is in use: zero room for a replacement.
  kc "-n $NSA patch resourcequota $NSA-quota --type=merge -p '{\"spec\":{\"hard\":{\"requests.cpu\":\"'"$USED"'\"}}}'" >/dev/null
  HARD=$(kc "-n $NSA get resourcequota $NSA-quota -o jsonpath='{.spec.hard.requests\.cpu}'")
  [ "$HARD" = "$USED" ] && ok "quota tightened to zero slack (hard=used=$HARD)" || bad "could not tighten quota" "hard=$HARD used=$USED"

  CODE=$(apply_migration "$TA" true)
  STATUS=$(python3 -c "import json;print(json.load(open('$J/out'))['data']['status'])" 2>/dev/null)
  if [ "$CODE" = "200" ] && [ "$STATUS" = "completed" ]; then
    ok "migration completed against a zero-slack quota"
  else
    bad "migration did not complete on a zero-slack quota (the CRITICAL)" "$(head -c 300 "$J/out")"
  fi
  # And the app must still be serving — the old failure left it deleted.
  wait_ready "$NSA" && ok "the tenant's workloads are Ready afterwards" \
    || bad "workloads not Ready after the zero-slack migration" ""
fi

# ══ B. already at its tier ══════════════════════════════════════════════════
echo "════ B. a deployment already AT its tier value"
TB=$(make_tenant b) || { bad "fixture B: tenant create failed"; TB=""; }
if [ -n "$TB" ]; then
  NSB=$(ns_of "$TB")
  DB_ID=$(deploy_app "$TB" "attier-app" "0.3")
  sleep 8; wait_ready "$NSB"
  # Resize to exactly the tier the dry run proposes, so from==to.
  TIER=$(curl "${A[@]}" "$API/api/v1/admin/cpu-migration/preview" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
for t in d['tenants']:
  if t['tenantId']=='$TB':
    for x in t['deployments']:
      print(x['proposedMillis']); break
    break" 2>/dev/null)
  note "proposed tier for attier-app = ${TIER}m"
  if [ -n "$TIER" ]; then
    curl "${A[@]}" -X PATCH "$API/api/v1/tenants/$TB/deployments/$DB_ID/resources" -d "{\"cpu_request\":\"${TIER}m\"}" >/dev/null 2>&1
    sleep 8; wait_ready "$NSB"
    CUR=$(psql "SELECT cpu_request FROM deployments WHERE id='$DB_ID';")
    [ "$CUR" = "${TIER}m" ] && ok "deployment parked exactly at its tier (${CUR})" || note "resize landed at '$CUR'"
    CODE=$(apply_migration "$TB" true)
    STATUS=$(python3 -c "import json;print(json.load(open('$J/out'))['data']['status'])" 2>/dev/null)
    [ "$STATUS" = "completed" ] && ok "at-tier deployment migrated (recreated, not skipped)" \
      || bad "at-tier deployment blocked the migration" "$(head -c 300 "$J/out")"
    # The proof it was recreated: its pod now carries a ceiling.
    NOLIM=$(kc "-n $NSB get pods -o json" | python3 -c '
import sys,json
try: items=json.load(sys.stdin).get("items",[])
except Exception: print("PARSE"); sys.exit()
bad=[p["metadata"]["name"] for p in items
     if (p.get("spec",{}).get("priorityClassName") or "")=="tenant-default"
     and p.get("status",{}).get("phase") not in ("Succeeded","Failed")
     and any(not (c.get("resources",{}).get("limits",{}) or {}).get("cpu") for c in p["spec"].get("containers",[]))]
print(",".join(bad) if bad else "NONE")')
    [ "$NOLIM" = "NONE" ] && ok "every in-scope pod carries a ceiling" || bad "pods without a ceiling: $NOLIM" ""
  fi
fi

# ══ C. needs review is enforced server-side ═════════════════════════════════
echo "════ C. a flagged tenant is refused without an acknowledgement"
if [ -n "${TB:-}" ]; then
  # Reuse B's tenant: pin CPU in a custom spec so it reports custom_resources.
  psql "UPDATE deployments SET source='custom', custom_spec='{\"services\":{\"web\":{\"resources\":{\"cpuRequest\":\"500m\"}}}}'::jsonb WHERE tenant_id='$TB';" >/dev/null
  curl "${A[@]}" -X POST "$API/api/v1/admin/cpu-migration/tenants/$TB/revert" >/dev/null 2>&1
  CODE=$(apply_migration "$TB" false)
  if [ "$CODE" = "409" ] && grep -q "CPU_MIGRATION_NEEDS_REVIEW" "$J/out"; then
    ok "409 CPU_MIGRATION_NEEDS_REVIEW without an acknowledgement"
    note "$(python3 -c "import json;print(json.load(open('$J/out'))['error']['message'][:150])" 2>/dev/null)"
  else
    bad "a flagged tenant was NOT refused" "HTTP $CODE $(head -c 220 "$J/out")"
  fi
  CODE=$(apply_migration "$TB" true)
  [ "$CODE" = "200" ] && ok "the same request succeeds once acknowledged" \
    || bad "acknowledged apply still refused with $CODE" "$(head -c 220 "$J/out")"
fi

# ══ D. crash recovery ═══════════════════════════════════════════════════════
echo "════ D. a half-migrated tenant can still be reverted"
TD=$(make_tenant d) || { bad "fixture D: tenant create failed"; TD=""; }
if [ -n "$TD" ]; then
  NSD=$(ns_of "$TD")
  deploy_app "$TD" "crash-app" "0.3" >/dev/null
  sleep 8; wait_ready "$NSD"
  apply_migration "$TD" true >/dev/null
  # Simulate the crash: the flag is written LAST, so clearing it reproduces
  # exactly the state a killed process leaves behind — artifacts in place,
  # mode still legacy.
  psql "UPDATE tenants SET cpu_scheduling_mode='legacy' WHERE id='$TD';" >/dev/null
  psql "UPDATE tasks SET status='running', updated_at=NOW() - INTERVAL '30 minutes' WHERE kind='cpu_migration' AND ref_id='$TD';" >/dev/null
  CODE=$(curl "${A[@]}" -o "$J/rev" -w '%{http_code}' -X POST "$API/api/v1/admin/cpu-migration/tenants/$TD/revert")
  [ "$CODE" = "200" ] && ok "revert reachable on a half-migrated tenant (was NOT_TIERED for 24h)" \
    || bad "revert refused a half-migrated tenant with $CODE" "$(head -c 250 "$J/rev")"
  # …and a stale task must not block a fresh apply either.
  CODE=$(apply_migration "$TD" true)
  [ "$CODE" = "200" ] && ok "a stale running task does not block a new apply" \
    || bad "apply blocked by a dead task with $CODE" "$(head -c 250 "$J/out")"
fi

printf '\n════════════════════════════════════\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
