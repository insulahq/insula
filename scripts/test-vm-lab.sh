#!/usr/bin/env bash
# scripts/test-vm-lab.sh — unit tests for the retained VM lab's pure logic
# (scripts/vm-integration-tests/lib/lab-*.sh, lib/mirrors.sh). No libvirt, no VMs.
#
# The cloud-init seeds are the part most worth guarding: a seed that is not valid
# YAML does not fail loudly — cloud-init skips it and the VM boots with no key, no
# resolver and no services, which surfaces minutes later as "no ssh".
# Checks are single-quoted on purpose (evaluated by check()); the LAB_* settings are
# read by the sourced libraries, some indirectly.
# `check-cmd && ok … || bad …` is safe: ok() always succeeds.
# Stubs defined inside subshells are called indirectly (SC2317).
# shellcheck disable=SC2016,SC2034,SC2015,SC2317
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/scripts/vm-integration-tests/lib"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "PASS $1"; pass=$((pass + 1)); }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

python3 -c 'import yaml' 2>/dev/null || { echo "test-vm-lab: python3 yaml module required (pip install pyyaml)" >&2; exit 2; }
yaml_ok() { python3 -c 'import sys,yaml; d=yaml.safe_load(open(sys.argv[1])); assert isinstance(d, dict)' "$1" 2>/dev/null; }

# shellcheck source=/dev/null
source "$LIB/os-registry.sh"
VMTEST_DRIVER=ssh-host; VMTEST_HOST_SSH=root@lab-host.example.test   # driver.sh refuses to load without a driver
# shellcheck source=/dev/null
for l in driver mirrors lab-net lab-state lab-svc lab-cluster lab-install lab-api lab-worker lab-smoke; do source "$LIB/$l.sh"; done

LAB_APEX=lab.example.test LAB_SVC_NET=10.98.100 LAB_DEV_NET=10.98.110 LAB_STG_NET=10.98.120
LAB_UPSTREAM_DNS=192.0.2.53 LAB_STATE_FILE="$T/state.env"
LAB_DEV_VCPU=2 LAB_DEV_RAM_MB=1024 LAB_DEV_DISK_GB=10

# ── addressing ──
check "lab_mac encodes network + host octet" '[[ "$(lab_mac 10.98.110 11)" == 52:54:00:6e:00:0b ]]'
check "lab_mac differs across networks for the same host" '[[ "$(lab_mac 10.98.110 11)" != "$(lab_mac 10.98.120 11)" ]]'
check "svc address and lab range" '[[ "$(lab_svc_ip)" == 10.98.100.10 && "$(lab_range)" == 10.98.0.0/16 ]]'
check "ACME directory is a NAME in the lab zone" '[[ "$(lab_acme_directory)" == https://ca.lab.example.test/acme/acme/directory ]]'
check "a run id maps to its run network" '[[ "$(_vm_net_name 19f11867)" == insula-test-19f11867 ]]'
check "a lab network name passes through" '[[ "$(_vm_net_name insula-lab-dev)" == insula-lab-dev ]]'

# ── state ──
lab_state_set ODD "a b'c\"d\$e"
check "state file is 0600" '[[ "$(stat -c %a "$LAB_STATE_FILE")" == 600 ]]'
check "state round-trips shell metacharacters" '( unset ODD; lab_state_load; [[ "$ODD" == "a b'"'"'c\"d\$e" ]] )'
s1="$(lab_state_secret SEC 24)"; s2="$(lab_state_secret SEC 24)"
check "a secret is generated once, then kept" '[[ ${#s1} == 24 && "$s1" == "$s2" ]]'
lab_state_set ODD replaced
check "set replaces, never duplicates" '[[ $(grep -c "^ODD=" "$LAB_STATE_FILE") == 1 ]]'
check "get reads a stored value" '[[ "$(lab_state_get ODD)" == replaced ]]'
check "get of an unset name is empty" '[[ -z "$(lab_state_get NEVER_SET)" ]]'

# ── OS draw ──
a="$(lab_node_os lab-dev-1)"; b="$(lab_node_os lab-dev-1)"
check "a node's OS is drawn once and kept" '[[ -n "$a" && "$a" == "$b" ]] && os_known "$a"'
check "the default pool is every pinned OS" '[[ " $(os_pool_all) " == *" $a "* ]]'
c="$(LAB_NODE_OS=rocky-9 lab_node_os lab-stg-s1)"; d="$(LAB_NODE_OS=rocky-9 lab_node_os lab-dev-1)"
check "LAB_NODE_OS pins NEW nodes only" '[[ "$c" == rocky-9 && "$d" == "$a" ]]'
check "an unknown OS is refused" '! ( LAB_NODE_OS=no-such-os lab_node_os lab-x-1 ) 2>/dev/null'
draws="$(for i in $(seq 1 12); do LAB_NODE_OS_POOL="ubuntu-24.04 alma-9" lab_node_os "lab-p-$i"; echo; done | sort -u | xargs)"
check "the pool restricts the draw" '[[ "$draws" == "alma-9 ubuntu-24.04" || "$draws" == alma-9 || "$draws" == ubuntu-24.04 ]]'

# ── cluster definitions ──
check "staging refuses to exist without a release tag" '! ( LAB_STG_RELEASE_TAG= lab_cluster_def stg ) 2>/dev/null'
LAB_STG_VCPU=4 LAB_STG_RAM_MB=6144 LAB_STG_DISK_GB=60
( LAB_STG_RELEASE_TAG=v2026.10.6 LAB_STG_SERVERS=3; lab_cluster_def stg
  [[ "$CL_ENV" == production && "$CL_RELEASE_TAG" == v2026.10.6 && "$CL_AUTOSTART" == 0 \
     && "${CL_NODES[*]}" == "lab-stg-s1 11 lab-stg-s2 12 lab-stg-s3 13" && "$CL_APEX" == stg.lab.example.test ]] ) \
  && ok "staging: production mode at its release, 3 servers, on demand" || bad "staging definition"
( LAB_STG_RELEASE_TAG=v2026.10.6 LAB_STG_SERVERS=1; lab_cluster_def stg; [[ ${#CL_NODES[@]} == 1 ]] ) \
  && ok "LAB_STG_SERVERS sizes staging" || bad "LAB_STG_SERVERS"
( lab_cluster_def dev; [[ "$CL_ENV" == dev && -z "$CL_RELEASE_TAG" && "$CL_AUTOSTART" == 1 && "${CL_NODES[*]}" == "lab-dev-1 11" ]] ) \
  && ok "dev: this checkout, always on, one node" || bad "dev definition"
( lab_cluster_def dev; [[ -z "$CL_WORKER" ]] ) && ok "dev has no worker" || bad "dev worker"
( LAB_STG_RELEASE_TAG=v2026.10.6 LAB_STG_SERVERS=3; lab_cluster_def stg
  [[ "$CL_WORKER" == "lab-stg-w1 21" && "$CL_W_VCPU" == 4 && "$CL_W_RAM" == 6144 && "$CL_W_DISK" == 40 ]] ) \
  && ok "staging's worker: lab-stg-w1 at .21, default size" || bad "staging worker definition"
( LAB_STG_RELEASE_TAG=v2026.10.6 LAB_STG_WORKER_RAM_MB=4096; lab_cluster_def stg; [[ "$CL_W_RAM" == 4096 ]] ) \
  && ok "LAB_STG_WORKER_RAM_MB sizes the worker" || bad "worker sizing"

# ── DEV and staging take turns on the host ──
turns() {   # <running VMs> <paused marker> <fn> → the cluster calls the fn made, then the marker
  : > "$T/calls"
  ( VIRSH() { [[ "$1" == list ]] && tr ' ' '\n' <<<"$RUNNING"; return 0; }
    lab_cluster_down() { echo "down $1" >> "$T/calls"; }
    lab_cluster_up() { echo "up $1" >> "$T/calls"; }
    RUNNING="$1"; lab_state_set LAB_DEV_PAUSED_FOR_STG "$2"
    "$3" 2>/dev/null; cat "$T/calls"; echo "paused=$(lab_state_get LAB_DEV_PAUSED_FOR_STG)" ) | xargs
}
check "up stg stops a running DEV and remembers it" '[[ "$(turns "lab-svc lab-dev-1" 0 lab_dev_yield)" == "down dev paused=1" ]]'
check "up stg leaves a stopped DEV alone" '[[ "$(turns "lab-svc" 0 lab_dev_yield)" == "paused=0" ]]'
check "down stg starts the DEV it stopped" '[[ "$(turns "lab-svc" 1 lab_dev_resume)" == "up dev paused=0" ]]'
check "down stg does not start a DEV it never stopped" '[[ "$(turns "lab-svc" 0 lab_dev_resume)" == "paused=0" ]]'
check "staging counts as running from any of its VMs" '( VIRSH() { printf "lab-svc\nlab-stg-s2\n"; }; _lab_running stg && ! _lab_running dev )'

# ── the join script's one operator edit (lab_join_script_cidr) ──
cat > "$T/join-private.sh" <<'JOIN'
(
set -eu
# This cluster's servers are pinned to a private network (bootstrapped with
# --cluster-network-cidr; their InternalIP differs from their ExternalIP). The
# cluster does not record that CIDR: append the SAME --cluster-network-cidr <cidr>
# to the insula bootstrap line below before running it.
insula bootstrap --join-as worker --server '10.98.120.11' --token 'K10abc::tok'
)
JOIN
grep -v '^#' "$T/join-private.sh" > "$T/join-public.sh"; cp "$T/join-public.sh" "$T/join-public.orig"
lab_join_script_cidr "$T/join-private.sh" 10.98.120.0/24 2>/dev/null
check "the private-network note gets the cluster CIDR on the join line" \
  'grep -qx "insula bootstrap --join-as worker --server '"'"'10.98.120.11'"'"' --token '"'"'K10abc::tok'"'"' --cluster-network-cidr 10.98.120.0/24" "$T/join-private.sh"'
check "the CIDR edit touches only the join line" '[[ $(grep -c -- "--cluster-network-cidr 10.98.120.0/24" "$T/join-private.sh") == 1 ]]'
lab_join_script_cidr "$T/join-public.sh" 10.98.120.0/24 2>/dev/null
check "no note, no edit" 'cmp -s "$T/join-public.sh" "$T/join-public.orig"'

# ── release checkouts (cached tree; a tree that is not the tag is refused) ──
LAB_CACHE_DIR="$T/cache"; mkdir -p "$LAB_CACHE_DIR/rel-v9.9.9/scripts" "$LAB_CACHE_DIR/rel-v9.9.9/platform"
touch "$LAB_CACHE_DIR/rel-v9.9.9/scripts/bootstrap.sh"; echo "9.9.9" > "$LAB_CACHE_DIR/rel-v9.9.9/platform/VERSION"
check "a cached release checkout is used as is" '[[ "$(lab_release_checkout v9.9.9)" == "$LAB_CACHE_DIR/rel-v9.9.9" ]]'
echo "9.9.8" > "$LAB_CACHE_DIR/rel-v9.9.9/platform/VERSION"
check "a checkout whose platform/VERSION is not the tag is refused" '! lab_release_checkout v9.9.9 >/dev/null 2>&1'
check "staging installs with ITS release's bootstrap.sh" \
  '[[ "$(CL_RELEASE_TAG=v9.9.7 REPO=/nonexistent; mkdir -p "$LAB_CACHE_DIR/rel-v9.9.7/scripts" "$LAB_CACHE_DIR/rel-v9.9.7/platform"; touch "$LAB_CACHE_DIR/rel-v9.9.7/scripts/bootstrap.sh"; echo 9.9.7 > "$LAB_CACHE_DIR/rel-v9.9.7/platform/VERSION"; _lab_bootstrap_sh)" == "$LAB_CACHE_DIR/rel-v9.9.7/scripts/bootstrap.sh" ]]'
check "dev installs with this checkout's bootstrap.sh" '[[ "$(CL_RELEASE_TAG= REPO=/repo; _lab_bootstrap_sh)" == /repo/scripts/bootstrap.sh ]]'

# ── registry mirrors ──
expected='mirrors:
  docker.io:
    endpoint: ["http://192.0.2.10:4000"]
  ghcr.io:
    endpoint: ["http://192.0.2.10:4001"]
  quay.io:
    endpoint: ["http://192.0.2.10:4002"]
  registry.k8s.io:
    endpoint: ["http://192.0.2.10:4003"]'
check "registries.yaml body" '[[ "$(VMTEST_REGISTRY_MIRROR=192.0.2.10 registry_mirrors_yaml)" == "$expected" ]]'

# ── cloud-init seeds ──
ca_b64="$(printf -- '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n' | base64 -w0)"
VMTEST_REGISTRY_MIRROR=192.0.2.10 _lab_node_userdata lab-dev-1 "ssh-ed25519 AAAATEST lab" "$ca_b64" > "$T/node-m.yaml"
VMTEST_REGISTRY_MIRROR='' _lab_node_userdata lab-dev-1 "ssh-ed25519 AAAATEST lab" "$ca_b64" > "$T/node.yaml"
check "node seed (with mirrors) is valid YAML" 'yaml_ok "$T/node-m.yaml"'
check "node seed (no mirrors) is valid YAML" 'yaml_ok "$T/node.yaml"'
paths() { python3 -c 'import sys,yaml; print(" ".join(f["path"] for f in yaml.safe_load(open(sys.argv[1]))["write_files"] if f))' "$1"; }
check "mirrors reach registries.yaml" '[[ " $(paths "$T/node-m.yaml") " == *" /etc/rancher/k3s/registries.yaml "* ]]'
check "no mirrors → no registries.yaml" '[[ " $(paths "$T/node.yaml") " != *registries.yaml* ]]'
for f in /etc/insula-lab/ca.pem /usr/local/share/ca-certificates/insula-lab-ca.crt /etc/pki/ca-trust/source/anchors/insula-lab-ca.crt; do
  check "the lab CA lands in ${f}" '[[ " $(paths "$T/node.yaml") " == *" $f "* ]]'
done
check "the node resolves through the services VM" 'grep -q "nameserver 10.98.100.10" "$T/node.yaml"'
check "Debian sources switch to http before packages (bootcmd)" 'python3 -c "import sys,yaml; d=yaml.safe_load(open(sys.argv[1])); assert \"deb.debian.org\" in d[\"bootcmd\"][0]" "$T/node.yaml"'

LAB_PDNS_API_KEY=k LAB_STEPCA_PASSWORD=p LAB_S3_USER_SUFFIX=0123456789abcdef LAB_S3_PW=s LAB_SFTP_PW=f LAB_SMB_PW=m
for v in LAB_PDNS_API_KEY LAB_STEPCA_PASSWORD LAB_S3_USER_SUFFIX LAB_S3_PW LAB_SFTP_PW LAB_SMB_PW; do lab_state_set "$v" "${!v}"; done
_lab_svc_userdata "ssh-ed25519 AAAATEST lab" "$(_lab_svc_env | base64 -w0)" "$(_lab_services_script | base64 -w0)" > "$T/svc.yaml"
check "svc seed is valid YAML" 'yaml_ok "$T/svc.yaml"'
python3 - "$T/svc.yaml" "$T" <<'PY'
import base64, sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
for f in d["write_files"]:
    if f.get("encoding") == "b64":
        name = f["path"].rsplit("/", 1)[1]
        open(f"{sys.argv[2]}/svc-{name}", "wb").write(base64.b64decode(f["content"]))
PY
check "svc services script parses" 'bash -n "$T/svc-lab-services.sh"'
check "svc env carries every service credential" \
  '( . "$T/svc-svc.env"; [[ -n "$PDNS_API_KEY" && -n "$STEPCA_PASSWORD" && ${#S3_USER} -ge 16 && -n "$S3_PW" && -n "$SFTP_PW" && -n "$SMB_PW" && "$SVC_IP" == 10.98.100.10 ]] )'
check "svc env is 0600 on the VM" 'python3 -c "import sys,yaml; d=yaml.safe_load(open(sys.argv[1])); assert [f for f in d[\"write_files\"] if f[\"path\"]==\"/etc/insula-lab/svc.env\"][0][\"permissions\"]==\"0600\"" "$T/svc.yaml"'
check "the PowerDNS API is limited to localhost + the lab range" 'grep -q -- "--webserver-allow-from=\"127.0.0.1,\$LAB_RANGE\"" "$T/svc-lab-services.sh"'

echo "test-vm-lab: ${pass} passed, ${fail} failed"
(( fail == 0 ))
