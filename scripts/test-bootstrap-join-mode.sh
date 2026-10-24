#!/usr/bin/env bash
# TDD harness for bootstrap.sh's CREATE vs JOIN split.
# Run: ./scripts/test-bootstrap-join-mode.sh   (exit 0 = all pass)
#
# Why this exists: `--join-as server` used to both CREATE a cluster (no
# --server) and JOIN one (with --server), and a server join re-ran the whole
# cluster install against the live cluster. On production that
# rewrote the cluster config (Let's Encrypt STAGING certs on the panels),
# force-applied every seed-once object back to its default (CrowdSec community
# blocklist off, the platform DB's WAL archive redirected) and seeded a second
# super_admin. Every guard below is negative-tested on each arm: a guard that
# only ever passes proves nothing.
#
# The pure helpers are extracted from the SHIPPED script and run for real
# against stubs; call sites are asserted structurally (the repo's ci-*-check
# idiom), because main()/install_k3s_* cannot run outside a real host.
# Variables set in subshells are read by the SOURCED helpers, not this file.
# shellcheck disable=SC2034
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"

pass=0; fail=0
ok()    { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()   { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }
has()   { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else bad "$3 — not found: $2"; fi; }
hasnt() { if grep -qF -- "$2" <<<"$1"; then bad "$3 — unexpectedly found: $2"; else ok "$3"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fn_body() { sed -n "/^$1() {/,/^}/p" "$BOOTSTRAP"; }

# ── Extract the shipped helpers ─────────────────────────────────────────────
sed -n '/^JOIN_REJECTED_FLAGS=(/,/^)/p' "$BOOTSTRAP" > "$WORK/helpers.sh"
for fn in resolve_bootstrap_mode k3s_unit_has guard_bootstrap_target run_join_preflight \
          join_auth_header verify_join_credentials join_peers_from ensure_python3 \
          k3s_journal_errors fail_join clear_unfinished_join kubelet_ran_pods seed_firewall_sets \
          drop_existing_seed_once_objects stamp_host_migration_baseline kctl \
          warn_on_even_etcd_members; do
  fn_body "$fn" >> "$WORK/helpers.sh"
  grep -q "^${fn}() {" "$WORK/helpers.sh" || { echo "FAIL: could not extract ${fn}() from $BOOTSTRAP" >&2; exit 1; }
done
grep -q '^JOIN_REJECTED_FLAGS=(' "$WORK/helpers.sh" || { echo "FAIL: JOIN_REJECTED_FLAGS not found" >&2; exit 1; }
# The marker helpers are one-liners (fn_body matches multi-line bodies only).
grep -E '^marker_(exists|set|clear)\(\)' "$BOOTSTRAP" >> "$WORK/helpers.sh"
[[ "$(grep -cE '^marker_(exists|set|clear)\(\)' "$WORK/helpers.sh")" == 3 ]] || { echo "FAIL: marker helpers not found" >&2; exit 1; }
# error() is FATAL in bootstrap.sh and the guards rely on that — model it
# exactly, or a guard that falls through its own refusal would "pass" here.
cat >> "$WORK/helpers.sh" <<'STUB'
error()     { echo "ERROR: $*" >&2; exit 1; }
log()       { echo "LOG: $*"; }
warn()      { echo "WARN: $*" >&2; }
ui_ok()     { echo "OK: $*"; }
ui_warn()   { echo "UIWARN: $*"; }
ui_record() { printf '%s\n' "$*" >> "$UI_RECORD_FILE"; }
sleep()     { :; }
detect_local_ipv4() { printf '%s\n' "${FAKE_SELF_V4:-192.0.2.9}"; }
detect_local_ipv6() { printf '%s\n' "${FAKE_SELF_V6:-}"; }
journalctl() { printf '%s\n' 'time="x" level=error msg="etcd: learner never caught up"'; }
systemctl() { [[ "$1" == is-active ]] && { echo "${FAKE_UNIT_STATE:-failed}"; [[ "${FAKE_UNIT_STATE:-failed}" == active ]]; return; }; return 0; }
hostname()  { [[ "${1:-}" == -I ]] && echo "${FAKE_HOST_ADDRS:-192.0.2.9 10.0.0.9}"; return 0; }
nft()       { printf '%s\n' "$*" >> "${FAKE_NFT_LOG:-/dev/null}"; }
timeout()   { return 0; }
STUB

# run_mode <args…> — evaluate resolve_bootstrap_mode for a flag set.
# NAME=VALUE words set state; --flags are recorded as PASSED_FLAGS.
run_mode() {
  (
    NODE_ROLE=""; K3S_SERVER_IP=""; K3S_TOKEN=""; PLATFORM_DOMAIN=""; BOOTSTRAP_MODE=""
    PASSED_FLAGS=()
    for a in "$@"; do
      case "$a" in
        --*) PASSED_FLAGS+=("$a") ;;
        *=*) eval "${a%%=*}=\"\${a#*=}\"" ;;
      esac
    done
    # shellcheck disable=SC1091
    source "$WORK/helpers.sh"
    resolve_bootstrap_mode
    echo "MODE=${BOOTSTRAP_MODE} ROLE=${NODE_ROLE}"
  ) 2>&1
}

echo "── resolve_bootstrap_mode ──"
out=$(run_mode PLATFORM_DOMAIN=example.test --domain); rc=$?
check "create: no --join-as + --domain → create/server" "MODE=create ROLE=server" "$(tail -1 <<<"$out")"
check "create: exit 0" 0 "$rc"

out=$(run_mode); rc=$?
check "create without --domain refused" 1 "$rc"
has "$out" "Creating a new cluster requires --domain" "create without --domain says why"

out=$(run_mode NODE_ROLE=server --join-as PLATFORM_DOMAIN=example.test --domain); rc=$?
check "old first-server form (--join-as server, no --server) refused" 1 "$rc"
has "$out" "omit --join-as" "…and points at the create form"

out=$(run_mode NODE_ROLE=worker --join-as K3S_SERVER_IP=192.0.2.4 --server); rc=$?
check "join without --token refused" 1 "$rc"

out=$(run_mode NODE_ROLE=server --join-as K3S_TOKEN=K10x --token); rc=$?
check "join without --server refused" 1 "$rc"

out=$(run_mode NODE_ROLE=server --join-as K3S_SERVER_IP=192.0.2.4 --server K3S_TOKEN=t --token); rc=$?
check "server join: exit 0" 0 "$rc"
check "server join → join/server" "MODE=join ROLE=server" "$(tail -1 <<<"$out")"

out=$(run_mode NODE_ROLE=worker --join-as K3S_SERVER_IP=192.0.2.4 --server K3S_TOKEN=t --token \
        --allow-source --dual-stack --host-tenant-workloads --cluster-network-cidr --k3s-version); rc=$?
check "worker join with node-scoped flags accepted" 0 "$rc"
check "worker join → join/worker" "MODE=join ROLE=worker" "$(tail -1 <<<"$out")"

out=$(run_mode NODE_ROLE=server --join-as K3S_SERVER_IP=192.0.2.4 --server K3S_TOKEN=t --token \
        PLATFORM_DOMAIN=example.test --domain); rc=$?
check "join with --domain refused (the production incident)" 1 "$rc"
has "$out" "--domain" "…names the offending flag"

out=$(run_mode NODE_ROLE=worker --join-as K3S_SERVER_IP=192.0.2.4 --server K3S_TOKEN=t --token \
        --env --release-tag --secrets-bundle --env); rc=$?
check "join with several cluster flags refused" 1 "$rc"
has "$out" "--env --release-tag --secrets-bundle" "…lists each once, in order"

for f in --acme-email --calico-mtu --skip-flux --backup-target-s3-endpoint --pre-enroll-peer --stalwart-external-ip; do
  out=$(run_mode NODE_ROLE=server --join-as K3S_SERVER_IP=192.0.2.4 --server K3S_TOKEN=t --token "$f"); rc=$?
  check "join refuses ${f}" 1 "$rc"
done

out=$(run_mode K3S_SERVER_IP=192.0.2.4 --server PLATFORM_DOMAIN=example.test --domain); rc=$?
check "--server without --join-as refused" 1 "$rc"
has "$out" "require --join-as" "…says --join-as is required"

out=$(run_mode NODE_ROLE=master --join-as K3S_SERVER_IP=192.0.2.4 --server K3S_TOKEN=t --token); rc=$?
check "invalid --join-as value refused" 1 "$rc"

echo "── parse_args wiring (structural) ──"
pa="$(fn_body parse_args)"
has "$pa" '[[ "$1" == --* ]] && PASSED_FLAGS+=("$1")' "parse_args records every --flag"
first_mode=$(grep -n 'resolve_bootstrap_mode' <<<"$pa" | head -1 | cut -d: -f1)
first_hcw=$(grep -n 'if \[\[ -z "\$HOST_CLIENT_WORKLOADS" \]\]' <<<"$pa" | head -1 | cut -d: -f1)
if [[ -n "$first_mode" && -n "$first_hcw" && "$first_mode" -lt "$first_hcw" ]]; then
  ok "mode is resolved before role-dependent defaults read NODE_ROLE"
else
  bad "resolve_bootstrap_mode must run before the HOST_CLIENT_WORKLOADS default (mode@${first_mode:-?} hcw@${first_hcw:-?})"
fi

echo "── guard_bootstrap_target ──"
# run_guard <mode> <role> <unit-fixture…> — fixtures: agent | server:<flag>
run_guard() {
  local mode="$1" role="$2"; shift 2
  local dir; dir="$(mktemp -d "$WORK/units.XXXX")"
  local fx
  for fx in "$@"; do
    case "$fx" in
      agent)    echo "ExecStart=/usr/local/bin/k3s agent" > "$dir/k3s-agent.service" ;;
      server:*) printf 'ExecStart=/usr/local/bin/k3s \\\n\tserver \\\n\t%s \\\n' "'${fx#server:}'" > "$dir/k3s.service" ;;
    esac
  done
  (
    BOOTSTRAP_MODE="$mode"; NODE_ROLE="$role"; K3S_UNIT_DIR="$dir"
    # shellcheck disable=SC1091
    source "$WORK/helpers.sh"
    guard_bootstrap_target && echo GUARD_OK
  ) 2>&1
}
out=$(run_guard create server); check "create on a bare host allowed" 0 $?
out=$(run_guard create server "server:--cluster-init"); check "create re-run on its own first server allowed" 0 $?
out=$(run_guard create server agent); rc=$?
check "create on a WORKER host refused" 1 "$rc"
out=$(run_guard create server "server:--server=https://192.0.2.4:6443"); rc=$?
check "create on a JOINED server refused (a re-run there would re-install the platform)" 1 "$rc"
has "$out" "--join-as server" "…and tells the operator the join command to re-run"
out=$(run_guard join server "server:--cluster-init"); rc=$?
check "join on a cluster's FIRST server refused" 1 "$rc"
out=$(run_guard join server agent); rc=$?
check "server join on a worker host refused" 1 "$rc"
out=$(run_guard join worker "server:--server=https://192.0.2.4:6443"); rc=$?
check "worker join on a server host refused" 1 "$rc"
out=$(run_guard join server "server:--server=https://192.0.2.4:6443"); check "server join re-run allowed" 0 $?
out=$(run_guard join worker agent); check "worker join re-run allowed" 0 $?
out=$(run_guard join worker); check "worker join on a bare host allowed" 0 $?

echo "── run_join_preflight ──"
CA_PEM=$'-----BEGIN CERTIFICATE-----\nMIIBfakefakefake\n-----END CERTIFICATE-----\n'
CA_HASH=$(printf '%s' "$CA_PEM" | sha256sum | awk '{print $1}')
mkdir -p "$WORK/curl-ok" "$WORK/curl-down"
printf '%s' "$CA_PEM" > "$WORK/ca.pem"
# Fake curl: honours -o FILE and -w (the CA must be hashed raw). /cacerts serves
# the CA; the credential endpoints record the Authorization header curl read from
# stdin (-H @-) and answer FAKE_CODE with the body in FAKE_BODY_FILE.
cat > "$WORK/curl-ok/curl" <<'CURL'
#!/usr/bin/env bash
out=/dev/stdout; wfmt=""; url=""; hdr_stdin=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) wfmt="$2"; shift ;;
    -H) [[ "$2" == @- ]] && hdr_stdin=true; shift ;;
    https://*) url="$1" ;;
  esac
  shift
done
case "$url" in
  */cacerts) cat "$FAKE_CA_FILE" > "$out" ;;
  *)
    $hdr_stdin && cat > "$FAKE_AUTH_LOG"
    [[ -n "${FAKE_BODY_FILE:-}" ]] && cat "$FAKE_BODY_FILE" > "$out"
    [[ -n "$wfmt" ]] && printf '%b' "${wfmt//%\{http_code\}/${FAKE_CODE:-200}}"
    ;;
esac
exit 0
CURL
printf '#!/usr/bin/env bash\nexit 7\n' > "$WORK/curl-down/curl"
chmod +x "$WORK/curl-ok/curl" "$WORK/curl-down/curl"
printf '["192.0.2.4:6443","192.0.2.5:6443","[2001:db8::6]:6443"]' > "$WORK/apiservers.json"
# The /db/info answer of a 3-member cluster: the target, another server (v4 + v6
# peer URLs), and a member that never started under THIS host's address.
cat > "$WORK/dbinfo.json" <<'JSON'
{"members":[{"ID":11,"name":"s1-aaaa","peerURLs":["https://192.0.2.4:2380"],"clientURLs":["https://192.0.2.4:2379"]},{"ID":12,"name":"s2-bbbb","peerURLs":["https://192.0.2.5:2380","https://[2001:db8::5]:2380"]},{"ID":13,"peerURLs":["https://192.0.2.9:2380"],"isLearner":true},{"ID":14,"name":"evil","peerURLs":["https://1.2.3.4;reboot:2380"]}]}
JSON
run_preflight_with() {
  local curl_dir="$1" token="$2" role="${3:-server}"
  rm -f "$WORK/auth.log"; rm -rf "$WORK/k3sdata"; mkdir -p "$WORK/k3sdata"
  [[ "${FAKE_LOCAL_ETCD:-}" == 1 ]] && mkdir -p "$WORK/k3sdata/server/db/etcd/member"
  (
    PATH="$curl_dir:$PATH"; K3S_SERVER_IP=192.0.2.4; K3S_TOKEN="$token"; NODE_ROLE="$role"
    K8S_NODE_NAME=newnode; K3S_DATA_DIR="$WORK/k3sdata"
    export FAKE_CA_FILE="$WORK/ca.pem" FAKE_AUTH_LOG="$WORK/auth.log"
    export FAKE_CODE="${FAKE_CODE:-200}" FAKE_BODY_FILE="${FAKE_BODY_FILE-$WORK/dbinfo.json}"
    # shellcheck disable=SC1091
    source "$WORK/helpers.sh"
    run_join_preflight && echo "PREFLIGHT_OK v4=[${JOIN_PEERS_V4[*]}] v6=[${JOIN_PEERS_V6[*]}]"
  ) 2>&1
}
out=$(run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::server:secret"); rc=$?
check "token for THIS cluster passes" 0 "$rc"
has "$out" "matches its cluster CA" "…and says it verified the CA"
has "$out" "accepts --token as a server token" "…and that the target accepted the secret"
has "$out" "PREFLIGHT_OK v4=[192.0.2.4 192.0.2.5] v6=[2001:db8::5]" "…learning every etcd member's address (v4 + v6) to admit"
hasnt "$out" "1.2.3.4" "…ignoring a peer host that is not a bare IP"
has "$out" "never started" "…and taking over its own never-started member"
check "server token goes as basic auth server:<secret>, via stdin" \
  "Authorization: Basic $(printf 'server:secret' | base64)" "$(cat "$WORK/auth.log")"
other=$(printf 'other' | sha256sum | awk '{print $1}')
out=$(run_preflight_with "$WORK/curl-ok" "K10${other}::server:secret"); rc=$?
check "token for ANOTHER cluster refused" 1 "$rc"
has "$out" "DIFFERENT cluster" "…with the reason"
out=$(run_preflight_with "$WORK/curl-down" "K10${CA_HASH}::server:secret"); rc=$?
check "unreachable join target refused before touching the host" 1 "$rc"
has "$out" "Pre-enrol THIS host" "…and points at pre-enrolment"
out=$(FAKE_CODE=401 run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::server:wrong"); rc=$?
check "right cluster, wrong secret: refused before anything is installed" 1 "$rc"
has "$out" "does not accept --token as a SERVER token (HTTP 401)" "…naming the cause"
has "$out" "/var/lib/rancher/k3s/server/token on any server" "…and where the right one is"
out=$(FAKE_CODE=403 run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::node:agentsecret"); rc=$?
check "the worker (agent) token on a server join: refused" 1 "$rc"
has "$out" "or it is the worker (agent) token" "…saying so"
out=$(FAKE_CODE=500 run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::server:secret"); rc=$?
check "a target that cannot confirm the token: refused" 1 "$rc"
has "$out" "join through another server" "…pointing at another server"
cat > "$WORK/dbinfo-stale.json" <<'JSON'
{"members":[{"ID":11,"name":"s1-aaaa","peerURLs":["https://192.0.2.4:2380"]},{"ID":77,"name":"new-cccc","peerURLs":["https://192.0.2.9:2380"],"isLearner":true}]}
JSON
out=$(FAKE_BODY_FILE="$WORK/dbinfo-stale.json" run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::server:secret"); rc=$?
check "a started etcd member under this host's address, on a wiped host: refused up front" 1 "$rc"
has "$out" "etcd member new-cccc (192.0.2.9), a learner" "…naming the member"
has "$out" "member ID 77" "…with the ID to remove"
out=$(FAKE_LOCAL_ETCD=1 FAKE_BODY_FILE="$WORK/dbinfo-stale.json" run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::server:secret"); rc=$?
check "re-running the join on a joined server (its own etcd data here): not refused" 0 "$rc"
hasnt "$out" "Remove that member" "…and never told to remove its own healthy member"
has "$out" "v4=[192.0.2.4]" "…and its own address is not admitted as a peer"
cat > "$WORK/dbinfo-renamed.json" <<'JSON'
{"members":[{"ID":11,"name":"s1-aaaa","peerURLs":["https://192.0.2.4:2380"]},{"ID":78,"name":"newnode-0a1b2c3d","peerURLs":["https://192.0.2.77:2380"]}]}
JSON
out=$(FAKE_BODY_FILE="$WORK/dbinfo-renamed.json" run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::server:secret"); rc=$?
check "a started member under this node's NAME at another address (replaced VPS): refused" 1 "$rc"
has "$out" "etcd member newnode-0a1b2c3d (192.0.2.77)" "…naming it (k3s matches by name, not address)"
cat > "$WORK/dbinfo-private.json" <<'JSON'
{"members":[{"ID":11,"name":"s1-aaaa","peerURLs":["https://10.0.0.4:2380"]},{"ID":79,"name":"other-0a1b2c3d","peerURLs":["https://10.0.0.9:2380"]}]}
JSON
out=$(FAKE_BODY_FILE="$WORK/dbinfo-private.json" run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::server:secret"); rc=$?
check "a started member at this host's PRIVATE-underlay address: refused (not just the default-route IP)" 1 "$rc"
out=$(FAKE_BODY_FILE="$WORK/apiservers.json" run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::server:secret" worker); rc=$?
check "a worker joining with the SERVER token: accepted" 0 "$rc"
check "…sent as node:<secret>, the user k3s's agent forces" \
  "Authorization: Basic $(printf 'node:secret' | base64)" "$(cat "$WORK/auth.log")"
out=$(run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::node:same"); rc=$?
check "a server join with a node: token is sent as server:<secret>, as k3s does" \
  "Authorization: Basic $(printf 'server:same' | base64)" "$(cat "$WORK/auth.log")"
out=$(run_preflight_with "$WORK/curl-ok" "barepassword"); rc=$?
check "non-K10 token: allowed" 0 "$rc"
has "$out" "cannot verify" "…but warns it could not check the CA"
check "bare password: basic auth as user server, like k3s" \
  "Authorization: Basic $(printf 'server:barepassword' | base64)" "$(cat "$WORK/auth.log")"
out=$(FAKE_BODY_FILE="$WORK/apiservers.json" run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::abcdef.0123456789abcdef" worker); rc=$?
check "worker bootstrap token accepted" 0 "$rc"
check "bootstrap token goes as Bearer, like k3s" "Authorization: Bearer abcdef.0123456789abcdef" "$(cat "$WORK/auth.log")"
has "$out" "PREFLIGHT_OK v4=[192.0.2.4 192.0.2.5] v6=[2001:db8::6]" "…learning every API server to admit"
out=$(FAKE_CODE=401 FAKE_BODY_FILE="$WORK/apiservers.json" run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::abcdef.0123456789abcdef" worker); rc=$?
check "expired worker token refused before anything is installed" 1 "$rc"
has "$out" "expired or revoked" "…saying why"

echo "── seed_firewall_sets admits the reported peers ──"
out=$(
  FAKE_NFT_LOG="$WORK/nft.log"; rm -f "$FAKE_NFT_LOG"
  K3S_SERVER_IP=192.0.2.4; JOIN_PEERS_V4=(192.0.2.5 192.0.2.6); JOIN_PEERS_V6=(2001:db8::5)
  PRE_ENROLL_PEERS_V4=(); PRE_ENROLL_PEERS_V6=(); ALLOW_SOURCE_LIST_V4=(); ALLOW_SOURCE_LIST_V6=()
  # shellcheck disable=SC1091
  source "$WORK/helpers.sh"
  seed_firewall_sets >/dev/null 2>&1
  cat "$FAKE_NFT_LOG"
)
has "$out" "add element inet filter cluster_peers_v4 { 192.0.2.4 }" "the join target is admitted"
has "$out" "add element inet filter cluster_peers_v4 { 192.0.2.5 }" "…and every other v4 peer"
has "$out" "add element inet filter cluster_peers_v4 { 192.0.2.6 }" "…all of them"
has "$out" "add element inet filter cluster_peers_v6 { 2001:db8::5 }" "…and the v6 peers"

echo "── clear_unfinished_join / fail_join ──"
# run_cleanup <fn> <role> NAME=VALUE… — a fake host: markers, an etcd data dir
# and uninstall scripts that record they ran.
run_cleanup() {
  local fn="$1" role="$2"; shift 2
  rm -rf "$WORK/host"; mkdir -p "$WORK/host/markers" "$WORK/host/bin" "$WORK/host/data"
  for s in k3s-uninstall.sh k3s-agent-uninstall.sh; do
    printf '#!/usr/bin/env bash\necho %s >> %q\n' "$s" "$WORK/host/uninstalled" > "$WORK/host/bin/$s"
    chmod +x "$WORK/host/bin/$s"
  done
  (
    NODE_ROLE="$role"; BOOTSTRAP_MODE=join; K3S_FRESH_INSTALL=false
    MARKER_DIR="$WORK/host/markers"; K3S_BIN_DIR="$WORK/host/bin"; K3S_DATA_DIR="$WORK/host/data"
    KUBELET_DIR="$WORK/host/kubelet"
    for a in "$@"; do
      case "$a" in
        marker:*) touch "$MARKER_DIR/.${a#marker:}" ;;
        etcd-started) mkdir -p "$K3S_DATA_DIR/server/db/etcd/member" ;;
        pods-ran) mkdir -p "$KUBELET_DIR/pods/0f0e-pod" ;;
        no-k3s) rm -f "$K3S_BIN_DIR"/*.sh ;;
        *=*) eval "${a%%=*}=\"\${a#*=}\""; export "${a%%=*}" ;;
      esac
    done
    # shellcheck disable=SC1091
    source "$WORK/helpers.sh"
    if [[ "$fn" == fail_join ]]; then fail_join "k3s did not join"; else "$fn" && echo CLEANUP_OK; fi
  ) 2>&1
}
uninstalled() { cat "$WORK/host/uninstalled" 2>/dev/null; }
out=$(run_cleanup clear_unfinished_join server no-k3s); rc=$?
check "no k3s on the host: nothing to clear" 0 "$rc"
out=$(run_cleanup clear_unfinished_join server marker:join-in-progress FAKE_UNIT_STATE=active); rc=$?
check "unfinished marker but k3s is running (the join finished): continue" 0 "$rc"
check "…without uninstalling" "" "$(uninstalled)"
check "…and the marker is cleared" "" "$(ls -A "$WORK/host/markers")"
out=$(run_cleanup clear_unfinished_join server marker:join-in-progress); rc=$?
check "unfinished join, etcd never started: cleared" 0 "$rc"
check "…by uninstalling k3s" "k3s-uninstall.sh" "$(uninstalled)"
check "…and clearing the marker" "" "$(ls -A "$WORK/host/markers")"
out=$(run_cleanup clear_unfinished_join worker marker:join-in-progress); rc=$?
check "unfinished worker join: cleared with the agent uninstaller" "k3s-agent-uninstall.sh" "$(uninstalled)"
out=$(run_cleanup clear_unfinished_join server marker:join-in-progress etcd-started); rc=$?
check "unfinished join whose etcd started: refused" 1 "$rc"
check "…never uninstalling (the cluster may list it as a member)" "" "$(uninstalled)"
has "$out" "A server join that did not finish" "…pointing at the runbook"
out=$(run_cleanup clear_unfinished_join server); rc=$?
check "k3s installed but down, no record of any join (older CLI leftover): refused" 1 "$rc"
check "…without uninstalling" "" "$(uninstalled)"
has "$out" "never joined the cluster" "…explaining both cases"
out=$(run_cleanup clear_unfinished_join server marker:bootstrap-complete); rc=$?
check "k3s down on a node that finished its join before: left to re-converge" 0 "$rc"
check "…untouched" "" "$(uninstalled)"
out=$(run_cleanup fail_join server K3S_FRESH_INSTALL=true marker:join-in-progress); rc=$?
check "failed fresh join: fatal" 1 "$rc"
check "…and k3s is removed again" "k3s-uninstall.sh" "$(uninstalled)"
has "$out" "removed again" "…saying a re-run starts clean"
has "$out" "learner never caught up" "…after showing what k3s said"
check "…marker cleared" "" "$(ls -A "$WORK/host/markers")"
out=$(run_cleanup fail_join server K3S_FRESH_INSTALL=true etcd-started); rc=$?
check "failed join whose etcd started: k3s left in place" "" "$(uninstalled)"
has "$out" "may list it as an etcd member" "…saying why"
out=$(run_cleanup fail_join server K3S_FRESH_INSTALL=false); rc=$?
check "k3s installed before this run: never removed" "" "$(uninstalled)"
out=$(run_cleanup fail_join worker K3S_FRESH_INSTALL=true); rc=$?
check "failed fresh worker join: the agent is removed again" "k3s-agent-uninstall.sh" "$(uninstalled)"
out=$(run_cleanup clear_unfinished_join worker marker:join-in-progress pods-ran); rc=$?
check "unfinished worker join whose kubelet later ran pods: refused" 1 "$rc"
check "…never uninstalling a node that may carry workloads" "" "$(uninstalled)"
out=$(run_cleanup fail_join worker K3S_FRESH_INSTALL=true pods-ran); rc=$?
check "failed worker join whose kubelet ran pods: the agent is left in place" "" "$(uninstalled)"

echo "── drop_existing_seed_once_objects ──"
if command -v yq >/dev/null 2>&1 && yq --version 2>/dev/null | grep -q mikefarah; then
  cat > "$WORK/rendered.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: plain
  namespace: platform
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: crowdsec-capi-config
  namespace: crowdsec
  annotations:
    kustomize.toolkit.fluxcd.io/reconcile: disabled
data:
  DISABLE_ONLINE_API: "true"
---
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: brand-new
  namespace: platform
  annotations:
    kustomize.toolkit.fluxcd.io/reconcile: disabled
YAML
  # Stub kctl: the CAPI ConfigMap exists, the ObjectStore does not.
  run_drop() {
    local mode="$1"
    cp "$WORK/rendered.yaml" "$WORK/r.yaml"
    (
      # shellcheck disable=SC1091
      source "$WORK/helpers.sh"
      kctl() {
        case "$*" in
          *crowdsec-capi-config*) echo "configmap/crowdsec-capi-config" ;;
          *brand-new*)
            if [[ "$mode" == broken ]]; then echo "Unable to connect to the server: timeout"; return 1; fi
            echo 'Error from server (NotFound): objectstores "brand-new" not found'; return 1 ;;
        esac
      }
      drop_existing_seed_once_objects "$WORK/r.yaml" && echo DROP_OK
    ) 2>&1
  }
  out=$(run_drop normal); rc=$?
  check "seed-once filter runs" 0 "$rc"
  kept=$(yq -N '.kind + "/" + .metadata.name' "$WORK/r.yaml" | tr '\n' ' ')
  check "existing seed-once dropped, absent one + normal object kept" "ConfigMap/plain ObjectStore/brand-new " "$kept"
  has "$out" "leaving the live object alone" "…and logs what it left alone"
  out=$(run_drop broken); rc=$?
  check "lookup error (not NotFound) fails CLOSED" 1 "$rc"
  # yq itself failing must not read as "no seed-once objects" (fail OPEN would
  # force-apply the whole stream — the incident).
  mkdir -p "$WORK/yq-broken"
  printf '#!/usr/bin/env bash\necho "yq: boom" >&2\nexit 1\n' > "$WORK/yq-broken/yq"
  chmod +x "$WORK/yq-broken/yq"
  out=$(PATH="$WORK/yq-broken:$PATH" run_drop normal); rc=$?
  check "yq failure fails CLOSED" 1 "$rc"
  has "$out" "refusing to apply" "…and says why"
else
  bad "mikefarah yq not on PATH — seed-once filter untested (install yq v4)"
fi

echo "── stamp_host_migration_baseline ──"
mkdir -p "$WORK/rel/platform" "$WORK/cli"
echo "2026.10.3" > "$WORK/rel/platform/VERSION"
printf '#!/usr/bin/env bash\necho "$*" >> %q\n' "$WORK/cli.calls" > "$WORK/cli/insula"
chmod +x "$WORK/cli/insula"
run_stamp() {
  ( K3S_FRESH_INSTALL="$1"; PLATFORM_OPS_BIN="$WORK/cli/insula"
    # shellcheck disable=SC1091
    source "$WORK/helpers.sh"; stamp_host_migration_baseline "$WORK/rel" ) >/dev/null 2>&1
}
rm -f "$WORK/cli.calls"; run_stamp false
check "re-run over an existing node: no baseline" "" "$(cat "$WORK/cli.calls" 2>/dev/null)"
rm -f "$WORK/cli.calls"; run_stamp true
check "fresh node: baseline up to this release" "host-config baseline --up-to 2026.10.3" "$(cat "$WORK/cli.calls" 2>/dev/null)"

echo "── kctl transcript redaction ──"
UI_RECORD_FILE="$WORK/record.txt"; export UI_RECORD_FILE
( # shellcheck disable=SC1091
  source "$WORK/helpers.sh"
  KUBECONFIG=/dev/null
  kubectl() { echo "secret/x created"; }
  # kctl only records when stdout is a TTY; force that branch.
  eval "$(declare -f kctl | sed 's/\[\[ -t 1 \]\]/true/')"
  kctl create secret generic x --from-literal=ADMIN_PASSWORD=s3cr3t --from-literal=K=v2 \
    "--from-literal=PHRASE=correct horse battery" >/dev/null
)
rec="$(cat "$WORK/record.txt" 2>/dev/null)"
hasnt "$rec" "s3cr3t" "secret value never reaches the transcript"
hasnt "$rec" "horse" "a value with spaces is redacted whole"
has "$rec" "--from-literal=ADMIN_PASSWORD=<redacted>" "…the key stays readable"

echo "── warn_on_even_etcd_members ──"
run_etcd() { # <kubectl behaviour: nodes:N | fail>
  ( # shellcheck disable=SC1091
    source "$WORK/helpers.sh"; KUBECONFIG=/dev/null
    STUB_NODES="${1#nodes:}"
    case "$1" in
      fail) kubectl() { return 1; } ;;
      *)    kubectl() { local i; for ((i = 0; i < STUB_NODES; i++)); do echo "node$i Ready"; done; } ;;
    esac
    set -euo pipefail   # bootstrap.sh runs under errexit + pipefail
    warn_on_even_etcd_members
    echo "RETURNED"
  ) 2>&1
}
out=$(run_etcd nodes:2); rc=$?
check "2 etcd members: returns" 0 "$rc"
has "$out" "EITHER one going down stops the control plane" "2 members: the 2-server warning"
out=$(run_etcd nodes:3)
hasnt "$out" "UIWARN" "3 members: no warning"
out=$(run_etcd fail); rc=$?
check "kubectl failure never aborts a completed join" 0 "$rc"
has "$out" "RETURNED" "…the caller continues"

echo "── join paths never touch cluster state (structural) ──"
CLUSTER_SCOPED=(install_calico install_traefik install_cert_manager install_sealed_secrets
  install_longhorn install_cnpg install_flux import_secrets_bundle generate_platform_secrets
  generate_crowdsec_bouncer_key generate_crowdsec_agent_credentials generate_platform_api_bouncer_key
  pin_system_components_to_servers create_platform_configmap generate_operator_recipient
  apply_platform_manifests seed_cluster_trusted_range_crs seed_cluster_pending_peer_crs
  bootstrap_stalwart_v016 create_roundcube_db set_default_archive_timeout
  harden_database_connect_acls provision_stalwart_master_user bundle_bootstrap_secrets
  verify verify_install configure_backup_target_s3 run_post_install_smoke)
for fn in run_join_server run_join_worker; do
  body="$(fn_body "$fn")"
  [[ -n "$body" ]] || { bad "${fn}() not found"; continue; }
  leaks=""
  for c in "${CLUSTER_SCOPED[@]}"; do
    grep -qE "^[[:space:]]*${c}([[:space:]]|$)" <<<"$body" && leaks+="${c} "
  done
  check "${fn} calls no cluster-scoped step" "" "$leaks"
done
create_body="$(fn_body run_create_cluster)"
has "$create_body" "apply_platform_manifests" "create still installs the platform"
main_body="$(fn_body main)"
has "$main_body" "guard_bootstrap_target" "main guards the target before changing the host"
has "$main_body" "run_join_preflight" "main runs the join preflight"
hasnt "$(fn_body install_k3s_server)" '--token=${K3S_TOKEN}' "server join token is not a command-line argument"
has "$(fn_body install_k3s_server)" 'K3S_TOKEN="$K3S_TOKEN"' "…it rides in K3S_TOKEN (root-only env file)"

echo "── re-run safety (structural) ──"
apm="$(fn_body apply_platform_manifests)"
has "$apm" 'not re-applying manifests from this checkout' "established + Flux: no direct apply"
has "$apm" "sed 's/\\\$\\\$/\$/g'" "render unescapes \$\$ like Flux postBuild"
has "$apm" 'Keeping the live CLUSTER_ISSUER_NAME' "re-run keeps the live issuer"
gps="$(fn_body generate_platform_secrets)"
has "$gps" 'Platform already installed — not seeding a bootstrap admin' "no admin seed on an installed platform"
seed_block="$(sed -n '/platform-admin-seed &>\/dev\/null/,/^  fi$/p' <<<"$gps")"
[[ -n "$seed_block" ]] || bad "admin seed block not found in generate_platform_secrets"
hasnt "$seed_block" '--from-literal=' "admin seed password never on a command line"
hasnt "$seed_block" 'Login: $admin_email / $admin_password' "admin seed password never printed to the transcript"
pin="$(fn_body pin_system_components_to_servers)"
hasnt "$pin" 'topologySpreadConstraints' "bootstrap no longer patches Flux-owned topology spread"

echo "── failed / unfinished joins (structural) ──"
ik="$(fn_body install_k3s)"
has "$ik" '"$BOOTSTRAP_MODE" == "join" ]] && clear_unfinished_join' "a join clears an unfinished earlier join before the version check"
[[ "$(grep -n 'clear_unfinished_join' <<<"$ik" | head -1 | cut -d: -f1)" -lt "$(grep -n 'Correct version, skipping' <<<"$ik" | cut -d: -f1)" ]] \
  && ok "…BEFORE 'Correct version, skipping' can keep the old token" || bad "clear_unfinished_join must run before the skip"
has "$ik" 'marker_set join-in-progress' "a fresh join is marked unfinished until it finishes"
has "$ik" 'marker_clear join-in-progress' "…and unmarked after"
has "$(fn_body install_k3s_server)" 'fail_join "k3s did not join the cluster' "a server join that times out goes through fail_join"
has "$(fn_body install_k3s_worker)" 'fail_join "k3s-agent did not join the cluster' "a worker join that times out goes through fail_join"
hasnt "$(fn_body install_k3s_server)" 'This is expected when joining' "no more 'expected, peers have not pre-enrolled you' after a passed preflight"
sfs="$(fn_body seed_firewall_sets)"
has "$sfs" 'JOIN_PEERS_V4[@]' "the new node admits every v4 peer the target reported"
has "$sfs" 'JOIN_PEERS_V6[@]' "…and every v6 peer"
has "$(fn_body run_join_preflight)" 'verify_join_credentials "$ca_file"' "the preflight checks the token's secret"
vjc="$(fn_body verify_join_credentials)"
has "$vjc" 'join_auth_header | curl' "…with the credentials on stdin"
hasnt "$(grep -A1 'curl -sS' <<<"$vjc")" ' -u ' "…never as curl -u (a command line every ps shows)"

echo "── Flux-equivalence assumption behind the \$\$ unescape ──"
KUBECTL_BIN="$(command -v kubectl 2>/dev/null || true)"
if [[ -n "$KUBECTL_BIN" ]] && command -v yq >/dev/null 2>&1; then
  for ov in production staging development; do
    [[ -d "$REPO_ROOT/k8s/overlays/$ov" ]] || continue
    n=$("$KUBECTL_BIN" kustomize "$REPO_ROOT/k8s/overlays/$ov" 2>/dev/null \
        | yq -N 'select(.metadata.annotations["kustomize.toolkit.fluxcd.io/substitute"] == "disabled")' \
        | grep -c '\$\$' || true)
    check "${ov}: substitute-disabled objects carry no \$\$ (bootstrap's global unescape matches Flux)" 0 "${n:-0}"
  done
else
  echo "  SKIP kubectl/yq not on PATH — Flux-equivalence assumption not re-checked"
fi

echo
echo "join-mode: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
