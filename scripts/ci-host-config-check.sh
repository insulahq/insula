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
#   4. Package convergence (W10b) is ADDITIVE-ONLY + injection-safe: the install
#      path never removes/purges/autoremoves/auto-downgrades, validates package
#      names + pinned versions (anti-flag charset), and shells out only via argv
#      (execFile, NO shell) with a `--` end-of-options separator.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
OBSERVE_DS="$REPO_ROOT/k8s/base/host-config-reconciler/daemonset.yaml"
SYSCTLS_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/sysctls.ts"
INDEX_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/index.ts"
PACKAGES_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/packages.ts"

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

# (4) package convergence: additive-only + injection-safe
if [[ -f "$PACKAGES_TS" ]]; then
  grep -q 'packageNameValid' "$PACKAGES_TS" || fail "packages.ts has no packageNameValid (anti-flag/charset guard on package names)"
  grep -q 'packageVersionValid' "$PACKAGES_TS" || fail "packages.ts has no packageVersionValid (charset guard on pinned versions)"
else
  fail "host-config/packages.ts is missing"
fi
if [[ -f "$INDEX_TS" ]]; then
  # ADDITIVE-ONLY: the host-side install path must NEVER carry a destructive verb
  # or a downgrade flag. (apt/dnf `remove`/`purge`/`autoremove`, `--allow-downgrades`.)
  for forbidden in "'remove'" "'purge'" "'autoremove'" '--allow-downgrades' '--allowerasing'; do
    if grep -Fq -e "$forbidden" "$INDEX_TS"; then
      fail "index.ts package path contains forbidden destructive/downgrade token: $forbidden (must stay additive-only)"
    fi
  done
  # installPackage must re-validate the name AND pass apt/dnf an argv with a `--`
  # end-of-options separator (execFile, never a shell string).
  awk '/function installPackage/{f=1} f&&/packageNameValid\(name\)/{n=1} f&&/'"'"'--'"'"'/{s=1} f&&/^}/{exit} END{exit !(n&&s)}' "$INDEX_TS" \
    || fail "installPackage must re-check packageNameValid(name) AND pass a '--' separator to apt/dnf"
  # queryInstalled must re-validate the name AND pass `--` to dpkg-query/rpm.
  awk '/function queryInstalled/{f=1} f&&/packageNameValid\(name\)/{n=1} f&&/'"'"'--'"'"'/{s=1} f&&/^}/{exit} END{exit !(n&&s)}' "$INDEX_TS" \
    || fail "queryInstalled must re-check packageNameValid(name) AND pass a '--' separator to dpkg-query/rpm"
  # The package binaries must be invoked by ABSOLUTE path (the one existsSync
  # confirmed), never a bare name resolved through a possibly-hijacked PATH.
  for bare in "execFileSync('apt-get'" "execFileSync('dnf'" "execFileSync('dpkg-query'" "execFileSync('rpm'" "run('apt-get'" "run('dnf'"; do
    if grep -Fq -e "$bare" "$INDEX_TS"; then
      fail "package manager invoked by bare name ($bare) — use the absolute /usr/bin path"
    fi
  done
  # No shell execution anywhere in the host-config index (argv-only).
  if grep -Eq 'shell:\s*true|execSync\(|child_process'\''\)\.exec\b' "$INDEX_TS"; then
    fail "index.ts must not use a shell (shell:true / execSync / exec) — argv-only execFileSync"
  fi
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "ci-host-config-check: FAILED" >&2
  exit 1
fi
echo "ci-host-config-check: OK"
