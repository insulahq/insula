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
          drop_existing_seed_once_objects stamp_host_migration_baseline kctl \
          warn_on_even_etcd_members; do
  fn_body "$fn" >> "$WORK/helpers.sh"
  grep -q "^${fn}() {" "$WORK/helpers.sh" || { echo "FAIL: could not extract ${fn}() from $BOOTSTRAP" >&2; exit 1; }
done
grep -q '^JOIN_REJECTED_FLAGS=(' "$WORK/helpers.sh" || { echo "FAIL: JOIN_REJECTED_FLAGS not found" >&2; exit 1; }
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
# Fake curl honours `-o FILE` like the real one (the CA must be hashed raw).
printf '#!/usr/bin/env bash\nout=/dev/stdout\nwhile [[ $# -gt 0 ]]; do [[ "$1" == -o ]] && { out="$2"; shift; }; shift; done\nprintf %%s %q > "$out"\n' "$CA_PEM" > "$WORK/curl-ok/curl"
printf '#!/usr/bin/env bash\nexit 7\n' > "$WORK/curl-down/curl"
chmod +x "$WORK/curl-ok/curl" "$WORK/curl-down/curl"
run_preflight_with() {
  local curl_dir="$1" token="$2"
  (
    PATH="$curl_dir:$PATH"; K3S_SERVER_IP=192.0.2.4; K3S_TOKEN="$token"
    # shellcheck disable=SC1091
    source "$WORK/helpers.sh"
    run_join_preflight && echo PREFLIGHT_OK
  ) 2>&1
}
out=$(run_preflight_with "$WORK/curl-ok" "K10${CA_HASH}::server:secret"); rc=$?
check "token for THIS cluster passes" 0 "$rc"
has "$out" "matches its cluster CA" "…and says it verified the CA"
other=$(printf 'other' | sha256sum | awk '{print $1}')
out=$(run_preflight_with "$WORK/curl-ok" "K10${other}::server:secret"); rc=$?
check "token for ANOTHER cluster refused" 1 "$rc"
has "$out" "DIFFERENT cluster" "…with the reason"
out=$(run_preflight_with "$WORK/curl-down" "K10${CA_HASH}::server:secret"); rc=$?
check "unreachable join target refused before touching the host" 1 "$rc"
has "$out" "Pre-enrol THIS host" "…and points at pre-enrolment"
out=$(run_preflight_with "$WORK/curl-ok" "legacy-short-token"); rc=$?
check "non-K10 token: allowed" 0 "$rc"
has "$out" "cannot verify" "…but warns it could not be verified"

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
