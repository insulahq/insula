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
#   5. ulimits convergence (W10 follow-up) validates every limits.conf line
#      (anti-injection charset) in BOTH the converger AND the write path, and only
#      ever writes the single managed drop-in (limits.d/90-platform.conf).
#   6. Kernel-module convergence (W10 follow-up) is ADDITIVE-ONLY (never unloads:
#      no rmmod / modprobe -r) + injection-safe: validates the module name in BOTH
#      the converger AND the load path, and runs modprobe by absolute path, argv-
#      only, with a `--` separator.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
OBSERVE_DS="$REPO_ROOT/k8s/base/host-config-reconciler/daemonset.yaml"
SYSCTLS_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/sysctls.ts"
INDEX_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/index.ts"
PACKAGES_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/packages.ts"
ULIMITS_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/ulimits.ts"
MODULES_TS="$REPO_ROOT/backend/src/cli/platform-ops/host-config/modules.ts"

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
  # writeSysctl must re-check the allow-list, value charset, AND path containment before writing.
  awk '/function writeSysctl/{f=1} f&&/sysctlAllowed\(key\)/{a=1} f&&/sysctlValueValid\(value\)/{v=1} f&&/procSysPath\(key\)/{p=1} f&&/^}/{exit} END{exit !(a&&v&&p)}' "$INDEX_TS" \
    || fail "writeSysctl must re-check sysctlAllowed(key) AND sysctlValueValid(value) AND procSysPath(key) before writing"
else
  fail "host-config/index.ts is missing"
fi

# (3b) reboot-persistence drop-in must re-validate the allow-list before a key
# can reach /etc/sysctl.d (a persisted line is applied as root at every boot).
if [[ -f "$SYSCTLS_TS" ]]; then
  awk '/function renderSysctlDropIn/{f=1} f&&/sysctlAllowed/{a=1} f&&/^}/{exit} END{exit !a}' "$SYSCTLS_TS" \
    || fail "renderSysctlDropIn must re-validate sysctlAllowed() before persisting a key to /etc/sysctl.d"
fi
if [[ -f "$INDEX_TS" ]]; then
  # The persisted drop-in path must be a fixed platform-owned file, never key-derived.
  grep -q "SYSCTL_DROP_IN = '/etc/sysctl.d/" "$INDEX_TS" \
    || fail "persistSysctls must write a fixed /etc/sysctl.d drop-in path (SYSCTL_DROP_IN), never a key-derived path"
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

# (5) ulimits convergence: validated + drop-in-only
if [[ -f "$ULIMITS_TS" ]]; then
  grep -q 'ulimitLineValid' "$ULIMITS_TS" || fail "ulimits.ts has no ulimitLineValid (anti-injection charset guard on limits.conf lines)"
else
  fail "host-config/ulimits.ts is missing"
fi
if [[ -f "$INDEX_TS" ]]; then
  # writeUlimitDropIn must re-validate each line (second gate) before writing.
  awk '/function writeUlimitDropIn/{f=1} f&&/ulimitLineValid\(t\)/{v=1} f&&/^}/{exit} END{exit !v}' "$INDEX_TS" \
    || fail "writeUlimitDropIn must re-check ulimitLineValid(...) on every line before writing"
  # The converger must only ever write the single managed drop-in, never a
  # path derived from operator/CM input.
  grep -q "ULIMITS_DROP_IN = '/etc/security/limits.d/90-platform.conf'" "$INDEX_TS" \
    || fail "index.ts must write the fixed managed drop-in /etc/security/limits.d/90-platform.conf"
fi

# (6) kernel-module convergence: additive-only + injection-safe
if [[ -f "$MODULES_TS" ]]; then
  grep -q 'moduleNameValid' "$MODULES_TS" || fail "modules.ts has no moduleNameValid (anti-flag/charset guard on module names)"
else
  fail "host-config/modules.ts is missing"
fi
if [[ -f "$INDEX_TS" ]]; then
  # ADDITIVE-ONLY: the module path must NEVER unload a module.
  for forbidden in "rmmod" "'-r'" "'--remove'" "modprobe -r"; do
    if grep -Fq -e "$forbidden" "$INDEX_TS"; then
      fail "index.ts module path contains a module-unload token: $forbidden (must stay additive-only)"
    fi
  done
  # loadModule must re-validate the name AND pass modprobe a `--` separator.
  awk '/function loadModule/{f=1} f&&/moduleNameValid\(name\)/{n=1} f&&/'"'"'--'"'"'/{s=1} f&&/^}/{exit} END{exit !(n&&s)}' "$INDEX_TS" \
    || fail "loadModule must re-check moduleNameValid(name) AND pass a '--' separator to modprobe"
  # modprobe must be invoked by absolute path, never a bare name.
  if grep -Fq "execFileSync('modprobe'" "$INDEX_TS" || grep -Fq "execFileSync(\"modprobe\"" "$INDEX_TS"; then
    fail "modprobe invoked by bare name — use the absolute /usr/sbin/modprobe path"
  fi
  grep -q "MODPROBE_BIN = '/usr/sbin/modprobe'" "$INDEX_TS" \
    || fail "index.ts must invoke modprobe via the absolute /usr/sbin/modprobe path (MODPROBE_BIN)"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "ci-host-config-check: FAILED" >&2
  exit 1
fi
echo "ci-host-config-check: OK"
