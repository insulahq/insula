#!/usr/bin/env bash
# TDD harness for the --dual-stack (IPv6) path in scripts/bootstrap.sh.
# Run: ./scripts/test-bootstrap-dual-stack.sh   (exit 0 = all pass)
#
# Two jobs, and the FIRST one matters more:
#
#   1. Prove the single-stack path is untouched. k3s cannot change cluster
#      CIDRs after install, so a regression that leaks IPv6 into a default
#      install is not a bug you fix forward — it is a cluster you rebuild.
#      Every default-path assertion here is a literal, not a pattern.
#
#   2. Prove the dual-stack path emits both families EVERYWHERE it must:
#      cluster-cidr, service-cidr, --node-ip and --node-external-ip, on
#      servers AND workers. A node that registers one family joins a
#      dual-stack cluster and then fails kubelet registration.
#
# The pure helpers are extracted and executed for real against a fake `ip`;
# the call sites are asserted structurally (the repo's ci-*-check.sh idiom),
# because install_k3s_* cannot run outside a real host.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
BOOTSTRAP="$REPO_ROOT/scripts/bootstrap.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }
has()  { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else bad "$3 — not found: $2"; fi; }
hasnt(){ if grep -qF -- "$2" <<<"$1"; then bad "$3 — unexpectedly found: $2"; else ok "$3"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── Extract the pure helpers verbatim so we test the SHIPPED code ───────────
sed -n '/^detect_node_ipv6()/,/^}/p'              "$BOOTSTRAP" >  "$WORK/helpers.sh"
sed -n '/^resolve_cluster_network_ip()/,/^}/p'     "$BOOTSTRAP" >> "$WORK/helpers.sh"
sed -n '/^resolve_cluster_network_ipv6()/,/^}/p'  "$BOOTSTRAP" >> "$WORK/helpers.sh"
sed -n '/^resolve_same_link_ipv6()/,/^}/p'        "$BOOTSTRAP" >> "$WORK/helpers.sh"
sed -n '/^resolve_dual_stack_node_ipv6()/,/^}/p'  "$BOOTSTRAP" >> "$WORK/helpers.sh"
sed -n '/^cluster_cidr_args()/,/^}/p'            "$BOOTSTRAP" >> "$WORK/helpers.sh"
for fn in detect_node_ipv6 resolve_cluster_network_ipv6 resolve_same_link_ipv6 resolve_dual_stack_node_ipv6 \
          cluster_cidr_args; do
  grep -q "^${fn}()" "$WORK/helpers.sh" || { echo "FAIL: could not extract ${fn}() from $BOOTSTRAP" >&2; exit 1; }
done
# error() is called by the helpers on the refuse paths. It is FATAL in
# bootstrap.sh (`exit 1`) and the helpers rely on that — model it exactly, or
# this harness would "pass" a function that falls through its own guard.
cat >> "$WORK/helpers.sh" <<'STUB'
error() { echo "ERROR: $*" >&2; exit 1; }
STUB

mkdir -p "$WORK/bin"
cat > "$WORK/bin/ip" <<'FAKE'
#!/usr/bin/env bash
# Fakes the three `ip` shapes the helpers use:
#   ip -4 -o addr show           -> $FAKE_V4_LINES
#   ip -6 -o addr show           -> $FAKE_V6_LINES
#   ip -6 -o addr show dev <if>  -> $FAKE_V6_LINES filtered to that interface
want_dev=""
family=6
prev=""
for a in "$@"; do
  case "$a" in
    -4) family=4 ;;
    -6) family=6 ;;
  esac
  [[ "$prev" == "dev" ]] && want_dev="$a"
  prev="$a"
done
if [[ "$family" == 4 ]]; then
  printf '%s\n' "${FAKE_V4_LINES:-}"
elif [[ -n "$want_dev" ]]; then
  printf '%s\n' "${FAKE_V6_LINES:-}" | awk -v d="$want_dev" '$2==d'
else
  printf '%s\n' "${FAKE_V6_LINES:-}"
fi
FAKE
chmod +x "$WORK/bin/ip"
export PATH="$WORK/bin:$PATH"

run_helper() { ( set +e; source "$WORK/helpers.sh"; "$@" ); }

echo "detect_node_ipv6 — address selection"

FAKE_V6_LINES='1: lo    inet6 ::1/128 scope host
2: eth0    inet6 2001:db8:1::5/64 scope global
2: eth0    inet6 fe80::1/64 scope link'
export FAKE_V6_LINES
check "picks a global address" "2001:db8:1::5" "$(run_helper detect_node_ipv6)"

FAKE_V6_LINES='2: eth0    inet6 fd00:beef::7/64 scope global
2: eth0    inet6 fe80::1/64 scope link'
check "accepts ULA when that is all there is (lab/VM tier)" "fd00:beef::7" "$(run_helper detect_node_ipv6)"

# Ordering matters: a node with both must pin the routable one, whichever the
# kernel happens to list first.
FAKE_V6_LINES='2: eth0    inet6 fd00:beef::7/64 scope global
2: eth0    inet6 2001:db8:1::5/64 scope global'
check "prefers global over ULA even when ULA is listed first" "2001:db8:1::5" "$(run_helper detect_node_ipv6)"

FAKE_V6_LINES='2: eth0    inet6 fe80::1/64 scope link
3: lo    inet6 ::1/128 scope host'
run_helper detect_node_ipv6 >/dev/null 2>&1 \
  && bad "refuses when only link-local/loopback exist" \
  || ok "refuses when only link-local/loopback exist"

FAKE_V6_LINES='9: wt0    inet6 2001:db8:99::1/64 scope global'
run_helper detect_node_ipv6 >/dev/null 2>&1 \
  && bad "ignores VPN interfaces (wt0) — a mesh address is not the node underlay" \
  || ok "ignores VPN interfaces (wt0) — a mesh address is not the node underlay"

FAKE_V6_LINES=''
run_helper detect_node_ipv6 >/dev/null 2>&1 \
  && bad "refuses on a node with no IPv6 at all" \
  || ok "refuses on a node with no IPv6 at all"

echo
echo "resolve_dual_stack_node_ipv6 — underlay safety"

# The refuse rule: on a pinned underlay we must NEVER silently use a v6 that
# sits on a DIFFERENT link, or pod traffic splits across two networks (v4 in
# the tunnel, v6 on the open internet). Here eth0 carries the public v6 while
# the pinned v4 lives on the mesh interface wt0 — nothing usable.
export FAKE_V4_LINES='9: wt0    inet 10.8.0.5/24 scope global'
FAKE_V6_LINES='2: eth0    inet6 2001:db8:1::5/64 scope global'
out=$( NODEIP_PIN_CIDR="10.8.0.0/24" NODEIP_PIN_CIDR_V6="" run_helper resolve_dual_stack_node_ipv6 2>&1 )
rc=$?
if (( rc != 0 )) && grep -q "Refusing to fall back to an IPv6 on a different link" <<<"$out"; then
  ok "pinned underlay, v6 only on ANOTHER interface → refuses"
else
  bad "pinned underlay, v6 only on ANOTHER interface → refuses (rc=$rc, out=${out:0:140})"
fi

# But it must NOT refuse when the pinned v4 and a v6 share one interface —
# same link by construction, so no declaration is needed. This is the common
# single-NIC case and what the first dual-stack VM run hit: the harness pins
# --cluster-network-cidr to the per-run NAT range and one virtio NIC carries
# both that v4 and its ULA v6.
FAKE_V4_LINES='2: enp1s0    inet 10.98.3.44/24 scope global'
FAKE_V6_LINES='2: enp1s0    inet6 fd00:1a5:3::1bf/64 scope global
2: enp1s0    inet6 fe80::5054:ff:fe12:3456/64 scope link'
check "pinned underlay, v6 on the SAME interface → accepted without the flag" \
  "fd00:1a5:3::1bf" "$( NODEIP_PIN_CIDR="10.98.3.0/24" NODEIP_PIN_CIDR_V6="" run_helper resolve_dual_stack_node_ipv6 )"

# An explicitly declared range still wins over same-link inference.
FAKE_V4_LINES='2: enp1s0    inet 10.98.3.44/24 scope global'
FAKE_V6_LINES='2: enp1s0    inet6 fd00:1a5:3::1bf/64 scope global
9: wt0    inet6 fd7a:115c::9/64 scope global'
check "an explicit --cluster-network-cidr-v6 takes precedence" \
  "fd7a:115c::9" "$( NODEIP_PIN_CIDR="10.98.3.0/24" NODEIP_PIN_CIDR_V6="fd7a:115c::/48" run_helper resolve_dual_stack_node_ipv6 )"

FAKE_V4_LINES=''
FAKE_V6_LINES='2: eth0    inet6 2001:db8:1::5/64 scope global'
check "public underlay → uses the detected node address" \
  "2001:db8:1::5" "$( NODEIP_PIN_CIDR="" run_helper resolve_dual_stack_node_ipv6 )"

echo
echo "single-stack default is UNCHANGED (regression guard)"

src=$(cat "$BOOTSTRAP")
has "$src" 'DUAL_STACK=false'                        "dual-stack defaults OFF"

# cluster_cidr_args() is the ONE place the k3s CIDR strings are built, so both
# consumers — the k3s install flags and the platform-cluster-cidrs ConfigMap —
# can never drift. Execute it for real in both modes rather than grepping: a
# structural assertion would still "pass" if the guard inverted.
POD_CIDR_V4="10.42.0.0/16" SERVICE_CIDR_V4="10.43.0.0/16" \
POD_CIDR_V6="fd42:42::/56" SERVICE_CIDR_V6="fd42:43::/112"
check "single-stack builds IPv4-ONLY cluster+service CIDRs" \
  "10.42.0.0/16 10.43.0.0/16" \
  "$( DUAL_STACK=false run_helper cluster_cidr_args )"
check "dual-stack appends BOTH v6 CIDRs, v4 first" \
  "10.42.0.0/16,fd42:42::/56 10.43.0.0/16,fd42:43::/112" \
  "$( DUAL_STACK=true run_helper cluster_cidr_args )"

# Both consumers must go through the helper. install_k3s_server()'s locals are
# NOT visible in apply_platform_manifests() (sibling top-level functions), which
# is how the platform-cluster-cidrs ConfigMap silently never got created — and
# on dual-stack that cost tenants every IPv6 egress rule.
server_block=$(sed -n '/^install_k3s_server()/,/^}/p' "$BOOTSTRAP")
manifests_block=$(sed -n '/^apply_platform_manifests()/,/^}/p' "$BOOTSTRAP")
has "$server_block"    'read -r cluster_cidr_arg service_cidr_arg <<<"$(cluster_cidr_args)"' \
  "install_k3s_server sources its CIDRs from the helper"
has "$manifests_block" 'read -r pod_cidr_value svc_cidr_value <<<"$(cluster_cidr_args)"' \
  "the platform-cluster-cidrs ConfigMap sources the SAME helper"
hasnt "$manifests_block" '${cluster_cidr_arg:-}' \
  "the ConfigMap no longer reads another function's local (always-empty guard)"
has "$manifests_block" 'kctl create configmap platform-cluster-cidrs' \
  "the ConfigMap is written unconditionally, not behind a dead guard"
# The v6 CIDRs may only ever be reached through the DUAL_STACK guard.
if grep -q 'POD_CIDR_V6\|SERVICE_CIDR_V6' <<<"$server_block"; then
  bad "install_k3s_server references the v6 CIDRs directly (must go via cluster_cidr_args)"
else
  ok "install_k3s_server reaches the v6 CIDRs only via cluster_cidr_args"
fi

echo
echo "dual-stack emits both families on servers AND workers"

has "$server_block" 'node_pin="--node-ip=${private_ip}${node_ipv6:+,${node_ipv6}}' \
  "server pinned-underlay node-ip gains the v6 family"
has "$server_block" 'node_pin="--node-ip=${public_ip}${node_ipv6:+,${node_ipv6}}' \
  "server public-underlay node-ip gains the v6 family"
worker_block=$(sed -n '/^install_k3s_worker()/,/^}/p' "$BOOTSTRAP")
has "$worker_block" 'resolve_dual_stack_node_ipv6' \
  "worker resolves a v6 node address too (a v4-only worker cannot join)"
has "$worker_block" '--node-ip=${private_ip}${node_ipv6:+,${node_ipv6}}' \
  "worker pinned-underlay node-ip gains the v6 family"
has "$worker_block" '--node-ip=${public_ip}${node_ipv6:+,${node_ipv6}}' \
  "worker public-underlay node-ip gains the v6 family"

echo
echo "--node-external-ip PUBLISHES, so it takes a global v6 — never a ULA"
# Live check on VM run 6e9e214b: --node-ip carried both families but
# --node-external-ip carried only IPv4, because the PINNED-underlay branch
# never appended the v6 while the public-underlay branch did. Both branches
# now use node_public_ipv6, and both take it from the global-only detector:
# announcing a ULA as ExternalIP would send clients to an off-link address,
# and ingress-external-ips copies ExternalIP straight onto the Traefik Service.
for blk in server worker; do
  b=$([[ $blk == server ]] && echo "$server_block" || echo "$worker_block")
  has "$b" 'node_public_ipv6=$(detect_node_ipv6 global-only || true)' \
    "${blk}: external v6 comes from the GLOBAL-ONLY detector"
  hasnt "$b" '--node-external-ip=${public_ip},${node_ipv6}' \
    "${blk}: external-ip never takes the ULA-tolerant node_ipv6"
done
has "$server_block" '--node-external-ip=${public_ip}${node_public_ipv6:+,${node_public_ipv6}}' \
  "server PINNED-underlay publishes the global v6 as ExternalIP too"
has "$worker_block" '--node-external-ip=${public_ip}${node_public_ipv6:+,${node_public_ipv6}}' \
  "worker PINNED-underlay publishes the global v6 as ExternalIP too"
# And the detector itself must actually refuse a ULA in that mode.
FAKE_V6_LINES='2: eth0    inet6 fd00:5e:1::130/64 scope global'
check "global-only refuses a ULA-only host (empty, not the ULA)" \
  "" "$( run_helper detect_node_ipv6 global-only )"
check "the default mode still accepts that ULA (it is a fine --node-ip)" \
  "fd00:5e:1::130" "$( run_helper detect_node_ipv6 )"
FAKE_V6_LINES='2: eth0    inet6 fd00:5e:1::130/64 scope global
2: eth0    inet6 2001:db8:9::7/64 scope global'
check "global-only picks the global address when one exists" \
  "2001:db8:9::7" "$( run_helper detect_node_ipv6 global-only )"

echo
echo "Calico + sysctl are gated on the flag"

has "$src" 'nodeAddressAutodetectionV6'          "Calico gains v6 autodetection"
has "$src" 'blockSize: 122'                       "Calico v6 pool uses the IPv6 default blockSize"
has "$src" '${ipv6_pool}'                         "the v6 pool is interpolated into ipPools"
if grep -q 'ipv6_pool="$' <<<"$src" || grep -q 'local ipv6_pool=""' <<<"$src"; then
  ok "ipv6_pool starts empty (single-stack renders no v6 pool)"
else
  bad "ipv6_pool starts empty (single-stack renders no v6 pool)"
fi
has "$src" 'net.ipv6.conf.all.forwarding = 1'    "v6 forwarding sysctl present"
has "$src" 'net.ipv6.conf.all.accept_ra = 2'     "accept_ra=2 keeps the node's own default route with forwarding on"

# The sysctl file must only be written under the flag — an IPv4-only host must
# not have its IPv6 behaviour changed by installing the platform.
sysctl_ctx=$(grep -B 12 'net.ipv6.conf.all.forwarding = 1' <<<"$src")
has "$sysctl_ctx" 'if [[ "$DUAL_STACK" == true ]]; then' "the v6 sysctl block is inside the dual-stack guard"

echo
echo "validation refuses impossible requests"
has "$src" 'Kubernetes caps the IPv6 service CIDR'  "service-cidr-v6 size is validated"
has "$src" '--dual-stack requires an IPv6 address'  "--dual-stack is refused on a node with no v6"
has "$src" '(( svc_v6_prefix < 108 ))'              "the /108 rule is enforced numerically"

echo
printf 'dual-stack: %d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
