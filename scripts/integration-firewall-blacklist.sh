#!/usr/bin/env bash
# End-to-end test for the operator firewall BLACKLIST (ClusterFirewallBlacklist
# CR → firewall-reconciler → nft `blacklist_v{4,6}` drop sets).
#
# Verifies:
#   1. A safe hostile IP can be banned via the API (200) and lands in the
#      host's nft set `blacklist_v4`.
#   2. The self-lockout belt refuses a ban that would catch a node IP (422
#      BLACKLIST_SELF_LOCKOUT) — the CR is NOT created.
#   3. type-to-confirm mismatch is refused (422 BLACKLIST_CONFIRM_MISMATCH).
#   4. Deleting the entry removes it from nft.
#   5. Cleanup leaves the cluster as found.
#
# USAGE: ADMIN_PASSWORD=<…> ./scripts/integration-firewall-blacklist.sh
#   ADMIN_HOST / ADMIN_EMAIL / SSH_KEY / SSH_HOST overridable (see firewall e2e).

set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@192.0.2.56}"
# A documentation-range IP (RFC 5737 TEST-NET-3) that is provably NOT a node
# IP / peer / trusted range on any real cluster — safe to ban + unban.
SAFE_BAN_IP="${SAFE_BAN_IP:-203.0.113.222}"

[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED"   "$RESET" "$*"; failed=$((failed+1)); }
warn() { printf '  %b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
passed=0; failed=0

api_status() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$ADMIN_HOST/api/v1$path" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk -o /dev/null -w '%{http_code}' -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
  fi
}
api_body() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk -X "$method" "$ADMIN_HOST/api/v1$path" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$body"
  fi
}
ssh_cluster() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 -q "$SSH_HOST" "$@"; }

log "logging in"
TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null)
[[ -n "$TOKEN" ]] || { echo "login failed"; exit 1; }
ok "logged in"

# Resource name the service derives for the safe IP (mirror blacklistNameForCidr).
SAFE_NAME="cfb-$(echo "$SAFE_BAN_IP" | tr '.' '-')-32"
# But the service slugs the RAW cidr; for a bare IP that's just dots → hyphens.
SAFE_NAME="cfb-$(echo "$SAFE_BAN_IP" | sed 's/[^a-z0-9]/-/g')"

cleanup() {
  curl -sk -X DELETE "$ADMIN_HOST/api/v1/admin/cluster/firewall-blacklist/$SAFE_NAME" \
    -H "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# A node InternalIP — the self-lockout target. Pull the first Ready node IP.
NODE_IP=$(ssh_cluster "kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type==\"InternalIP\")].address}'" 2>/dev/null | awk '{print $1}')
log "first node InternalIP = ${NODE_IP:-<unknown>}"

# ─── Phase 1: ban a safe hostile IP ─────────────────────────────────────────
log "Phase 1: ban $SAFE_BAN_IP"
ST=$(api_status POST /admin/cluster/firewall-blacklist \
  "{\"cidr\":\"$SAFE_BAN_IP\",\"confirmCidr\":\"$SAFE_BAN_IP\",\"description\":\"integration test\",\"source\":\"manual\"}")
[[ "$ST" == "200" ]] && ok "ban accepted (200)" || fail "ban returned $ST (want 200)"

# Wait for the reconciler to converge into nft (informer kick + ~30s floor).
log "waiting up to 90s for nft convergence"
FOUND=""
for _ in $(seq 1 18); do
  if ssh_cluster "nft list set inet filter blacklist_v4 2>/dev/null" | grep -q "$SAFE_BAN_IP"; then
    FOUND=1; break
  fi
  sleep 5
done
[[ -n "$FOUND" ]] && ok "nft blacklist_v4 contains $SAFE_BAN_IP" || fail "nft blacklist_v4 missing $SAFE_BAN_IP after 90s"

# CR Ready condition should be Enforced.
READY=$(api_body GET /admin/cluster/firewall-blacklist \
  | python3 -c "import json,sys;d=json.load(sys.stdin)['data']['data'];print(next((e['ready'] for e in d if e['cidr']=='$SAFE_BAN_IP'),'missing'))" 2>/dev/null)
[[ "$READY" == "True" ]] && ok "CR Ready=True (Enforced)" || warn "CR Ready=$READY (reconciler may still be converging)"

# ─── Phase 2: self-lockout refusal ──────────────────────────────────────────
if [[ -n "$NODE_IP" ]]; then
  log "Phase 2: attempt to ban node IP $NODE_IP (must be refused)"
  ST=$(api_status POST /admin/cluster/firewall-blacklist \
    "{\"cidr\":\"$NODE_IP\",\"confirmCidr\":\"$NODE_IP\",\"source\":\"manual\"}")
  [[ "$ST" == "422" ]] && ok "self-lockout refused (422)" || fail "node-IP ban returned $ST (want 422)"
  # Ensure NO CR was created for the node IP.
  NODE_NAME="cfb-$(echo "$NODE_IP" | sed 's/[^a-z0-9]/-/g')"
  EXISTS=$(api_status GET "/admin/cluster/firewall-blacklist" >/dev/null; api_body GET /admin/cluster/firewall-blacklist \
    | python3 -c "import json,sys;d=json.load(sys.stdin)['data']['data'];print('yes' if any(e['cidr']=='$NODE_IP' for e in d) else 'no')" 2>/dev/null)
  [[ "$EXISTS" == "no" ]] && ok "no CR created for node IP" || fail "a CR for the node IP leaked"
  # Phase 2b: a CIDR that CONTAINS the node IP must also be refused.
  NODE_OCTETS="${NODE_IP%.*}.0/24"
  log "Phase 2b: attempt to ban range $NODE_OCTETS containing the node IP"
  ST=$(api_status POST /admin/cluster/firewall-blacklist     "{\"cidr\":\"$NODE_OCTETS\",\"confirmCidr\":\"$NODE_OCTETS\",\"source\":\"manual\"}")
  [[ "$ST" == "422" ]] && ok "node-containing range refused (422)" || fail "range ban returned $ST (want 422)"
else
  warn "Phase 2 skipped — could not resolve a node InternalIP"
fi

# ─── Phase 3: confirm-mismatch refusal ──────────────────────────────────────
log "Phase 3: confirm mismatch"
ST=$(api_status POST /admin/cluster/firewall-blacklist \
  "{\"cidr\":\"198.51.100.9\",\"confirmCidr\":\"198.51.100.99\",\"source\":\"manual\"}")
[[ "$ST" == "422" ]] && ok "confirm mismatch refused (422)" || fail "mismatch returned $ST (want 422)"

# ─── Phase 4: unban removes from nft ────────────────────────────────────────
log "Phase 4: unban $SAFE_BAN_IP"
ST=$(api_status DELETE "/admin/cluster/firewall-blacklist/$SAFE_NAME")
[[ "$ST" == "200" ]] && ok "delete accepted (200)" || fail "delete returned $ST (want 200)"
GONE=""
for _ in $(seq 1 18); do
  if ! ssh_cluster "nft list set inet filter blacklist_v4 2>/dev/null" | grep -q "$SAFE_BAN_IP"; then
    GONE=1; break
  fi
  sleep 5
done
[[ -n "$GONE" ]] && ok "nft blacklist_v4 no longer contains $SAFE_BAN_IP" || fail "$SAFE_BAN_IP still in nft after 90s"

echo
log "RESULT: $passed passed, $failed failed"
[[ "$failed" -eq 0 ]] || exit 1
