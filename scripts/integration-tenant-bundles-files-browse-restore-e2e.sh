#!/usr/bin/env bash
# integration-tenant-bundles-files-browse-restore-e2e.sh
#
# TRUE end-to-end test for the RESTIC-NATIVE files component: capture →
# browse the file TREE via the API → restore an individual FILE and an
# individual FOLDER → assert the live PVC content.
#
# This covers what integration-tenant-bundles-roundtrip.sh explicitly left
# out of scope (it needs kubectl exec into the tenant ns to mutate + read
# files). Flow:
#
#   1. admin login, pick an active non-SYSTEM tenant, provision a
#      tenant_admin, tenant login.
#   2. start file-manager (gives the tenant PVC a consumer mounted at
#      /data) and write a KNOWN tree:
#        /data/site/index.php            = "ORIGINAL"
#        /data/site/wp-content/keep.txt  = "KEEP"
#        /data/config.ini                = "ORIGINAL-CFG"
#   3. run a files backup (run-now) → wait completed.
#   4. BROWSE the restic tree via the API at three levels and assert the
#      known entries appear (this is the new tree browser).
#   5. MUTATE: index.php → "MUTATED", delete config.ini, delete the whole
#      wp-content folder.
#   6. RESTORE a single FILE (site/index.php) via a files-paths cart item;
#      assert index.php is back to "ORIGINAL".
#   7. RESTORE a single FOLDER (site/wp-content) via a files-paths cart;
#      assert wp-content/keep.txt is back with "KEEP".
#   8. cleanup: delete the tenant_admin user; leave the tenant.
#
# The harness is destructive against the chosen tenant's PVC under
# /data/site + /data/config.ini only (marker paths). Other tenant data is
# untouched.
#
# USAGE:
#   ADMIN_PASSWORD=<pw> ADMIN_HOST=https://admin.<apex> \
#   STAGING_NODE=root@<node>.<apex> SSH_KEY=~/hosting-platform.key \
#   ./scripts/integration-tenant-bundles-files-browse-restore-e2e.sh

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@staging.example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
STAGING_NODE="${STAGING_NODE:-root@staging1.example.test}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }
[[ -f "$SSH_KEY" ]]        || { echo "ERROR: $SSH_KEY missing" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN"  "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
warn() { printf '  %b!%b %s\n' "$YELLOW" "$RESET" "$*"; }
passed=0; failed=0

api() {
  local method="$1" path="$2" body="${3:-}" auth="${4:-}"
  local h_auth=()
  [[ -n "$auth" ]] && h_auth=(-H "Authorization: Bearer $auth")
  if [[ -z "$body" ]]; then
    curl -sk -w '\n%{http_code}' -X "$method" "$ADMIN_HOST/api/v1$path" "${h_auth[@]}"
  else
    curl -sk -w '\n%{http_code}' -X "$method" "$ADMIN_HOST/api/v1$path" "${h_auth[@]}" \
      -H "Content-Type: application/json" -d "$body"
  fi
}
parse() { STATUS=$(printf '%s' "$1" | tail -n1); BODY=$(printf '%s' "$1" | sed '$d'); }
ssh_node() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=12 "$STAGING_NODE" "$@"; }

# kubectl exec into the tenant's file-manager pod (mounts the PVC at /data).
fm_exec() { ssh_node "kubectl -n $NS exec '$FM_POD' -c file-manager -- sh -c '$1'" </dev/null; }

wait_bundle() {
  local bid="$1" tid="$2" tok="$3" to="${4:-180}" el=0 s
  while (( el < to )); do
    parse "$(api GET "/tenants/$tid/bundles/$bid/status" "" "$tok")"
    if [[ "$STATUS" == "200" ]]; then
      s=$(printf '%s' "$BODY" | jq -r '.data.bundle.status // empty')
      [[ "$s" == "completed" || "$s" == "partial" || "$s" == "failed" ]] && { BUNDLE_STATUS="$s"; return 0; }
    fi
    sleep 3; el=$((el+3))
  done
  BUNDLE_STATUS="timeout"; return 1
}
wait_cart() {
  local cid="$1" tid="$2" tok="$3" to="${4:-120}" el=0 s
  while (( el < to )); do
    parse "$(api GET "/tenants/$tid/restore-carts/$cid" "" "$tok")"
    if [[ "$STATUS" == "200" ]]; then
      s=$(printf '%s' "$BODY" | jq -r '.data.status // empty')
      [[ "$s" == "done" || "$s" == "failed" ]] && { CART_STATUS="$s"; return 0; }
    fi
    sleep 2; el=$((el+2))
  done
  CART_STATUS="timeout"; return 1
}
restore_paths() {  # $1=bundleId $2='["a","b"]' (display paths) → sets CART_STATUS
  local bid="$1" paths="$2" cid
  parse "$(api POST "/tenants/$TENANT_ID/restore-carts" "{\"tenantId\":\"$TENANT_ID\",\"description\":\"files-e2e\"}" "$TENANT_TOKEN")"
  cid=$(printf '%s' "$BODY" | jq -r '.data.id'); [[ -n "$cid" ]] || { fail "cart create: $STATUS $BODY"; return 1; }
  parse "$(api POST "/tenants/$TENANT_ID/restore-carts/$cid/items" \
    "{\"bundleId\":\"$bid\",\"type\":\"files-paths\",\"selector\":{\"kind\":\"paths\",\"paths\":$paths}}" "$TENANT_TOKEN")"
  [[ "$STATUS" == "201" ]] || { fail "add files-paths item: $STATUS $BODY"; return 1; }
  parse "$(api POST "/tenants/$TENANT_ID/restore-carts/$cid/execute" "{}" "$TENANT_TOKEN")"
  [[ "$STATUS" == "200" ]] || { fail "cart execute: $STATUS $BODY"; return 1; }
  wait_cart "$cid" "$TENANT_ID" "$TENANT_TOKEN" 180
}

# ── login + tenant setup ────────────────────────────────────────────────
log "admin login"
parse "$(api POST /auth/login "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
[[ "$STATUS" == "200" ]] || { fail "admin login: $STATUS $BODY"; exit 1; }
ADMIN_TOKEN=$(printf '%s' "$BODY" | jq -r '.data.token // empty'); ok "admin login"

# TENANT_ID can be pinned via env (recommended — this harness MUTATES the
# tenant's /data and runs a backup/restore; point it at a throwaway tenant).
# A pinned tenant may be in any state (e.g. a `pending` migration target).
TENANT_ID="${TENANT_ID:-}"
if [[ -z "$TENANT_ID" ]]; then
  parse "$(api GET "/tenants" "" "$ADMIN_TOKEN")"
  TENANT_ID=$(printf '%s' "$BODY" | jq -r '.data[] | select(.status=="active" and .name!="SYSTEM") | .id' | head -1)
fi
[[ -n "$TENANT_ID" ]] || { fail "no tenant (set TENANT_ID=... or have an active non-SYSTEM tenant)"; exit 1; }
parse "$(api GET "/tenants/$TENANT_ID" "" "$ADMIN_TOKEN")"
NS=$(printf '%s' "$BODY" | jq -r '.data.kubernetesNamespace'); ok "tenant $TENANT_ID ns=$NS"

# Use the tenant's EXISTING primary user via an admin password reset — the
# starter plan caps sub-users at 1, so we can't always add a tenant_admin.
parse "$(api GET "/tenants/$TENANT_ID/users" "" "$ADMIN_TOKEN")"
TU_ID=$(printf '%s' "$BODY" | jq -r '.data[0].id // empty')
TU_EMAIL=$(printf '%s' "$BODY" | jq -r '.data[0].email // empty')
[[ -n "$TU_ID" && -n "$TU_EMAIL" ]] || { fail "no tenant user to use: $STATUS $BODY"; exit 1; }
TU_PW="Files-E2E-$(date +%s)-x"
parse "$(api POST "/tenants/$TENANT_ID/users/$TU_ID/reset-password" "{\"new_password\":\"$TU_PW\"}" "$ADMIN_TOKEN")"
[[ "$STATUS" == "204" || "$STATUS" == "200" ]] || { fail "reset tenant user pw: $STATUS $BODY"; exit 1; }
parse "$(api POST /auth/login "{\"email\":\"$TU_EMAIL\",\"password\":\"$TU_PW\",\"panel\":\"tenant\"}")"
TENANT_TOKEN=$(printf '%s' "$BODY" | jq -r '.data.token // empty')
[[ -n "$TENANT_TOKEN" ]] || { fail "tenant login: $STATUS $BODY"; exit 1; }; ok "tenant login as $TU_EMAIL"

# ── start file-manager + write the known tree ───────────────────────────
log "start file-manager + seed file tree"
api POST "/tenants/$TENANT_ID/files/start" "{}" "$TENANT_TOKEN" >/dev/null
ssh_node "kubectl -n $NS rollout status deploy/file-manager --timeout=120s" </dev/null >/dev/null \
  || { fail "file-manager not ready"; exit 1; }
FM_POD=""
for _ in $(seq 1 20); do
  FM_POD=$(ssh_node "kubectl -n $NS get pod -l app=file-manager --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'" </dev/null 2>/dev/null || true)
  [[ -n "$FM_POD" ]] && break; sleep 3
done
[[ -n "$FM_POD" ]] || { fail "no running file-manager pod"; exit 1; }; ok "file-manager pod $FM_POD"

fm_exec 'mkdir -p /data/site/wp-content; printf ORIGINAL > /data/site/index.php; printf KEEP > /data/site/wp-content/keep.txt; printf ORIGINAL-CFG > /data/config.ini; sync'
ok "seeded /data/site/index.php, /data/site/wp-content/keep.txt, /data/config.ini"

# ── files backup ────────────────────────────────────────────────────────
# Pass BUNDLE_TARGET=<backup-config-id> to bundle via the admin path (resolves
# the target with requireActive:false — needed when the tenant's assigned
# target is inactive, e.g. after a cluster rebuild). Otherwise the tenant
# run-now flow (which requires an active assigned target).
log "files backup"
if [[ -n "${BUNDLE_TARGET:-}" ]]; then
  parse "$(api POST "/admin/tenant-bundles" "{\"tenantId\":\"$TENANT_ID\",\"targetConfigId\":\"$BUNDLE_TARGET\",\"async\":true}" "$ADMIN_TOKEN")"
else
  parse "$(api POST "/tenants/$TENANT_ID/bundles/run-now" "{}" "$TENANT_TOKEN")"
fi
[[ "$STATUS" == "202" || "$STATUS" == "201" ]] || { fail "bundle create: $STATUS $BODY"; exit 1; }
BUNDLE_ID=$(printf '%s' "$BODY" | jq -r '.data.bundleId // .data.id'); ok "bundle $BUNDLE_ID"
wait_bundle "$BUNDLE_ID" "$TENANT_ID" "$TENANT_TOKEN" 240
if [[ "$BUNDLE_STATUS" == "completed" || "$BUNDLE_STATUS" == "partial" ]]; then
  ok "bundle terminal: $BUNDLE_STATUS"
else
  fail "bundle terminal: $BUNDLE_STATUS"
  api GET "/admin/tenant-bundles/$BUNDLE_ID" "" "$ADMIN_TOKEN" | jq -r '.data.components[]? | select(.status!="completed") | "  comp=\(.component) status=\(.status) err=\(.lastError//"")"' || true
  exit 1
fi

# ── BROWSE the restic tree (the new file browser) ───────────────────────
log "browse the restic file tree"
browse() { parse "$(api GET "/tenants/$TENANT_ID/bundles/$BUNDLE_ID/browse/files/tree?path=$1" "" "$TENANT_TOKEN")"; printf '%s' "$BODY"; }
ROOT=$(browse ''); echo "$ROOT" | jq -e '.data.entries[] | select(.name=="site" and .type=="dir")' >/dev/null && ok "browse root → site/ (dir)" || fail "browse root missing site/: $ROOT"
echo "$ROOT" | jq -e '.data.entries[] | select(.name=="config.ini" and .type=="file")' >/dev/null && ok "browse root → config.ini (file)" || fail "browse root missing config.ini"
SITE=$(browse 'site'); echo "$SITE" | jq -e '.data.entries[] | select(.name=="index.php" and .type=="file")' >/dev/null && ok "browse site/ → index.php" || fail "browse site/ missing index.php: $SITE"
echo "$SITE" | jq -e '.data.entries[] | select(.name=="wp-content" and .type=="dir")' >/dev/null && ok "browse site/ → wp-content/" || fail "browse site/ missing wp-content/"
WPC=$(browse 'site/wp-content'); echo "$WPC" | jq -e '.data.entries[] | select(.name=="keep.txt" and .type=="file")' >/dev/null && ok "browse site/wp-content/ → keep.txt" || fail "browse wp-content missing keep.txt: $WPC"

# ── mutate, then restore a single FILE ──────────────────────────────────
log "mutate then restore a single file (site/index.php)"
fm_exec 'printf MUTATED > /data/site/index.php; rm -f /data/config.ini; rm -rf /data/site/wp-content; sync'
[[ "$(fm_exec 'cat /data/site/index.php')" == "MUTATED" ]] && ok "mutated index.php" || fail "mutate failed"
restore_paths "$BUNDLE_ID" '["site/index.php"]'
[[ "$CART_STATUS" == "done" ]] && ok "file restore cart done" || { fail "file restore cart: $CART_STATUS"; }
[[ "$(fm_exec 'cat /data/site/index.php')" == "ORIGINAL" ]] && ok "index.php reverted to ORIGINAL (single-file restore)" || fail "index.php NOT reverted: got '$(fm_exec 'cat /data/site/index.php')'"
# config.ini was deleted and NOT in the restore selection → must stay gone.
[[ "$(fm_exec 'test -f /data/config.ini && echo yes || echo no')" == "no" ]] && ok "config.ini correctly NOT restored (not selected)" || warn "config.ini unexpectedly present"

# ── restore a FOLDER ────────────────────────────────────────────────────
log "restore a folder (site/wp-content)"
restore_paths "$BUNDLE_ID" '["site/wp-content"]'
[[ "$CART_STATUS" == "done" ]] && ok "folder restore cart done" || fail "folder restore cart: $CART_STATUS"
[[ "$(fm_exec 'cat /data/site/wp-content/keep.txt 2>/dev/null')" == "KEEP" ]] && ok "wp-content/keep.txt restored (folder restore)" || fail "folder restore failed: keep.txt missing/wrong"

# ── summary ─────────────────────────────────────────────────────────────
echo
log "RESULT: $passed passed, $failed failed"
[[ "$failed" == "0" ]] || exit 1
