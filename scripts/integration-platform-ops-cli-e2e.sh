#!/usr/bin/env bash
# End-to-end test for the R18 platform-ops CLI subcommands, driven through the
# signed `platform-ops` binary ON a cluster node (the real operator path).
#
# Covers (R18 platform-ops surface):
#   1. `platform-ops admin reset-password --email <addr> --random`
#      → execs the in-pod entrypoint (native bcrypt in the platform-api pod),
#        prints the new password on its own line; we then log in with it, then
#        restore the KNOWN password (stdin path) so a suite stays authenticated.
#   2. `platform-ops version --json`            → installed/running both present.
#   3. `platform-ops cluster doctor --json`     → ≥6 checks incl the {cosign,
#        kubeconfig,reachable} core; exit code matches the fails contract.
#   4. `platform-ops backup key-status --json`  → ok + age-key fingerprint.
#   5. `platform-ops backup target list --json` + idempotent re-bind round-trip
#        (re-bind assignments[0] to its own target; assert the binding is
#        unchanged — a CLI bind must be idempotent).
#   6. `platform-ops domain rename --to <apex>` (only when RENAME_TARGET is set)
#      → execs the in-pod entrypoint (same renamePlatformDomain the API uses);
#        we assert the platform IngressRoute hosts flip, the tenant CNAME target
#        (ingress_base_domain) does NOT, then revert.
#
# 1/6 and 6 are thin host-side orchestrators that `kubectl exec` into the
# platform-api pod (native-dep graph); 2–5 run in-binary on the node. Tests
# 2–5 are read-only / idempotent and safe inside an orchestrated suite; the
# destructive rename (6) is opt-in via RENAME_TARGET.
#
# USAGE: set ADMIN_PASSWORD to the known admin password (restored after the
# --random reset so orchestrated runs keep authenticating; omit it for a
# standalone run and the random reset password is left in place). Plus:
#   SSH_HOST=root@<ip> SSH_KEY=~/key ADMIN_HOST=https://admin.<env>.example.test \
#   ADMIN_EMAIL=admin@<env>.example.test [RENAME_TARGET=<env>-rename.example.test] \
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
# Suite-safety: restore the KNOWN password (via the stdin path — never argv) so
# later scenarios in an orchestrated run keep authenticating. Also exercises the
# non-random reset. Standalone runs (no ADMIN_PASSWORD) leave the random one.
if [[ -n "${ADMIN_PASSWORD:-}" ]]; then
  printf '%s' "$ADMIN_PASSWORD" | ssh_q "$PLATFORM_OPS_BIN admin reset-password --email $ADMIN_EMAIL 2>/dev/null" >/dev/null
  RT=$(login_token "$ADMIN_PASSWORD")
  [[ -n "$RT" ]] && ok "restored the known admin password (login works again)" || fail "could not restore the known admin password"
else
  skip "ADMIN_PASSWORD unset — leaving the random reset password (standalone mode)"
fi

# ─── Read-only / idempotent R18 subcommands (safe to run in an orchestrated suite) ─
log "── version --json ──"
VJ=$(on_node "version --json")
echo "$VJ" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('installed') and d.get('running')" 2>/dev/null \
  && ok "version --json: installed=$(echo "$VJ" | python3 -c "import json,sys;print(json.load(sys.stdin)['installed'])" 2>/dev/null)" \
  || fail "version --json malformed: ${VJ:0:120}"

log "── cluster doctor --json ──"
DJ=$(on_node "cluster doctor --json"); DRC=$?
if echo "$DJ" | python3 -c "import json,sys
d=json.load(sys.stdin)
assert isinstance(d.get('checks'),list) and len(d['checks'])>=6
n={c['name'] for c in d['checks']}
assert {'cosign trust anchor','host-config kubeconfig','cluster reachable'} <= n" 2>/dev/null; then
  ok "cluster doctor --json: $(echo "$DJ" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"{len(d['checks'])} checks, fails={d['fails']}, warns={d['warns']}\")" 2>/dev/null)"
  EXP=$(echo "$DJ" | python3 -c "import json,sys;print(1 if json.load(sys.stdin)['fails']>0 else 0)" 2>/dev/null)
  [[ "$DRC" == "$EXP" ]] && ok "doctor exit code ($DRC) matches the fails contract" || fail "doctor exit $DRC != expected $EXP"
else
  fail "cluster doctor --json malformed: ${DJ:0:160}"
fi

log "── backup key-status --json ──"
KJ=$(on_node "backup key-status --json")
echo "$KJ" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('ok') and d.get('fingerprint')" 2>/dev/null \
  && ok "backup key-status: fingerprint=$(echo "$KJ" | python3 -c "import json,sys;print(json.load(sys.stdin)['fingerprint'])" 2>/dev/null)" \
  || fail "backup key-status --json malformed: ${KJ:0:120}"

log "── backup target list + idempotent bind round-trip ──"
TL=$(on_node "backup target list --json")
if echo "$TL" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('ok') and isinstance(d.get('configs'),list) and isinstance(d.get('assignments'),list)" 2>/dev/null; then
  ok "backup target list: $(echo "$TL" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"{len(d['configs'])} targets, {len(d['assignments'])} bindings\")" 2>/dev/null)"
  RB=$(echo "$TL" | python3 -c "import json,sys;a=(json.load(sys.stdin).get('assignments') or []);print(f\"{a[0]['backupClass']} {a[0]['targetId']}\" if a else '')" 2>/dev/null)
  if [[ -n "$RB" ]]; then
    RC=${RB%% *}; RTID=${RB##* }
    on_node "backup target bind $RC $RTID --json" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d.get('ok') and d.get('backupClass')=='$RC' and d.get('targetId')=='$RTID'" 2>/dev/null \
      && ok "idempotent re-bind $RC → ${RTID:0:8}… ok" || fail "re-bind $RC failed"
    on_node "backup target list --json" | python3 -c "import json,sys;d=json.load(sys.stdin);assert any(x['backupClass']=='$RC' and x['targetId']=='$RTID' for x in (d.get('assignments') or []))" 2>/dev/null \
      && ok "binding $RC unchanged after re-bind (idempotent)" || fail "binding changed after re-bind"
  else
    skip "no existing class binding — idempotent re-bind skipped"
  fi
else
  fail "backup target list --json malformed: ${TL:0:160}"
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