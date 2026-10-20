#!/usr/bin/env bash
# Real E2E for ADR-062 against DEV: put one tenant on the old reservation
# model (lib/cpu-legacy-fixture.sh — there is no revert any more), migrate it
# to CPU shares, and assert the CLUSTER state, not the API's self-report. This
# is the migration the platform now runs by itself for every legacy tenant
# (cpu-migration/auto-migrate.ts), held off while this runs.
set -uo pipefail

# No operator infra in a PUBLIC repo — the apex, the node and the key all come
# from the gitignored profile. See docs/development/INTEGRATION_TESTS.md.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cpu-legacy-fixture.sh"
load_integration_env
# SSH_HOST / SSH_KEY are the names every other harness already uses, so an
# operator with a profile does not have to add anything for this one.
require_env ADMIN_HOST ADMIN_EMAIL ADMIN_PASSWORD SSH_HOST TID NS

API="${ADMIN_HOST}"
K="ssh -i ${SSH_KEY:?set SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=20 ${SSH_HOST}"
ADMIN_PW="${ADMIN_PASSWORD}"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  FAIL  %s\n     -> %s\n' "$1" "${2:-}"; }
J=$(mktemp -d); trap 'release_cpu_auto_migrate; rm -rf "$J"' EXIT

kc(){ timeout 90 $K "kubectl $*" 2>/dev/null; }
psql(){ timeout 90 $K "kubectl -n platform exec system-db-1 -c postgres -- psql -U postgres -d platform -At -c \"$1\"" 2>/dev/null; }

T=$(curl -sk -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])' 2>/dev/null)
[ -n "$T" ] || { echo "FATAL: no token"; exit 1; }
A=(-sk -H "Authorization: Bearer $T" -H 'Content-Type: application/json')
ok "authenticated"

# ★ Start from a KNOWN state. A previous run that failed part-way leaves the
# tenant half-migrated, and every assertion below then measures against a
# polluted baseline — "restored character for character" compares to whatever
# the last failure left behind, and the NOT_TIERED check sees artifacts and
# correctly returns 200. Three of four failures in one run were this, not the
# product. Reset first, then record.
echo "════ 0. reset to a known-clean legacy baseline, then record it"
hold_cpu_auto_migrate
make_legacy "$TID" "$NS"
# make_legacy redeploys each application with its legacy-sized request. The
# migration re-tiers RUNNING applications only, so wait them out — measuring
# mid-rollout migrates nothing and reads as a missing baseline.
for _ in $(seq 1 40); do
  NR=$(psql "SELECT count(*) FROM deployments WHERE tenant_id='$TID' AND status IN ('deploying','pending','upgrading');")
  [ "${NR:-1}" = "0" ] && break
  sleep 6
done
for _ in $(seq 1 30); do
  M=$(psql "SELECT cpu_scheduling_mode FROM tenants WHERE id='$TID';")
  B=$(psql "SELECT count(*) FROM deployments WHERE tenant_id='$TID' AND cpu_request_pre_migration IS NOT NULL;")
  LR=$(kc "-n $NS get limitrange -o name" | wc -l)
  [ "$M" = "legacy" ] && [ "${B:-1}" = "0" ] && [ "${LR:-1}" = "0" ] && break
  sleep 4
done
[ "$M" = "legacy" ] && [ "${B:-1}" = "0" ] && [ "${LR:-1}" = "0" ] \
  && ok "tenant reset to clean legacy state" \
  || bad "could not reach a clean baseline" "mode=$M baselines=$B limitranges=$LR"

BEFORE=$(psql "SELECT name||'='||cpu_request FROM deployments WHERE tenant_id='$TID' AND status<>'deleted' ORDER BY name;" | tr '\n' ' ')
echo "     before: $BEFORE"
MODE0=$(psql "SELECT cpu_scheduling_mode FROM tenants WHERE id='$TID';")
[ "$MODE0" = "legacy" ] && ok "tenant starts in legacy mode" || bad "expected legacy, got '$MODE0'"

echo "════ 1. the dry run reports this tenant as legacy"
curl "${A[@]}" "$API/api/v1/admin/cpu-migration/preview" -o "$J/prev"
python3 - "$J/prev" "$TID" <<'PY' && ok "preview carries schedulingMode=legacy" || bad "preview missing/incorrect schedulingMode"
import sys,json
d=json.load(open(sys.argv[1]))["data"]
t=[x for x in d["tenants"] if x["tenantId"]==sys.argv[2]]
sys.exit(0 if t and t[0].get("schedulingMode")=="legacy" else 1)
PY

echo "════ 2. an unacknowledged apply is REFUSED when the tenant is flagged"
CODE=$(curl "${A[@]}" -o "$J/noack" -w '%{http_code}' -X POST "$API/api/v1/admin/cpu-migration/tenants/$TID/apply" -d '{}')
ACK_NEEDED=0
if [ "$CODE" = "409" ] && grep -q "CPU_MIGRATION_NEEDS_REVIEW" "$J/noack"; then
  ACK_NEEDED=1
  ok "409 CPU_MIGRATION_NEEDS_REVIEW — the review is enforced server-side"
  echo "     $(python3 -c "
import json;d=json.load(open('$J/noack'))['error'];print(d['message'][:160])" 2>/dev/null)"
elif [ "$CODE" = "200" ]; then
  ok "tenant had no blockers; applied without an acknowledgement"
else
  bad "unexpected $CODE from the unacknowledged apply" "$(head -c 250 "$J/noack")"
fi

echo "════ 2b. migrate this ONE tenant (acknowledged if it was flagged)"
if [ "$ACK_NEEDED" = "1" ]; then
  CODE=$(curl "${A[@]}" -o "$J/apply" -w '%{http_code}' -X POST "$API/api/v1/admin/cpu-migration/tenants/$TID/apply" -d '{"acknowledgeBlockers":true}')
else
  cp "$J/noack" "$J/apply"
fi
echo "     HTTP $CODE  $(head -c 260 "$J/apply")"
[ "$CODE" = "200" ] && ok "apply returned 200" || bad "apply failed with $CODE" "$(head -c 300 "$J/apply")"
if python3 -c "
import sys,json;d=json.load(open('$J/apply'))['data']
sys.exit(0 if d['status']=='completed' else 1)"; then
  ok "run reports completed"
else
  bad "run did not complete" "$(head -c 300 "$J/apply")"
  # ★ STOP. Everything below asserts the RESULT of a migration. With no
  # migration they pass by absence — "LimitRange removed" is trivially true
  # when one was never created, and "restored character for character" is
  # trivially true when nothing was changed. A run that reports 12 green
  # checks after its first step 403'd is worse than one that reports none.
  printf '\n  ABORTED: the migration did not complete, so the remaining\n'
  printf '  assertions would pass by absence rather than by evidence.\n'
  printf '\n════════════════════════════════════\n  PASS: %s   FAIL: %s  (aborted early)\n' "$PASS" "$FAIL"
  exit 1
fi

echo "════ 3. the CLUSTER shows it, not just the API"
LR=$(kc "-n $NS get limitrange $NS-cpu -o jsonpath='{.spec.limits[0].defaultRequest.cpu}|{.spec.limits[0].default.cpu}|{.spec.limits[0].max.cpu}'")
[ -n "$LR" ] && ok "LimitRange exists: $LR" || bad "no LimitRange in $NS"
QH=$(kc "-n $NS get resourcequota $NS-quota -o jsonpath='{.spec.hard.requests\.cpu}|{.spec.hard.limits\.cpu}'")
echo "     quota requests.cpu|limits.cpu = $QH"
# The ceiling is the LimitRange's; a quota limits.cpu is a container-count
# cap and must never be there (ci-no-tenant-cpu-ceiling-quota.sh).
[ -z "${QH#*|}" ] && ok "the quota carries no CPU ceiling" || bad "the quota carries limits.cpu" "$QH"

echo "════ 4. every tenant-default pod now declares a CPU limit"
MISSING=$(kc "-n $NS get pods -o json" | python3 -c '
import sys,json
try: items=json.load(sys.stdin).get("items",[])
except Exception: print("PARSE"); sys.exit()
bad=[]
for p in items:
  if p.get("status",{}).get("phase") in ("Succeeded","Failed"): continue
  if (p.get("spec",{}).get("priorityClassName") or "") != "tenant-default": continue
  for c in p["spec"].get("containers",[]):
    if not (c.get("resources",{}).get("limits",{}) or {}).get("cpu"):
      bad.append(p["metadata"]["name"]+"/"+c.get("name",""))
print(",".join(bad) if bad else "NONE")')
[ "$MISSING" = "NONE" ] && ok "all in-scope pods carry a CPU limit" || bad "pods without a limit: $MISSING"

echo "════ 5. the database recorded the baseline and the mode"
MODE1=$(psql "SELECT cpu_scheduling_mode FROM tenants WHERE id='$TID';")
[ "$MODE1" = "tiered" ] && ok "tenant is now tiered" || bad "mode is '$MODE1', expected tiered"
STORED=$(psql "SELECT count(*) FROM deployments WHERE tenant_id='$TID' AND cpu_request_pre_migration IS NOT NULL;")
[ "${STORED:-0}" -gt 0 ] && ok "$STORED deployment(s) have a stored baseline" || bad "no baselines stored"

echo "════ 6. the workloads are actually RUNNING, not merely reconfigured"
NOTREADY=$(kc "-n $NS get deploy -o json" | python3 -c '
import sys,json
try: items=json.load(sys.stdin).get("items",[])
except Exception: print("PARSE"); sys.exit()
bad=[d["metadata"]["name"] for d in items
     if (d.get("status",{}).get("readyReplicas") or 0) < (d.get("spec",{}).get("replicas") or 0)]
print(",".join(bad) if bad else "NONE")')
[ "$NOTREADY" = "NONE" ] && ok "every workload has its replicas" || bad "not ready: $NOTREADY"

echo "════ 7. there is no way back: revert is gone"
CODE=$(curl "${A[@]}" -o "$J/rev" -w '%{http_code}' -X POST "$API/api/v1/admin/cpu-migration/tenants/$TID/revert")
[ "$CODE" = "404" ] && ok "the retired revert route is 404" || bad "revert answered $CODE" "$(head -c 200 "$J/rev")"
LR2=$(kc "-n $NS get limitrange $NS-cpu -o name")
[ -n "$LR2" ] && ok "the LimitRange stays" || bad "the LimitRange is gone" ""

printf '\n════════════════════════════════════\n  PASS: %s   FAIL: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
