#!/usr/bin/env bash
# End-to-end test for the R18 platform-ops CLI subcommands, driven through the
# signed `platform-ops` binary ON a cluster node (the real operator path).
#
# Covers:
#   1. `platform-ops admin reset-password --email <addr> --random`
#      → execs the in-pod entrypoint (native bcrypt in the platform-api pod),
#        prints the new password on its own line; we then log in with it.
#   2. `platform-ops domain rename --to <apex>`
#      → execs the in-pod entrypoint (same renamePlatformDomain the API uses);
#        we assert the platform IngressRoute hosts flip, the tenant CNAME target
#        (ingress_base_domain) does NOT, then revert.
#
# Both commands are thin host-side orchestrators that `kubectl exec` into the
# platform-api pod — the SEA binary can't run the native-dep graph itself.
#
# USAGE: ADMIN_PASSWORD is NOT needed (we reset it). Set:
#   SSH_HOST=root@<ip> SSH_KEY=~/key ADMIN_HOST=https://admin.<env>.example.test \
#   ADMIN_EMAIL=admin@<env>.example.test RENAME_TARGET=<env>-rename.example.test \
#   [PLATFORM_OPS_BIN=/usr/local/bin/platform-ops] \
#   ./scripts/integration-platform-ops-cli-e2e.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/integration-env.sh
[[ -f "$SCRIPT_DIR/lib/integration-env.sh" ]] && source "$SCRIPT_DIR/lib/integration-env.sh" && load_integration_env

ADMIN_HOST="${ADMIN_HOST:-https://admin.testing.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@testing.example.test}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_HOST="${SSH_HOST:-root@192.0.2.10}"
RENAME_TARGET="${RENAME_TARGET:-}"
PLATFORM_OPS_BIN="${PLATFORM_OPS_BIN:-/usr/local/bin/platform-ops}"

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YEL='\033[33m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*"; passed=$((passed+1)); }
fail() { printf '  %b✗%b %s\n' "$RED" "$RESET" "$*"; failed=$((failed+1)); }
skip() { printf '  %b•%b SKIP %s\n' "$YEL" "$RESET" "$*"; }
passed=0; failed=0

ssh_q() { ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15 -q "$SSH_HOST" "$@"; }
on_node() { ssh_q "$PLATFORM_OPS_BIN $* 2>/dev/null"; }  # stderr is progress; keep stdout clean
ir_host_ns() { ssh_q "kubectl -n $1 get ingressroute $2 -o jsonpath='{.spec.routes[*].match}'" 2>/dev/null; }
psql_t() {
  ssh_q "P=\$(kubectl -n platform get pods -l cnpg.io/cluster=system-db,role=primary -o jsonpath='{.items[0].metadata.name}' 2>/dev/null); kubectl -n platform exec \"\$P\" -c postgres -- psql -U postgres -d platform -tAc \"$1\"" 2>/dev/null
}

login_token() { # $1 = password
  local body
  body=$(ADMIN_EMAIL="$ADMIN_EMAIL" PW="$1" python3 -c "import json,os;print(json.dumps({'email':os.environ['ADMIN_EMAIL'],'password':os.environ['PW']}))")
  curl -sk --max-time 15 -X POST "$ADMIN_HOST/api/v1/auth/login" -H "Content-Type: application/json" --data-binary "$body" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('data') or {}).get('token','') or '')" 2>/dev/null
}

log "platform-ops version on node: $(on_node version | head -1)"

# ─── Test 1: admin reset-password --random → log in with the printed password ──
log "── admin reset-password --random ──"
PW=$(on_node "admin reset-password --email $ADMIN_EMAIL --random" | tail -1)
if [[ -n "$PW" && ! "$PW" =~ ^[[:space:]] ]]; then
  ok "reset printed a password on a clean line (len ${#PW})"
else
  fail "reset did not print a usable password (got: '${PW:0:8}…')"
fi
if [[ -n "$PW" ]]; then
  TOKEN=$(login_token "$PW")
  [[ -n "$TOKEN" ]] && ok "logged in with the CLI-reset password (token issued)" || fail "login with the CLI-reset password failed"
fi

# ─── Test 2: domain rename via the CLI binary ──────────────────────────────────
if [[ -z "$RENAME_TARGET" ]]; then
  skip "RENAME_TARGET not set — domain-rename steps skipped"
  printf '\n%b== platform-ops CLI E2E: %d passed, %d failed ==%b\n' "$CYAN" "$passed" "$failed" "$RESET"
  [[ "$failed" -eq 0 ]] || exit 1; exit 0
fi

ORIG_APEX=$(psql_t "select setting_value from platform_settings where setting_key='platform_domain'")
ORIG_INGRESS=$(psql_t "select ingress_base_domain from system_settings where id='system'")
log "current apex=$ORIG_APEX ; ingress_base_domain=$ORIG_INGRESS"
[[ -n "$ORIG_APEX" ]] || { fail "could not read current platform_domain — aborting before any mutation"; exit 1; }

# Revert no matter how we exit (rename moves the admin host; the binary runs on
# the node over SSH, so it works regardless of which host the panel is on).
restore() { on_node "domain rename --to $ORIG_APEX" >/dev/null 2>&1 || true; }
trap restore EXIT

log "── domain rename --to $RENAME_TARGET ──"
REC=$(on_node "domain rename --to $RENAME_TARGET --json" | tail -1)
echo "$REC" | grep -q "\"newApex\":\"$RENAME_TARGET\"" && ok "rename returned newApex=$RENAME_TARGET" \
  || fail "rename did not return the new apex: ${REC:0:160}"
# No 'error:' substring in the reconciled map (the in-binary attempt failed here).
echo "$REC" | grep -q '"panels":"error' && fail "panels reconcile errored (in-pod path should not): ${REC:0:200}" \
  || ok "panels reconcile did not error (in-pod path)"
sleep 3

echo "$(ir_host_ns platform platform-ingress)" | grep -q "admin.$RENAME_TARGET" \
  && ok "platform-ingress Host -> admin.$RENAME_TARGET" || fail "platform-ingress host did not flip: $(ir_host_ns platform platform-ingress)"
echo "$(ir_host_ns mail stalwart-webadmin)" | grep -q "stalwart.$RENAME_TARGET" \
  && ok "stalwart-webadmin Host -> stalwart.$RENAME_TARGET" || fail "stalwart-webadmin host did not flip"
IB=$(psql_t "select ingress_base_domain from system_settings where id='system'")
[[ "$IB" == "$ORIG_INGRESS" ]] && ok "ingress_base_domain UNCHANGED ($IB) — decouple holds" || fail "ingress_base_domain moved to $IB"

log "── revert -> $ORIG_APEX ──"
on_node "domain rename --to $ORIG_APEX" >/dev/null 2>&1
sleep 4
echo "$(ir_host_ns platform platform-ingress)" | grep -q "admin.$ORIG_APEX" \
  && ok "reverted: platform-ingress Host -> admin.$ORIG_APEX" || fail "revert did not restore platform-ingress: $(ir_host_ns platform platform-ingress)"

printf '\n%b== platform-ops CLI E2E: %d passed, %d failed ==%b\n' "$CYAN" "$passed" "$failed" "$RESET"
[[ "$failed" -eq 0 ]] || exit 1