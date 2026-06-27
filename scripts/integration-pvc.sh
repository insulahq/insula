#!/usr/bin/env bash
# PVC-focused integration tests for the unified tenant StorageClass +
# live tier patch + auto worker pick. Runs against staging.
#
# Asserts behavior introduced in commits 0f6e40c / 8a9a5c3:
#   1. autoPickWorkerNode populates clients.workerNodeName when the
#      operator creates a Local-tier client without a pin.
#   2. Initial PVC binds to longhorn-tenant SC (not the legacy -local
#      / -ha pair) and Volume.spec.numberOfReplicas matches the tier
#      (1 for local, 2 for ha) — verifying patchTenantVolumeReplicas
#      polls past the bind race.
#   3. Tier flip local→ha is LIVE: Volume.spec.numberOfReplicas
#      switches without recreating the StatefulSet / namespace.
#   4. Cascade cleanup catches late-binding PVs when a fast
#      create+delete races against Longhorn provisioning.
#
# USAGE
#   ADMIN_PASSWORD=<…> ./scripts/integration-pvc.sh

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@192.0.2.56}"
SSH_OPTS="${SSH_OPTS:--o StrictHostKeyChecking=no -o ConnectTimeout=10 -q}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "ERROR: ADMIN_PASSWORD must be set" >&2
  exit 2
fi

CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
RESET='\033[0m'

log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }

passed=0
failed=0

ssh_cp() { ssh -i "$SSH_KEY" $SSH_OPTS "$SSH_HOST" "$@"; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk -X "$method" "$ADMIN_HOST/api/v1$path" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body"
  fi
}

# delete_tenant <cid> — DELETE a tenant, retrying the transient 429s the parallel
# integration-all run trips. All 12 parallel suites authenticate as the ONE shared
# admin token, so the global limiter's per-user bucket (keyGenerator = user.sub,
# default 100/min) saturates under the synthetic batch burst; a bare DELETE with
# no retry then fails instantly (observed 2026-06-27: the cascade DELETE here + the
# EXIT-trap cleanup both 429'd). Self-contained (this suite sources integration-
# token.sh only when INTEGRATION_TOKEN is unset, so api_curl isn't guaranteed to
# exist). Echoes the same "<body>\nHTTP <code>" shape as
# `curl … -w "\nHTTP %{http_code}"`, so callers `tail -1 | grep 20[04]` unchanged.
# Also rides out brief 5xx/000 control-plane blips; a PERSISTENT error still
# surfaces (returns the last body after retries → the caller's assertion fails).
delete_tenant() {
  local cid="$1" resp code attempt retried=0
  for attempt in 1 2 3 4 5 6 7 8; do
    resp=$(curl -sk -m 30 -X DELETE "$ADMIN_HOST/api/v1/tenants/$cid" \
      -H "Authorization: Bearer $TOKEN" -w $'\nHTTP %{http_code}' 2>/dev/null)
    code="${resp##*HTTP }"
    [[ "$code" =~ ^[0-9]+$ ]] || code=000
    # A 404 that FOLLOWS a retried transient means a prior attempt reached the
    # server and the (async) tenant delete already went through — its 200 was
    # lost to the very blip we retried on. The tenant is gone, which is the whole
    # goal, so normalize to success (idempotent DELETE) instead of failing on
    # "not found". A first-attempt 404 (retried=0) is a genuine error and still
    # surfaces. Observed 2026-06-27: under the parallel burst on a freshly-rolled
    # pod, attempt 1 timed out (curl 000) after the server had accepted the
    # delete, so the retry hit 404 and false-failed the suite + leaked a PV.
    if [[ "$code" == "404" && "$retried" == "1" ]]; then
      echo "delete_tenant $cid: 404 after a retried transient — tenant already deleted, treating as success" >&2
      printf 'HTTP 204'
      return 0
    fi
    if [[ "$code" == "429" || "$code" == "000" || "$code" -ge 500 ]]; then
      retried=1
      echo "delete_tenant $cid: attempt $attempt got HTTP $code — retrying" >&2
      sleep $(( attempt < 5 ? attempt * 3 : 15 ))
      continue
    fi
    printf '%s' "$resp"
    return 0
  done
  printf '%s' "$resp"
  return 0
}

# shellcheck source=scripts/lib/integration-env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"

# Count tenant-capable nodes via the admin API. Same source of truth as
# integration-tier-flip-e2e.sh ("need >=3 tenant nodes"). The HA tier-flip
# scenario below needs >=3 so Longhorn can place 2 replicas; below that the
# backend refuses the flip with HA_REQUIRES_MULTI_NODE. Used to skip just
# that one scenario on smaller clusters.
count_tenant_nodes() {
  api GET "/admin/nodes" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    nodes = d.get('data') or []
    print(sum(1 for n in nodes if n.get('canHostTenantWorkloads')))
except Exception:
    print(0)
" 2>/dev/null
}

# #130: reuse ONE cache-backed admin token across ALL/single-test modes so
# rapid runs don't trip the auth rate limit. Only mints if no token is set
# and the cache is cold; otherwise reads the shared cache file.
if [[ -z "${INTEGRATION_TOKEN:-}" ]] && [[ -f "$(dirname "${BASH_SOURCE[0]}")/integration-token.sh" ]]; then
  # shellcheck source=integration-token.sh
  source "$(dirname "${BASH_SOURCE[0]}")/integration-token.sh"
  INTEGRATION_TOKEN="$(get_admin_token)" && export INTEGRATION_TOKEN || true
fi

# When invoked by integration-all.sh, the master runner exports
# INTEGRATION_TOKEN so we skip the redundant per-suite /auth/login
# round-trip. Standalone runs (no env) fall through to fresh login —
# behaviour unchanged.
if [[ -n "${INTEGRATION_TOKEN:-}" ]]; then
  log "using cached INTEGRATION_TOKEN"
  TOKEN="$INTEGRATION_TOKEN"
else
  log "logging in as $ADMIN_EMAIL"
  TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
fi
[[ -n "$TOKEN" ]] || { echo "login failed"; exit 1; }

# Track every tenant we create so the EXIT trap can DELETE them
# even when an `exit 1` between create + delete short-circuits the
# inline cleanup. Each CID is appended as it's allocated and removed
# only after the inline DELETE has confirmed success.
declare -a CREATED_CIDS=()
track_cid()   { CREATED_CIDS+=("$1"); }
untrack_cid() { CREATED_CIDS=("${CREATED_CIDS[@]/$1}"); }

cleanup_tenants() {
  local rc=$?
  if [[ ${#CREATED_CIDS[@]} -gt 0 ]]; then
    log "EXIT trap: deleting ${#CREATED_CIDS[@]} leftover tenant(s)"
    for cid in "${CREATED_CIDS[@]}"; do
      [[ -z "$cid" ]] && continue
      printf '  cleanup %s → %s\n' "$cid" "$(delete_tenant "$cid" | tail -1)" || true
    done
  fi
  exit "$rc"
}
trap cleanup_tenants EXIT

PLAN_ID=$(api GET "/plans" | python3 -c "import json,sys;d=json.load(sys.stdin);print(next((p['id'] for p in d['data'] if p['name']=='Starter'),''))")
REGION_ID=$(api GET "/regions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['data'][0]['id'])")
[[ -n "$PLAN_ID" && -n "$REGION_ID" ]] || { echo "no plan/region"; exit 1; }

# ─── scenario 1: storage_tier=local + Auto worker pick ───────────────
log "── scenario: local tier + auto worker pick ──"
STAMP=$(date +%s)
COMPANY="PVC Test L $STAMP"
RESP=$(api POST "/tenants" "{\"name\":\"$COMPANY\",\"primary_email\":\"pvc-l-$STAMP@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"storage_tier\":\"local\"}")
CID=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[[ -n "$CID" ]] && { ok "client created cid=$CID"; track_cid "$CID"; } || { fail "create failed: $RESP"; exit 1; }

# Tenants are created pending+unprovisioned (no auto-provision) — provision
# + wait for status=active before the namespace/PVC exist.
provision_tenant "$CID" || { fail "pvc/local: client provisioning failed"; exit 1; }

# Wait for provisioning to settle (PVC bound, Volume CR present).
NS=""
for _ in $(seq 1 30); do
  NS=$(ssh_cp "kubectl get ns -l tenant=$CID -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null || true)
  [[ -n "$NS" ]] && break
  sleep 2
done
[[ -n "$NS" ]] && ok "namespace=$NS" || { fail "no namespace within 60s"; exit 1; }

# Wait for PVC bind + Longhorn Volume creation.
for _ in $(seq 1 60); do
  PVNAME=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.spec.volumeName}'" 2>/dev/null || true)
  [[ -n "$PVNAME" ]] && break
  sleep 2
done
[[ -n "$PVNAME" ]] && ok "PVC bound pv=$PVNAME" || { fail "PVC not bound after 120s"; exit 1; }

# Assert SC is one of the unified longhorn-tenant variants. The test
# namespace slug ("PVC Test L $STAMP" → "tenant-pvc-test-l-...") trips
# the test-namespace regex in k8s-provisioner/service.ts:selectTenantStorageClass
# which selects `longhorn-tenant-test` (reclaimPolicy=Delete). Both
# values are correct outcomes — the assertion only needs to rule out
# unrelated storage classes (local-path, longhorn, etc.).
SC=$(ssh_cp "kubectl -n $NS get pvc ${NS}-storage -o jsonpath='{.spec.storageClassName}'")
if [[ "$SC" == "longhorn-tenant" || "$SC" == "longhorn-tenant-test" ]]; then
  ok "SC=$SC (longhorn-tenant or test variant)"
else
  fail "SC=$SC (expected longhorn-tenant or longhorn-tenant-test)"
fi

# Auto-pick: tenant.nodeName should be populated for Local tier. Field
# was renamed `workerNodeName` → `nodeName` (tenant-rename refactor M5).
WORKER=$(api GET "/tenants/$CID" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d.get('nodeName') or '')")
[[ -n "$WORKER" ]] && ok "auto-picked nodeName=$WORKER" || fail "nodeName empty (autoPickWorkerNode didn't fire — check worker host-tenant-workloads=true label)"

# Volume.spec.numberOfReplicas should be 1 for local tier.
REPL=$(ssh_cp "kubectl -n longhorn-system get volumes.longhorn.io $PVNAME -o jsonpath='{.spec.numberOfReplicas}'" 2>/dev/null || echo "")
[[ "$REPL" == "1" ]] && ok "Volume replicas=1 (local tier)" || fail "Volume replicas=$REPL (expected 1)"

# ─── scenario 2: tier flip local → ha live ───────────────────────────
# Needs ≥3 tenant-capable nodes — below that the backend refuses the flip
# with HA_REQUIRES_MULTI_NODE (409) and Longhorn can never reach 2 replicas.
# Skip just this scenario on smaller clusters (warn + continue); scenarios
# 1/3/4 remain valid, so the suite still exits 0 rather than failing for a
# reason that's purely "needs multiple nodes".
TENANT_NODE_COUNT=$(count_tenant_nodes)
if [[ "${TENANT_NODE_COUNT:-0}" -ge 3 ]]; then
  log "── scenario: tier flip local→ha live ──"
  FLIP=$(api PATCH "/tenants/$CID" '{"storage_tier":"ha"}')
  echo "$FLIP" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('data',{}).get('storageTier')=='ha'" 2>/dev/null \
    && ok "client storageTier flipped to ha" || fail "tier flip failed: $(echo $FLIP | head -c 200)"

  # Volume.spec.numberOfReplicas should reach 2 within ~30s (live patch).
  REPL=""
  for _ in $(seq 1 30); do
    REPL=$(ssh_cp "kubectl -n longhorn-system get volumes.longhorn.io $PVNAME -o jsonpath='{.spec.numberOfReplicas}'" 2>/dev/null || echo "")
    [[ "$REPL" == "2" ]] && break
    sleep 2
  done
  [[ "$REPL" == "2" ]] && ok "Volume replicas=2 after live flip" || fail "Volume replicas=$REPL after 60s (expected 2)"
else
  log "── scenario: tier flip local→ha live — SKIPPED (need ≥3 tenant nodes; have ${TENANT_NODE_COUNT:-0}) ──"
fi

# ─── scenario 3: client delete cascade fires ─────────────────────────
log "── scenario: cascade cleans tenant PV ──"
DEL=$(delete_tenant "$CID")
echo "$DEL" | tail -1 | grep -qE "20[04]" && { ok "tenant deleted (200|204)"; untrack_cid "$CID"; } || { fail "delete failed: $DEL"; exit 1; }

# Wait up to 90s for the orphan PV to disappear.
GONE=0
for _ in $(seq 1 45); do
  PV_PHASE=$(ssh_cp "kubectl get pv $PVNAME -o jsonpath='{.status.phase}' 2>&1" || true)
  if [[ "$PV_PHASE" == *"NotFound"* || "$PV_PHASE" == *"not found"* ]]; then
    GONE=1; break
  fi
  sleep 2
done
[[ $GONE -eq 1 ]] && ok "PV $PVNAME cleaned by cascade" || fail "PV still present after 90s (cascade didn't fire)"

# ─── scenario 4: fast create+delete (cascade race) ───────────────────
log "── scenario: fast create+delete (cascade race) ──"
STAMP=$(date +%s)
COMPANY="PVC Race $STAMP"
RESP=$(api POST "/tenants" "{\"name\":\"$COMPANY\",\"primary_email\":\"pvc-race-$STAMP@example.test\",\"plan_id\":\"$PLAN_ID\",\"region_id\":\"$REGION_ID\",\"storage_tier\":\"local\"}")
CID2=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])" 2>/dev/null)
[[ -n "$CID2" ]] && { ok "race client created cid=$CID2"; track_cid "$CID2"; } || { fail "race create failed"; exit 1; }

# Tenants are created pending+unprovisioned (no auto-provision) — provision
# + wait for status=active before the namespace/PVC exist.
provision_tenant "$CID2" || { fail "pvc/race: client provisioning failed"; exit 1; }

# Capture the namespace immediately so we can identify the PV later.
NS2=""
for _ in $(seq 1 10); do
  NS2=$(ssh_cp "kubectl get ns -l tenant=$CID2 -o jsonpath='{.items[0].metadata.name}'" 2>/dev/null || true)
  [[ -n "$NS2" ]] && break
  sleep 1
done
[[ -n "$NS2" ]] && ok "race ns=$NS2" || { fail "no race ns"; exit 1; }

# DELETE within ~3s — Longhorn won't have bound the PV yet, exercising
# the late-binding tracking in the pv-cleanup-released hook.
sleep 1
DEL2=$(delete_tenant "$CID2")
echo "$DEL2" | tail -1 | grep -qE "20[04]" && { ok "race delete 20x"; untrack_cid "$CID2"; } || fail "race delete failed: $DEL2"

# After 90s, no PV should reference this namespace.
sleep 3
ORPHAN=0
for _ in $(seq 1 45); do
  ORPHAN=$(ssh_cp "kubectl get pv -o jsonpath='{range .items[*]}{.spec.claimRef.namespace}{\"\\n\"}{end}' 2>/dev/null | grep -c \"^$NS2\$\" || true")
  ORPHAN="${ORPHAN:-0}"
  [[ "$ORPHAN" -eq 0 ]] && break
  sleep 2
done
[[ "$ORPHAN" -eq 0 ]] && ok "no orphan PV for race ns (cascade fix works)" || fail "$ORPHAN orphan PV(s) for $NS2 after 90s"

# ─── results ─────────────────────────────────────────────────────────
log "── results ──"
printf "  passed: %s\n  failed: %s\n" "$passed" "$failed"
[[ $failed -eq 0 ]] || exit 1
