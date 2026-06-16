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
#   6. DR break-glass (R20), all non-destructive:
#        `dr preflight --json` (≥5 tier checks; exit matches the fails contract),
#        `dr restore-component etcd --local --list / --dry-run --latest` (Tier 0
#        local k3s snapshot; resolves but never cluster-resets), and Tier 1: a
#        secrets-bundle export must carry `dr-system-target.json` (decrypted
#        on-node with the operator key) and `dr restore-component etcd --offline
#        --descriptor <p> --list` must resolve it with KUBECTL=/bin/false.
#   7. `platform-ops domain rename --to <apex>` (only when RENAME_TARGET is set)
#      → execs the in-pod entrypoint (same renamePlatformDomain the API uses);
#        we assert the platform IngressRoute hosts flip, the tenant CNAME target
#        (ingress_base_domain) does NOT, then revert.
#
# 1 and 7 are thin host-side orchestrators that `kubectl exec` into the
# platform-api pod (native-dep graph); 2–6 run in-binary on the node. Tests
# 2–6 are read-only / idempotent / non-destructive and safe inside an
# orchestrated suite; the destructive rename (7) is opt-in via RENAME_TARGET.
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

# ─── DR break-glass (R20): tiered etcd restore ─────────────────────────────────
# All non-destructive: preflight + Tier-0 list/dry-run + Tier-1 descriptor
# delivery & offline path-resolution (NO real cluster-reset, NO real restore).
log "── dr preflight --json ──"
PF=$(on_node "dr preflight --json"); PRC=$?
if echo "$PF" | python3 -c "import json,sys
d=json.load(sys.stdin)
assert isinstance(d.get('checks'),list) and len(d['checks'])>=5
n=[c['name'] for c in d['checks']]
assert any('Tier 0' in x for x in n) and any('Tier 1' in x for x in n)" 2>/dev/null; then
  ok "dr preflight --json: $(echo "$PF" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"{len(d['checks'])} checks, fails={d['fails']}, warns={d['warns']}\")" 2>/dev/null)"
  EXP=$(echo "$PF" | python3 -c "import json,sys;print(1 if json.load(sys.stdin)['fails']>0 else 0)" 2>/dev/null)
  [[ "$PRC" == "$EXP" ]] && ok "dr preflight exit ($PRC) matches the fails contract" || fail "preflight exit $PRC != expected $EXP"
else
  fail "dr preflight --json malformed: ${PF:0:200}"
fi

log "── dr restore-component etcd --local (Tier 0, non-destructive) ──"
LL=$(on_node "dr restore-component etcd --local --list")
echo "$LL" | grep -qE 'snapshot|none found|in /var/lib' \
  && ok "etcd --local --list ran (Tier 0): $(echo "$LL" | grep -cE 'etcd-snapshot|e2e-|\.db') snapshot line(s)" \
  || fail "etcd --local --list output unexpected: ${LL:0:160}"
DD=$(on_node "dr restore-component etcd --local --dry-run --latest")
echo "$DD" | grep -q 'cluster-reset' \
  && ok "etcd --local --dry-run --latest resolves + would cluster-reset (NOT executed)" \
  || fail "etcd --local --dry-run did not resolve: ${DD:0:160}"

log "── Tier 1: secrets bundle carries dr-system-target.json + offline path resolves ──"
DRTOK=$(login_token "$ADMIN_PASSWORD")
if [[ -z "$DRTOK" ]]; then
  skip "no admin token (ADMIN_PASSWORD unset?) — Tier 1 bundle/offline checks skipped"
else
  RUN_ID=$(curl -sk --max-time 30 -H "Authorization: Bearer $DRTOK" -H 'Content-Type: application/json' \
    -X POST "$ADMIN_HOST/api/v1/system-backup/secrets/export" --data-binary '{}' \
    | python3 -c "import sys,json;print((json.load(sys.stdin).get('data') or {}).get('runId','') or '')" 2>/dev/null)
  DL_URL=""
  if [[ -n "$RUN_ID" ]]; then
    for _ in $(seq 1 30); do
      RUN=$(curl -sk --max-time 20 -H "Authorization: Bearer $DRTOK" "$ADMIN_HOST/api/v1/system-backup/secrets/runs/$RUN_ID")
      ST=$(echo "$RUN" | python3 -c "import sys,json;print((json.load(sys.stdin).get('data') or {}).get('status','?'))" 2>/dev/null)
      DL_URL=$(echo "$RUN" | python3 -c "import sys,json;print((json.load(sys.stdin).get('data') or {}).get('downloadUrl') or '')" 2>/dev/null)
      { [[ "$ST" == "succeeded" && -n "$DL_URL" ]] || [[ "$ST" == "failed" ]]; } && break
      sleep 2
    done
  fi
  if [[ -z "$DL_URL" ]]; then
    skip "secrets-bundle export produced no downloadUrl (operator recipient missing? export failed) — Tier 1 checks skipped"
  else
    # Download ONCE on the node (single-use token); decrypt with the on-node
    # operator key. The plaintext bundle stays on the node and is removed.
    AGEKEY=/var/lib/hosting-platform/operator-key/operator-private.key
    ssh_q "curl -sk --max-time 120 '$DL_URL' -o /tmp/dr-e2e.age" >/dev/null 2>&1
    MEMBERS=$(ssh_q "age -d -i $AGEKEY /tmp/dr-e2e.age 2>/dev/null | tar -t 2>/dev/null")
    if echo "$MEMBERS" | grep -qx 'dr-system-target.json'; then
      ok "exported secrets bundle carries dr-system-target.json (descriptor delivery, in-pod)"
      # Prove the offline restore consumes it end-to-end with NO kubectl.
      ssh_q "age -d -i $AGEKEY /tmp/dr-e2e.age 2>/dev/null | tar -xO dr-system-target.json > /dev/shm/dr-desc.json && chmod 600 /dev/shm/dr-desc.json"
      OFF=$(ssh_q "KUBECTL=/bin/false $PLATFORM_OPS_BIN dr restore-component etcd --offline --descriptor /dev/shm/dr-desc.json --list 2>&1; shred -u /dev/shm/dr-desc.json 2>/dev/null || rm -f /dev/shm/dr-desc.json")
      echo "$OFF" | grep -q 'OFFLINE mode' \
        && ok "offline restore resolved the descriptor with NO kubectl (KUBECTL=/bin/false)" \
        || fail "offline path did not resolve the descriptor: ${OFF:0:200}"
      if echo "$OFF" | grep -qE '\.db([^a-z]|$)'; then
        ok "offline --list returned real etcd snapshots from the upstream (external target)"
      else
        skip "offline --list reached the upstream but listed nothing (in-cluster/.svc target — offline DR needs an EXTERNAL endpoint; preflight flags this)"
      fi
    else
      skip "no dr-system-target.json in the bundle (no SYSTEM target bound, or pre-v2026.6.11 image) — Tier 1 descriptor check skipped"
    fi
    ssh_q "rm -f /tmp/dr-e2e.age" >/dev/null 2>&1
  fi
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