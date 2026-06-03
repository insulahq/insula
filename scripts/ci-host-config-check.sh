#!/usr/bin/env bash
# ci-host-config-check.sh — guard the host-config convergence model (ADR-045 W10,
# amended). host-config ENFORCEMENT is HOST-SIDE (platform-ops, root on the host)
# — there is NO privileged cluster pod that writes host state. The in-cluster
# DaemonSet is OBSERVE-ONLY (drift surfacing). These checks fail the build on any
# regression of that posture or of the in-code write-safety.
#
# Invariants:
#   1. NO privileged host-config enforcer pod exists (the retired component must
#      not come back; no manifest runs the reconciler in a converge/write role).
#   2. The in-cluster host-config-reconciler DaemonSet stays OBSERVE-only +
#      locked down (privileged:false, read-only /proc/sys, drop ALL caps).
#   3. The host-side converger carries the deny-list (kernel.core_pattern etc. —
#      root-RCE / hardening-downgrade sysctls are never writable) AND its write
#      path re-checks the allow-list.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
OBSERVE_DS="$REPO_ROOT/k8s/base/host-config-reconciler/daemonset.yaml"
SYSCTLS_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/sysctls.ts"
INDEX_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/index.ts"

fail() { echo "  ✗ $1" >&2; FAILED=1; }
FAILED=0

echo "ci-host-config-check: verifying host-side convergence model..."

# (1) no privileged enforcer pod
if [[ -d "$REPO_ROOT/k8s/components/host-config-enforcer" ]]; then
  fail "k8s/components/host-config-enforcer exists — the privileged enforcer pod was RETIRED (convergence is host-side in platform-ops)"
fi
# No manifest may run the reconciler image in a converge/write role.
if grep -rn 'HOSTCONFIG_ROLE' "$REPO_ROOT/k8s" >/dev/null 2>&1; then
  fail "a k8s manifest sets HOSTCONFIG_ROLE — the converge role was removed; the in-cluster DS is observe-only"
fi

# (2) observe detector stays locked down
if [[ -f "$OBSERVE_DS" ]]; then
  grep -q 'privileged: false' "$OBSERVE_DS" || fail "observe daemonset lost 'privileged: false'"
  grep -q 'readOnly: true' "$OBSERVE_DS" || fail "observe daemonset's /proc/sys mount is no longer readOnly"
  grep -q 'drop: \["ALL"\]' "$OBSERVE_DS" || fail "observe daemonset no longer drops ALL caps"
else
  fail "observe daemonset.yaml is missing"
fi

# (3) the host-side converger's deny-list + write-gate
if [[ -f "$SYSCTLS_TS" ]]; then
  grep -q 'DENY_LIST' "$SYSCTLS_TS" || fail "sysctls.ts has no DENY_LIST (kernel.core_pattern etc. would be writable — root RCE)"
  for dangerous in kernel.core_pattern kernel.modprobe kernel.poweroff_cmd kernel.hotplug \
    kernel.sysrq kernel.unprivileged_bpf_disabled kernel.yama.ptrace_scope kernel.randomize_va_space \
    fs.suid_dumpable fs.protected_symlinks net.ipv4.conf.all.route_localnet; do
    grep -q "'$dangerous'" "$SYSCTLS_TS" || fail "DENY_LIST is missing '$dangerous'"
  done
else
  fail "host-config/sysctls.ts is missing"
fi
if [[ -f "$INDEX_TS" ]]; then
  # writeSysctl must re-check BOTH the allow-list AND path containment before writing.
  awk '/function writeSysctl/{f=1} f&&/sysctlAllowed\(key\)/{a=1} f&&/procSysPath\(key\)/{p=1} f&&/^}/{exit} END{exit !(a&&p)}' "$INDEX_TS" \
    || fail "writeSysctl must re-check BOTH sysctlAllowed(key) AND procSysPath(key) before writing"
else
  fail "host-config/index.ts is missing"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "ci-host-config-check: FAILED" >&2
  exit 1
fi
echo "ci-host-config-check: OK"
