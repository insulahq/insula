#!/usr/bin/env bash
# integration-dr-recover-all-e2e.sh
#
# Batch DR recover-all (S3): after a cluster rebuild, restore MANY lost tenants
# from their off-site bundles in ONE operation via
# `POST /api/v1/admin/dr/tenants/recover-all`.
#
# Flow (2 self-provisioning probe tenants; non-destructive to real tenants):
#   1. Create 2 probe tenants; seed each with a KNOWN website file (SHA recorded).
#   2. Capture a whole-client bundle (files+config) per tenant; assert completed.
#   3. SIMULATE LOSS: delete BOTH tenant namespaces (row survives → "lost").
#   4. recover-all DRY-RUN (scope=missing, auto-select) → assert BOTH probe
#      tenants appear in targets with namespacePresent=false.
#   5. recover-all REAL, scoped to the 2 probe tenantIds (so it never touches
#      other lost tenants on the cluster) → assert recovered==2, failed==0.
#   6. Assert USER-VISIBLE recovery: both namespaces are back + each site file's
#      SHA256 matches the original.
#
# Registry tier: manual. Needs an offsite BackupStore assigned to the 'tenant'
# shim class. Accepts a preset TOKEN (bypass /auth/login). DESTRUCTIVE to its
# own 2 probe tenants only.
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
# NOTE: these helpers declare `local i` so their internal seq-loops never clobber
# a CALLER's `i` — otherwise `wait_ns "${NSS[$i]}" && ok "…${NSS[$i]}…"` reads a
# stale seq value in the second `${NSS[$i]}` and trips `set -u` (unbound array elem).
wait_ns_gone(){ local ns="$1" i; for i in $(seq 1 50); do kx "get ns $ns" >/dev/null 2>&1 || return 0; sleep 3; done; return 1; }
wait_ns(){ local ns="$1" i; for i in $(seq 1 60); do kx "get ns $ns" >/dev/null 2>&1 && return 0; sleep 3; done; return 1; }
ensure_fm(){ local tid="$1" ns="$2" i; api POST "/tenants/$tid/files/start" '{}' "$TOKEN" >/dev/null 2>&1 || true
  for i in $(seq 1 30); do kx "-n $ns get deploy file-manager" >/dev/null 2>&1 && break; api POST "/tenants/$tid/files/start" '{}' "$TOKEN" >/dev/null 2>&1 || true; sleep 4; done
  kx "-n $ns rollout status deploy/file-manager --timeout=200s" >/dev/null 2>&1 || return 1
  local pod=""; for i in $(seq 1 20); do pod=$(kx "-n $ns get pod -l app=file-manager --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null||true); [[ -n "$pod" ]] && break; sleep 3; done
  [[ -n "$pod" ]] && printf '%s' "$pod"; }
fm_write(){ local ns="$1" pod="$2" content="$3"; kx "-n $ns exec '$pod' -c file-manager -- sh -c 'mkdir -p /data/site && printf %s \"$content\" > /data/site/index.html'" >/dev/null 2>&1; }
fm_sha(){ local ns="$1" pod="$2"; kx "-n $ns exec '$pod' -c file-manager -- sh -c 'sha256sum /data/site/index.html'" 2>/dev/null | awk '{print $1}'; }

declare -a TIDS NSS SHAS BIDS
cleanup(){ for t in "${TIDS[@]:-}"; do [[ -n "$t" ]] && api DELETE "/tenants/$t" '' "$TOKEN" >/dev/null 2>&1 || true; done; }
trap cleanup EXIT

cyn "0. login + resolve plan/region/backup-cfg"
if [[ -n "${TOKEN:-}" ]]; then ok "using preset TOKEN"; else
  parse "$(api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
  [[ "$STATUS" == 200 ]] || { no "login $STATUS"; echo "$BODY"|rd; exit 1; }
  TOKEN=$(printf '%s' "$BODY"|jq -r '.data.token'); ok "admin login"
fi
parse "$(api GET /admin/backup-configs '' "$TOKEN")"
CFG=$(printf '%s' "$BODY"|jq -r '.data[]|select(.active==true or .isActive==true)|.id'|head -1)
if [[ -z "$CFG" || "$CFG" == null ]]; then echo "  SKIP (77): no active offsite BackupStore for the 'tenant' class" >&2; exit 77; fi
ok "offsite backup target=$CFG"
parse "$(api GET /plans '' "$TOKEN")"; PLAN=$(printf '%s' "$BODY"|jq -r '.data[]|select(.name=="Premium" or .name=="Business").id'|head -1); [[ -n "$PLAN" && "$PLAN" != null ]] || PLAN=$(printf '%s' "$BODY"|jq -r '.data[-1].id')
parse "$(api GET '/regions?limit=1' '' "$TOKEN")"; REGION=$(printf '%s' "$BODY"|jq -r '.data[0].id')

# ── 1-3. Two probe tenants: create → provision → seed file → capture bundle ──
for n in 1 2; do
  cyn "$n. probe tenant #$n: create → provision → seed file → capture bundle"
  parse "$(api POST /tenants "{\"name\":\"recall-$n-$STAMP\",\"primary_email\":\"recall-$n-$STAMP@example.test\",\"plan_id\":\"$PLAN\",\"region_id\":\"$REGION\"}" "$TOKEN")"
  TID=$(printf '%s' "$BODY"|jq -r '.data.id'); [[ -n "$TID" && "$TID" != null ]] || { no "tenant create $STATUS"; echo "$BODY"|rd; exit 1; }
  api POST "/admin/tenants/$TID/provision" '{}' "$TOKEN" >/dev/null 2>&1 || true
  for i in $(seq 1 80); do [[ "$(api GET "/tenants/$TID" '' "$TOKEN"|sed '$d'|jq -r '.data.status')" == active ]] && break; sleep 3; done
  NS=$(api GET "/tenants/$TID" '' "$TOKEN"|sed '$d'|jq -r '.data.kubernetesNamespace')
  POD=$(ensure_fm "$TID" "$NS") || { no "file-manager never ready for $NS"; exit 1; }
  fm_write "$NS" "$POD" "recover-all-probe-$n-$STAMP-payload"
  SHA=$(fm_sha "$NS" "$POD"); [[ -n "$SHA" ]] && ok "tenant=$TID ns=$NS site sha=$SHA" || { no "could not seed/sha site file"; exit 1; }
  parse "$(api POST /admin/tenant-bundles "{\"tenantId\":\"$TID\",\"targetConfigId\":\"$CFG\",\"async\":true,\"components\":{\"files\":true,\"mailboxes\":false,\"config\":true,\"secrets\":false}}" "$TOKEN")"
  BID=$(printf '%s' "$BODY"|jq -r '.data.bundleId // .data.id'); BST=timeout
  for i in $(seq 1 150); do parse "$(api GET "/admin/tenant-bundles/$BID" '' "$TOKEN")"; s=$(printf '%s' "$BODY"|jq -r '.data.status // empty'); [[ "$s" == completed || "$s" == partial || "$s" == failed ]] && { BST="$s"; break; }; sleep 4; done
  [[ "$BST" == completed ]] && ok "bundle $BID completed" || { no "bundle terminal=$BST"; exit 1; }
  TIDS+=("$TID"); NSS+=("$NS"); SHAS+=("$SHA"); BIDS+=("$BID")
done

# ── 4. Simulate loss: delete BOTH namespaces ──────────────────────────────────
cyn "4. SIMULATE LOSS — delete both tenant namespaces"
for i in 0 1; do kx "delete ns ${NSS[$i]} --wait=false" >/dev/null 2>&1 || true; done
for i in 0 1; do wait_ns_gone "${NSS[$i]}" && ok "namespace ${NSS[$i]} gone" || { no "namespace ${NSS[$i]} still terminating"; exit 1; }; done

# ── 5. recover-all DRY-RUN (auto-select) → both probe tenants must be targets ──
cyn "5. recover-all DRY-RUN (scope=missing, auto-select) — assert both probe tenants are targets"
parse "$(api POST /admin/dr/tenants/recover-all '{"dryRun":true,"scope":"missing"}' "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "recover-all dry-run $STATUS"; echo "$BODY"|rd; exit 1; }
for i in 0 1; do
  printf '%s' "$BODY"|jq -e --arg t "${TIDS[$i]}" '.data.targets[]|select(.tenantId==$t and .namespacePresent==false)' >/dev/null \
    && ok "dry-run selected ${TIDS[$i]} (namespace absent)" || no "dry-run did NOT select ${TIDS[$i]}"
done

# ── 6. recover-all REAL, scoped to the 2 probe tenantIds ──────────────────────
cyn "6. recover-all REAL (explicit tenantIds — never touches other lost tenants)"
RBODY="{\"scope\":\"missing\",\"tenantIds\":[\"${TIDS[0]}\",\"${TIDS[1]}\"]}"
parse "$(api POST /admin/dr/tenants/recover-all "$RBODY" "$TOKEN")"
[[ "$STATUS" =~ ^20 ]] || { no "recover-all $STATUS"; echo "$BODY"|rd; exit 1; }
RECN=$(printf '%s' "$BODY"|jq -r '.data.recovered'); FAILN=$(printf '%s' "$BODY"|jq -r '.data.failed'); TOTN=$(printf '%s' "$BODY"|jq -r '.data.total')
[[ "$TOTN" == 2 ]] && ok "recover-all targeted 2 tenants" || no "recover-all total=$TOTN (expected 2)"
[[ "$RECN" == 2 && "$FAILN" == 0 ]] && ok "recover-all recovered=2 failed=0" || { no "recover-all recovered=$RECN failed=$FAILN"; printf '%s' "$BODY"|jq -r '.data.results[]?|"    \(.tenantId) ok=\(.ok) status=\(.status) recreated=\(.recreated) err=\(.error//"-")"'|rd; }

# ── 7. Assert user-visible recovery: namespaces back + file SHAs match ────────
cyn "7. ASSERT recovery — both namespaces back + site files restored (SHA match)"
for i in 0 1; do
  wait_ns "${NSS[$i]}" && ok "namespace ${NSS[$i]} re-provisioned" || { no "namespace ${NSS[$i]} not back"; continue; }
  POD=$(ensure_fm "${TIDS[$i]}" "${NSS[$i]}") || { no "file-manager not ready for ${NSS[$i]} after recover"; continue; }
  NOW=$(fm_sha "${NSS[$i]}" "$POD")
  [[ "$NOW" == "${SHAS[$i]}" ]] && ok "tenant #$((i+1)) site file restored (sha matches ${SHAS[$i]})" || no "tenant #$((i+1)) site file SHA mismatch (got ${NOW:-none}, want ${SHAS[$i]})"
done

cyn "RESULT: PASS=$pass FAIL=$fail"
[[ "$fail" == 0 ]] && { grn "DR RECOVER-ALL E2E: GREEN"; exit 0; } || { red "DR RECOVER-ALL E2E: $fail failure(s)"; exit 1; }
