#!/usr/bin/env bash
# End-to-end test for the R16 platform-apex decouple + turnkey rename.
#
# Proves (all against the real cluster):
#   1. GET /admin/platform-domain returns the current apex + derived hostnames.
#   2. POST /admin/platform-domain/rename moves the reconciler-driven surfaces:
#      the platform-ingress Traefik IngressRoute Host + the platform-ingress
#      cert-manager Certificate dnsNames flip to admin/tenant.<newApex>, and the
#      platform_domain + admin/tenant/webmail/mail settings are rewritten.
#   3. The tenant CNAME-target (ingress_base_domain) is NOT moved (the decouple).
#   4. Revert restores everything (idempotent).
#   5. (optional, when RENAME_TARGET DNS resolves) the new apex serves with a
#      trusted Let's Encrypt cert — proves cert-manager followed the rename.
#
# DNS for RENAME_TARGET must exist for step 5 (the platform PowerDNS is
# netbird-only; this suite does not create records). If it doesn't resolve,
# step 5 is skipped (not failed).
#
# USAGE: ADMIN_PASSWORD=<…> ADMIN_HOST=https://admin.<env>.example.test \
#        SSH_HOST=root@<ip> RENAME_TARGET=<env>-rename.example.test \
#        ./scripts/integration-platform-domain-rename-e2e.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/integration-env.sh
[[ -f "$SCRIPT_DIR/lib/integration-env.sh" ]] && source "$SCRIPT_DIR/lib/integration-env.sh" && load_integration_env

ADMIN_HOST="${ADMIN_HOST:-https://admin.testing.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@testing.example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@192.0.2.10}"
RENAME_TARGET="${RENAME_TARGET:-}"   # e.g. testing-rename.example.test
[[ -n "$ADMIN_PASSWORD" ]] || { echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YEL='\033[33m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED" "$RESET" "$*"; failed=$((failed+1)); }
skip() { printf '  %b•%b SKIP %s\n' "$YEL" "$RESET" "$*"; }
passed=0; failed=0

ssh_q() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15 -q "$SSH_HOST" "$@"; }
# Target the CNPG primary by label (survives failover; falls back to the
# legacy 'postgres' cluster name on pre-PG18 clusters).
psql_t() {
  ssh_q "P=\$(kubectl -n platform get pods -l cnpg.io/cluster=system-db,role=primary -o jsonpath='{.items[0].metadata.name}' 2>/dev/null); [ -z \"\$P\" ] && P=\$(kubectl -n platform get pods -l cnpg.io/cluster=postgres,role=primary -o jsonpath='{.items[0].metadata.name}' 2>/dev/null); kubectl -n platform exec \"\$P\" -c postgres -- psql -U postgres -d platform -tAc \"$1\"" 2>/dev/null
}
api() {
  local m="$1" p="$2" b="${3:-}" host="${4:-$ADMIN_HOST}"
  if [[ -z "$b" ]]; then
    curl -sk --max-time 90 -X "$m" "$host/api/v1$p" -H "Authorization: Bearer $TOKEN"
  else
    curl -sk --max-time 90 -X "$m" "$host/api/v1$p" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$b"
  fi
}
ir_host() { ssh_q "kubectl -n platform get ingressroute platform-ingress -o jsonpath='{.spec.routes[0].match}'" 2>/dev/null; }
cert_sans() { ssh_q "kubectl -n platform get certificate platform-ingress -o jsonpath='{.spec.dnsNames}'" 2>/dev/null; }

log "logging in"
TOKEN=$(curl -sk --max-time 15 -X POST "$ADMIN_HOST/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])")
[[ -n "$TOKEN" ]] || { echo "login failed" >&2; exit 1; }

# Current apex (to revert to). Strip the admin. prefix off ADMIN_HOST as a fallback.
ORIG_APEX=$(api GET /admin/platform-domain | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['platformDomain'] or '')")
[[ -n "$ORIG_APEX" ]] && ok "GET /admin/platform-domain -> current apex $ORIG_APEX" || { fail "GET platform-domain returned no apex"; exit 1; }
ORIG_INGRESS=$(psql_t "select ingress_base_domain from system_settings where id='system'")
log "current ingress_base_domain (tenant CNAME target) = $ORIG_INGRESS"

if [[ -z "$RENAME_TARGET" ]]; then
  skip "RENAME_TARGET not set — cluster-reconfig + serving steps skipped; only the read path was exercised"
  printf '\n%b== platform-domain-rename E2E: %d passed, %d failed (read-only) ==%b\n' "$CYAN" "$passed" "$failed" "$RESET"
  [[ "$failed" -eq 0 ]] || exit 1; exit 0
fi

# Revert MUST target the new host (admin.testing rename moved the admin
# IngressRoute away). The Bearer token is host-independent. Try the new host
# first, then the original (in case the rename didn't take).
restore() { api POST /admin/platform-domain/rename "{\"newApex\":\"$ORIG_APEX\"}" "https://admin.$RENAME_TARGET" >/dev/null 2>&1 || \
            api POST /admin/platform-domain/rename "{\"newApex\":\"$ORIG_APEX\"}" >/dev/null 2>&1 || true; }
trap restore EXIT

log "── rename $ORIG_APEX -> $RENAME_TARGET ──"
RESP=$(api POST /admin/platform-domain/rename "{\"newApex\":\"$RENAME_TARGET\"}")
REC=$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d['reconciled'])" 2>/dev/null)
[[ -n "$REC" ]] && ok "rename action returned reconciled=$REC" || { fail "rename failed: $(echo "$RESP" | head -c 200)"; exit 1; }
sleep 4

# 2. IngressRoute Host + Certificate dnsNames flipped.
echo "$(ir_host)" | grep -q "admin.$RENAME_TARGET" && ok "platform-ingress IngressRoute Host -> admin.$RENAME_TARGET" \
  || fail "IngressRoute host did not flip: $(ir_host)"
echo "$(cert_sans)" | grep -q "admin.$RENAME_TARGET" && ok "platform-ingress Certificate dnsNames -> admin.$RENAME_TARGET" \
  || fail "Certificate dnsNames did not flip: $(cert_sans)"

# 3. Settings rewritten; ingress_base_domain UNCHANGED.
PD=$(psql_t "select platform_domain from system_settings where id='system'")
IB=$(psql_t "select ingress_base_domain from system_settings where id='system'")
[[ "$PD" == "$RENAME_TARGET" ]] && ok "platform_domain -> $RENAME_TARGET" || fail "platform_domain=$PD (expected $RENAME_TARGET)"
[[ "$IB" == "$ORIG_INGRESS" ]] && ok "ingress_base_domain UNCHANGED ($IB) — decouple holds" || fail "ingress_base_domain moved to $IB (must stay $ORIG_INGRESS)"

# 5. (optional) cert issued + serving, only if the new apex resolves.
if [[ "$(dig +short admin.$RENAME_TARGET 2>/dev/null | tail -1)" =~ ^[0-9] ]]; then
  log "── waiting for cert + serving on admin.$RENAME_TARGET ──"
  served=""
  for _ in $(seq 1 40); do
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://admin.$RENAME_TARGET/" 2>/dev/null || echo 000)
    [[ "$code" == "200" ]] && { served=1; break; }
    sleep 6
  done
  [[ -n "$served" ]] && ok "https://admin.$RENAME_TARGET serves HTTP 200 with a trusted cert" \
    || fail "admin.$RENAME_TARGET did not serve a trusted cert in time"
else
  skip "admin.$RENAME_TARGET does not resolve — cert/serving step skipped (create DNS to enable)"
fi

# 4. Revert + verify restored.
log "── revert -> $ORIG_APEX (via the new host) ──"
api POST /admin/platform-domain/rename "{\"newApex\":\"$ORIG_APEX\"}" "https://admin.$RENAME_TARGET" >/dev/null 2>&1
sleep 5
echo "$(ir_host)" | grep -q "admin.$ORIG_APEX" && ok "reverted: IngressRoute Host back to admin.$ORIG_APEX" \
  || fail "revert did not restore the host: $(ir_host)"
[[ "$(psql_t "select platform_domain from system_settings where id='system'")" == "$ORIG_APEX" ]] \
  && ok "reverted: platform_domain back to $ORIG_APEX" || fail "platform_domain not restored"

printf '\n%b== platform-domain-rename E2E: %d passed, %d failed ==%b\n' "$CYAN" "$passed" "$failed" "$RESET"
[[ "$failed" -eq 0 ]] || exit 1
