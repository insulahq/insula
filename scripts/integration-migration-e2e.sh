#!/usr/bin/env bash
# integration-migration-e2e.sh — R20 cross-cluster tenant migration.
#
# Proves cluster B can IMPORT a tenant from a mounted (read-only) source backup
# target with NO local tenant row and NO prep on the source, via the migration
# endpoints (list-tenants → import). The "different cluster" is simulated by
# capturing a bundle, then DELETING the tenant locally so the import must
# re-create it purely from the off-site bundle's meta.json.
#
# Flow:
#   1. Create a probe tenant; seed a KNOWN site file (SHA recorded).
#   2. Capture a whole-client bundle (files+config) to the off-site target.
#   3. DELETE the tenant fully (row + namespace) → "lives on cluster A now".
#   4. POST /admin/migration/list-tenants {targetConfigId} → assert the probe
#      tenant appears (alreadyPresent=false, right bundle).
#   5. POST /admin/migration/import {targetConfigId, scope:selected, tenantIds}
#      → assert imported=1.
#   6. Assert USER-VISIBLE: namespace back + site file SHA matches the original.
#
# Registry tier: manual. Needs an off-site BackupStore assigned to 'tenant'.
set -uo pipefail
: "${ADMIN_HOST:?set ADMIN_HOST or source scripts/integration.env}"
: "${ADMIN_EMAIL:=admin@${PLATFORM_DOMAIN:?}}"
: "${SSH_HOST:?}" "${PLATFORM_DOMAIN:?}"
[[ -n "${TOKEN:-}" ]] || : "${ADMIN_PASSWORD:?set ADMIN_PASSWORD, or export a preset TOKEN}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
NODE="$SSH_HOST"; STAMP=$(date +%s)
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
kx(){ ssh_node "kubectl $*" </dev/null; }
wait_ns_gone(){ local ns="$1" i; for i in $(seq 1 50); do kx "get ns $ns" >/dev/null 2>&1 || return 0; sleep 3; done; return 1; }
wait_ns(){ local ns="$1" i; for i in $(seq 1 60); do kx "get ns $ns" >/dev/null 2>&1 && return 0; sleep 3; done; return 1; }
ensure_fm(){ local tid="$1" ns="$2" i; api POST "/tenants/$tid/files/start" '{}' "$TOKEN" >/dev/null 2>&1 || true
  for i in $(seq 1 30); do kx "-n $ns get deploy file-manager" >/dev/null 2>&1 && break; api POST "/tenants/$tid/files/start" '{}' "$TOKEN" >/dev/null 2>&1 || true; sleep 4; done
  kx "-n $ns rollout status deploy/file-manager --timeout=200s" >/dev/null 2>&1 || return 1
  local pod=""; for i in $(seq 1 20); do pod=$(kx "-n $ns get pod -l app=file-manager --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null||true); [[ -n "$pod" ]] && break; sleep 3; done
  [[ -n "$pod" ]] && printf '%s' "$pod"; }
fm_write(){ local ns="$1" pod="$2" content="$3"; kx "-n $ns exec '$pod' -c file-manager -- sh -c 'mkdir -p /data/site && printf %s \"$content\" > /data/site/index.html'" >/dev/null 2>&1; }
fm_sha(){ local ns="$1" pod="$2"; kx "-n $ns exec '$pod' -c file-manager -- sh -c 'sha256sum /data/site/index.html'" 2>/dev/null | awk '{print $1}'; }

TID=""; NS=""
cleanup(){ [[ -n "$TID" ]] && api DELETE "/tenants/$TID" '' "$TOKEN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cyn "0. login + resolve plan/region/backup target"
if [[ -n "${TOKEN:-}" ]]; then ok "using preset TOKEN"; else
  parse "$(api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
  [[ "$STATUS" == 200 ]] || { no "login $STATUS"; echo "$BODY"|rd; exit 1; }
  TOKEN=$(printf '%s' "$BODY"|jq -r '.data.token'); ok "admin login"
fi
parse "$(api GET /admin/backup-configs '' "$TOKEN")"
CFG=$(printf '%s' "$BODY"|jq -r '.data[]|select(.active==true or .isActive==true)|.id'|head -1)
[[ -n "$CFG" && "$CFG" != null ]] || { echo "  SKIP (77): no active off-site BackupStore" >&2; exit 77; }
ok "off-site target (migration source) = $CFG"
parse "$(api GET /plans '' "$TOKEN")"; PLAN=$(printf '%s' "$BODY"|jq -r '.data[]|select(.name=="Premium" or .name=="Business").id'|head -1); [[ -n "$PLAN" && "$PLAN" != null ]] || PLAN=$(printf '%s' "$BODY"|jq -r '.data[-1].id')
parse "$(api GET '/regions?limit=1' '' "$TOKEN")"; REGION=$(printf '%s' "$BODY"|jq -r '.data[0].id')

cyn "1. create probe tenant + provision + seed site file"
parse "$(api POST /tenants "{\"name\":\"migr-$STAMP\",\"primary_email\":\"migr-$STAMP@example.test\",\"plan_id\":\"$PLAN\",\"region_id\":\"$REGION\"}" "$TOKEN")"
TID=$(printf '%s' "$BODY"|jq -r '.data.id'); [[ -n "$TID" && "$TID" != null ]] || { no "tenant create $STATUS"; echo "$BODY"|rd; exit 1; }
api POST "/admin/tenants/$TID/provision" '{}' "$TOKEN" >/dev/null 2>&1 || true
for i in $(seq 1 80); do [[ "$(api GET "/tenants/$TID" '' "$TOKEN"|sed '$d'|jq -r '.data.status')" == active ]] && break; sleep 3; done
NS=$(api GET "/tenants/$TID" '' "$TOKEN"|sed '$d'|jq -r '.data.kubernetesNamespace')
POD=$(ensure_fm "$TID" "$NS") || { no "file-manager never ready for $NS"; exit 1; }
fm_write "$NS" "$POD" "migration-probe-$STAMP-payload"
SHA=$(fm_sha "$NS" "$POD"); [[ -n "$SHA" ]] && ok "tenant=$TID ns=$NS site sha=$SHA" || { no "could not seed/sha site file"; exit 1; }

cyn "2. capture whole-client bundle to the off-site target"
parse "$(api POST /admin/tenant-bundles "{\"tenantId\":\"$TID\",\"targetConfigId\":\"$CFG\",\"async\":true,\"components\":{\"files\":true,\"mailboxes\":false,\"config\":true,\"secrets\":false}}" "$TOKEN")"
BID=$(printf '%s' "$BODY"|jq -r '.data.bundleId // .data.id'); BST=timeout
for i in $(seq 1 150); do parse "$(api GET "/admin/tenant-bundles/$BID" '' "$TOKEN")"; s=$(printf '%s' "$BODY"|jq -r '.data.status // empty'); [[ "$s" == completed || "$s" == partial || "$s" == failed ]] && { BST="$s"; break; }; sleep 4; done
[[ "$BST" == completed ]] || { no "bundle terminal=$BST"; exit 1; }
ok "bundle $BID completed on the target"

cyn "3. SIMULATE cluster-A-only: delete the tenant fully (row + namespace)"
parse "$(api DELETE "/tenants/$TID" '' "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "tenant delete $STATUS"; echo "$BODY"|rd; exit 1; }
wait_ns_gone "$NS" && ok "tenant + namespace $NS gone (now exists only as an off-site bundle)" || { no "namespace $NS still terminating"; exit 1; }

cyn "4. migration list-tenants — scan the mounted source target"
parse "$(api POST /admin/migration/list-tenants "{\"targetConfigId\":\"$CFG\"}" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "list-tenants $STATUS"; echo "$BODY"|rd; exit 1; }
printf '%s' "$BODY"|jq -e --arg t "$TID" '.data.tenants[]|select(.tenantId==$t and .alreadyPresent==false)' >/dev/null \
  && ok "list-tenants found the deleted tenant $TID (alreadyPresent=false)" || { no "list-tenants did NOT surface $TID"; printf '%s' "$BODY"|jq -r '.data.tenants[]?|"    \(.tenantId) \(.tenantName) present=\(.alreadyPresent)"'|rd; exit 1; }
LATEST=$(printf '%s' "$BODY"|jq -r --arg t "$TID" '.data.tenants[]|select(.tenantId==$t)|.latestBundleId')
[[ "$LATEST" == "$BID" ]] && ok "list-tenants resolved the newest bundle ($BID)" || no "list-tenants latestBundleId=$LATEST (expected $BID)"

cyn "5. migration import — rebuild the tenant from the source (no local row)"
parse "$(api POST /admin/migration/import "{\"targetConfigId\":\"$CFG\",\"scope\":\"selected\",\"tenantIds\":[\"$TID\"]}" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "import $STATUS"; echo "$BODY"|rd; exit 1; }
IMP=$(printf '%s' "$BODY"|jq -r '.data.imported'); FL=$(printf '%s' "$BODY"|jq -r '.data.failed')
[[ "$IMP" == 1 && "$FL" == 0 ]] && ok "import imported=1 failed=0" || { no "import imported=$IMP failed=$FL"; printf '%s' "$BODY"|jq -r '.data.results[]?|"    \(.tenantId) ok=\(.ok) status=\(.status) recreated=\(.recreated) err=\(.error//"-")"'|rd; exit 1; }
printf '%s' "$BODY"|jq -e --arg t "$TID" '.data.results[]|select(.tenantId==$t and .recreated==true)' >/dev/null \
  && ok "import re-created the tenant from the off-site bundle" || no "import did not report recreated=true for $TID"

cyn "6. ASSERT user-visible recovery — namespace back + site file restored"
wait_ns "$NS" && ok "namespace $NS re-provisioned" || { no "namespace $NS not back"; exit 1; }
POD=$(ensure_fm "$TID" "$NS") || { no "file-manager not ready after import"; exit 1; }
NOW=$(fm_sha "$NS" "$POD")
[[ "$NOW" == "$SHA" ]] && ok "site file restored (sha matches $SHA)" || no "site file SHA mismatch (got ${NOW:-none}, want $SHA)"

cyn "RESULT: PASS=$pass FAIL=$fail"
[[ "$fail" == 0 ]] && { grn "MIGRATION E2E: GREEN"; exit 0; } || { red "MIGRATION E2E: $fail failure(s)"; exit 1; }
