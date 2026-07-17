#!/usr/bin/env bash
# integration-dr-database-restore-e2e.sh
#
# End-to-end add-on-DATABASE recovery from an offsite bundle (gap G4) via the
# `databases-by-id` restore-cart executor.
#
# Flow (self-provisioning probe tenant; the "restore a DB into a LIVE tenant"
# case — the recover-route flow doesn't re-deploy workloads, so the add-on DB
# must be RUNNING for the import):
#   1. Create probe tenant; deploy an add-on MariaDB from the catalog; wait ready.
#   2. Seed a known table with N rows.
#   3. Capture a whole-client bundle (files -> the DB pre-dump lands at
#      exports/predump-<db>-<bundleId>.sql on the PVC + in the snapshot). Assert
#      status == completed.
#   4. Simulate corruption: DELETE the rows (keep the DB running).
#   5. Restore via a restore cart: files-paths (restore the predump file) +
#      databases-by-id (re-import it into the running DB). Assert cart done.
#   6. Assert the N rows are back.
#   7. Teardown: delete the probe tenant.
#
# Registry tier: manual. Needs an offsite BackupStore assigned to the 'tenant'
# shim class. Run against staging (or DEV with a preset TOKEN).
#
# USAGE: source scripts/integration.env first, or set ADMIN_HOST/ADMIN_PASSWORD/
#   SSH_HOST/SSH_KEY/PLATFORM_DOMAIN (TOKEN optional — preset to skip login).
set -uo pipefail
: "${ADMIN_HOST:?}" ; : "${ADMIN_EMAIL:=admin@${PLATFORM_DOMAIN:?}}"
: "${SSH_HOST:?}" "${PLATFORM_DOMAIN:?}"
[[ -n "${TOKEN:-}" ]] || : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD or export a preset TOKEN}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
NODE="$SSH_HOST"
ROWS="${DB_ROWS:-25}"
STAMP=$(date +%s)
pass=0; fail=0
red(){ printf '\033[31m%s\033[0m\n' "$*"; }; grn(){ printf '\033[32m%s\033[0m\n' "$*"; }
cyn(){ printf '\033[36m== %s ==\033[0m\n' "$*"; }
ok(){ grn "  ✓ $*"; pass=$((pass+1)); }; no(){ red "  ✗ $*"; fail=$((fail+1)); }
rd(){ sed -E 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<IP>/g'; }
api(){ local m="$1" p="$2" b="${3:-}" a="${4:-}"; local H=(); [[ -n "$a" ]] && H=(-H "Authorization: Bearer $a")
  if [[ -z "$b" ]]; then curl -sk -w '\n%{http_code}' -X "$m" "$ADMIN_HOST/api/v1$p" "${H[@]}"
  else curl -sk -w '\n%{http_code}' -X "$m" "$ADMIN_HOST/api/v1$p" "${H[@]}" -H 'Content-Type: application/json' -d "$b"; fi; }
parse(){ STATUS=$(printf '%s' "$1"|tail -n1); BODY=$(printf '%s' "$1"|sed '$d'); }
ssh_node(){ ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=12 "$NODE" "$@"; }
# Run SQL in the add-on DB pod (mariadb container, root creds).
db_sql(){ ssh_node "kubectl -n $NS exec '$DB_POD' -c '$DB_CONTAINER' -- sh -c 'exec mariadb -u root -p\"\$MARIADB_ROOT_PASSWORD\" -N -B -e \"$1\"'" </dev/null; }

TENANT_ID=""; NS=""; TOKEN="${TOKEN:-}"
cleanup(){ [[ -n "$TENANT_ID" ]] && { cyn "TEARDOWN: delete probe tenant $TENANT_ID"; api DELETE "/tenants/$TENANT_ID" '' "$TOKEN" >/dev/null 2>&1 || true; }; }
trap cleanup EXIT

cyn "0. login + resolve plan/region/backup-cfg + catalog DB entry"
if [[ -n "$TOKEN" ]]; then ok "using preset TOKEN"; else
  parse "$(api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
  [[ "$STATUS" == 200 ]] || { no "login $STATUS"; echo "$BODY"|rd; exit 1; }
  TOKEN=$(printf '%s' "$BODY"|jq -r '.data.token'); ok "admin login"
fi
parse "$(api GET /admin/backup-configs '' "$TOKEN")"
CFG=$(printf '%s' "$BODY"|jq -r '.data[]|select(.active==true or .isActive==true)|.id'|head -1)
# An add-on DB needs real quota — the Starter plan (0.25 CPU / 0.25Gi) is too
# small for MariaDB + file-manager. Default to a mid plan; fall back to the
# largest-memory plan available.
PLAN_ID=$(api GET /plans '' "$TOKEN"|sed '$d'|jq -r --arg n "${DB_PLAN:-Premium}" '.data[]|select(.name==$n).id'|head -1)
[[ -n "$PLAN_ID" ]] || PLAN_ID=$(api GET /plans '' "$TOKEN"|sed '$d'|jq -r '.data|sort_by(.memory_limit // .memoryLimit // 0)|last|.id')
REGION_ID=$(api GET /regions '' "$TOKEN"|sed '$d'|jq -r '.data[0].id')
# a MariaDB catalog entry (fall back to any database engine)
parse "$(api GET '/catalog?type=database&limit=200' '' "$TOKEN")"
ENTRY=$(printf '%s' "$BODY"|jq -r '.data[]|select(.code=="mariadb" or .runtime=="mariadb")|.id'|head -1)
[[ -n "$ENTRY" ]] || ENTRY=$(printf '%s' "$BODY"|jq -r '.data[]|select(.runtime=="mysql" or .runtime=="mariadb")|.id'|head -1)
[[ -n "$CFG" && -n "$PLAN_ID" && -n "$REGION_ID" && -n "$ENTRY" ]] || { no "missing cfg/plan/region/db-catalog-entry"; exit 1; }
ok "cfg=$CFG db-catalog-entry=$ENTRY"

cyn "1. create probe tenant + provision"
parse "$(api POST /tenants "{\"name\":\"DR DB $STAMP\",\"primary_email\":\"drdb-$STAMP@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"storage_tier\":\"local\"}" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "tenant create $STATUS"; echo "$BODY"|rd; exit 1; }
TENANT_ID=$(printf '%s' "$BODY"|jq -r '.data.id')
api POST "/admin/tenants/$TENANT_ID/provision" '{}' "$TOKEN" >/dev/null 2>&1 || true
st=""; for i in $(seq 1 80); do st=$(api GET "/tenants/$TENANT_ID" '' "$TOKEN"|sed '$d'|jq -r '.data.status'); [[ "$st" == active ]] && break; sleep 3; done
[[ "$st" == active ]] || { no "tenant not active ($st)"; exit 1; }
NS=$(api GET "/tenants/$TENANT_ID" '' "$TOKEN"|sed '$d'|jq -r '.data.kubernetesNamespace')
ok "tenant=$TENANT_ID ns=$NS active"

cyn "2. deploy add-on MariaDB + wait ready"
parse "$(api POST "/tenants/$TENANT_ID/deployments" "{\"catalog_entry_id\":\"$ENTRY\",\"name\":\"drmaria\",\"cpu_request\":\"0.5\",\"memory_request\":\"512Mi\"}" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "deployment create $STATUS"; echo "$BODY"|rd; exit 1; }
DEP_ID=$(printf '%s' "$BODY"|jq -r '.data.id'); DEP_NAME=$(printf '%s' "$BODY"|jq -r '.data.name // "drmaria"')
ok "deployment=$DEP_ID name=$DEP_NAME"
dst=""; for i in $(seq 1 80); do dst=$(api GET "/tenants/$TENANT_ID/deployments/$DEP_ID" '' "$TOKEN"|sed '$d'|jq -r '.data.status'); [[ "$dst" == running ]] && break; sleep 4; done
[[ "$dst" == running ]] || { no "deployment not running ($dst)"; ssh_node "kubectl -n $NS get pods" </dev/null|rd; exit 1; }
DB_POD=""; for i in $(seq 1 30); do DB_POD=$(ssh_node "kubectl -n $NS get pod -l app=$DEP_NAME --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" </dev/null 2>/dev/null||true); [[ -n "$DB_POD" ]] && break; sleep 4; done
[[ -n "$DB_POD" ]] || { no "no running DB pod"; exit 1; }
DB_CONTAINER=$(ssh_node "kubectl -n $NS get pod $DB_POD -o jsonpath='{.spec.containers[0].name}'" </dev/null 2>/dev/null)
# wait for the server to accept connections (data-dir init on first start)
RDY=""; for i in $(seq 1 30); do db_sql "SELECT 1" >/dev/null 2>&1 && { RDY=1; break; }; sleep 5; done
[[ -n "$RDY" ]] || { no "DB never accepted connections"; exit 1; }; ok "DB pod=$DB_POD container=$DB_CONTAINER ready"

cyn "3. seed a known table ($ROWS rows)"
db_sql "CREATE DATABASE IF NOT EXISTS drdata; CREATE TABLE IF NOT EXISTS drdata.t (id INT PRIMARY KEY); DELETE FROM drdata.t;" >/dev/null
db_sql "$(for i in $(seq 1 "$ROWS"); do printf 'INSERT INTO drdata.t VALUES (%d);' "$i"; done)" >/dev/null
SEEDED=$(db_sql "SELECT COUNT(*) FROM drdata.t" 2>/dev/null | tr -d '[:space:]')
[[ "$SEEDED" == "$ROWS" ]] || { no "seed mismatch: $SEEDED != $ROWS"; exit 1; }; ok "seeded drdata.t = $SEEDED rows"

cyn "4. capture whole-client bundle (files -> DB pre-dump) offsite"
parse "$(api POST /admin/tenant-bundles "{\"tenantId\":\"$TENANT_ID\",\"targetConfigId\":\"$CFG\",\"async\":true,\"components\":{\"files\":true,\"mailboxes\":false,\"config\":false,\"secrets\":false}}" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "bundle create $STATUS"; echo "$BODY"|rd; exit 1; }
BID=$(printf '%s' "$BODY"|jq -r '.data.bundleId // .data.id')
BST=timeout; for i in $(seq 1 150); do
  parse "$(api GET "/admin/tenant-bundles/$BID" '' "$TOKEN")"; s=$(printf '%s' "$BODY"|jq -r '.data.status // empty')
  [[ "$s" == completed || "$s" == partial || "$s" == failed ]] && { BST="$s"; break; }; sleep 4
done
[[ "$BST" == completed ]] || { no "bundle terminal=$BST"; printf '%s' "$BODY"|jq -r '.data.components[]?|"    \(.component) \(.status) \(.lastError//"")"'|rd; exit 1; }
ok "bundle $BID completed"
# confirm the predump landed in the flat exports/ dir on the PVC
FMPOD=$(ssh_node "kubectl -n $NS get pod -l app=file-manager --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" </dev/null 2>/dev/null||true)
DUMP="predump-drdata-$BID.sql"
# The predump lands in the DB pod's OWN storage subPath (exportDatabaseToPvc's
# move to exports/ is a silent no-op for DBs), so find it wherever it is.
# The predump lands in the DB pod's OWN storage subPath (database/<engine>/
# <name>/), NOT the file-manager tenant PVC — so search the DB pod first (that's
# where the restore executor finds it), then the FM PVC as a fallback.
_pd_found=""
if ssh_node "kubectl -n $NS exec $DB_POD -c $DB_CONTAINER -- sh -c 'find / -type f -name \"$DUMP\" 2>/dev/null | head -1'" </dev/null 2>/dev/null | grep -qF "$DUMP"; then _pd_found=1; fi
if [[ -z "$_pd_found" && -n "$FMPOD" ]] && ssh_node "kubectl -n $NS exec $FMPOD -c file-manager -- find /data -type f -name '$DUMP'" </dev/null 2>/dev/null | grep -qF "$DUMP"; then _pd_found=1; fi
[[ -n "$_pd_found" ]] && ok "predump present on PVC ($DUMP)" || no "predump $DUMP NOT found on PVC (DB pod + FM PVC)"

cyn "5. SIMULATE CORRUPTION: delete the rows (DB stays running)"
db_sql "DELETE FROM drdata.t" >/dev/null
[[ "$(db_sql "SELECT COUNT(*) FROM drdata.t"|tr -d '[:space:]')" == 0 ]] && ok "rows deleted (count=0)" || { no "delete failed"; exit 1; }

cyn "6. RESTORE via restore cart: databases-by-id"
parse "$(api POST /admin/restores/carts "{\"tenantId\":\"$TENANT_ID\",\"description\":\"dr-db\"}" "$TOKEN")"
CID=$(printf '%s' "$BODY"|jq -r '.data.id // empty'); [[ -n "$CID" ]] || { no "cart create $STATUS"; echo "$BODY"|rd; exit 1; }
# The predump persists on the live PVC in the DB's data dir, so databases-by-id
# finds + imports it in place — no files-paths (which would overwrite live DB files).
parse "$(api POST "/admin/restores/carts/$CID/items" "{\"bundleId\":\"$BID\",\"type\":\"databases-by-id\",\"selector\":{\"kind\":\"ids\",\"deploymentIds\":[\"$DEP_ID\"]}}" "$TOKEN")"
[[ "$STATUS" == 201 ]] || { no "add databases-by-id item $STATUS"; echo "$BODY"|rd; exit 1; }
parse "$(api POST "/admin/restores/carts/$CID/execute" '{}' "$TOKEN")"
[[ "$STATUS" == 200 ]] || { no "execute $STATUS"; echo "$BODY"|rd; exit 1; }
CST=timeout; for i in $(seq 1 120); do
  parse "$(api GET "/admin/restores/carts/$CID" '' "$TOKEN")"; s=$(printf '%s' "$BODY"|jq -r '.data.status // empty')
  [[ "$s" == done || "$s" == failed ]] && { CST="$s"; break; }; sleep 3
done
[[ "$CST" == done ]] || { no "cart terminal=$CST"; printf '%s' "$BODY"|jq -r '.data.items[]?|"    \(.type) \(.status) \(.progressMessage//.lastError//"")"'|rd; exit 1; }
ok "restore cart done"
printf '%s' "$BODY"|jq -r '.data.items[]?|select(.type=="databases-by-id")|"    databases-by-id: \(.progressMessage//"")"'|rd

cyn "7. ASSERT rows restored"
sleep 3; GOT=$(db_sql "SELECT COUNT(*) FROM drdata.t" 2>/dev/null|tr -d '[:space:]')
[[ "$GOT" == "$ROWS" ]] && ok "DB: drdata.t restored to $GOT rows (== $ROWS)" || no "DB: drdata.t = ${GOT:-?}, expected $ROWS"

cyn "RESULT: PASS=$pass FAIL=$fail"
[[ "$fail" == 0 ]] && { grn "DATABASE DR RESTORE: GREEN"; exit 0; } || { red "DATABASE DR RESTORE: $fail failure(s)"; exit 1; }
