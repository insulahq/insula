#!/usr/bin/env bash
# ci-host-config-enforcer-check.sh — guard the W10 host-config ENFORCE-mode
# safety invariants (ADR-045). The enforcer is the project's most privileged
# host-mutating component; these checks fail the build on any regression of its
# safe-by-default + fail-closed posture.
#
# Invariants:
#   1. The privileged enforcer is OPT-IN: it lives ONLY under k8s/components/ and
#      is NOT referenced by any k8s/base kustomization (a default install has no
#      privileged host-writer).
#   2. The observe-only detector in k8s/base STAYS locked down (privileged:false,
#      drop ALL caps, read-only /proc/sys) — no accidental escalation.
#   3. The enforcer uses least-privilege caps (SYS_ADMIN+NET_ADMIN), NOT full
#      `privileged: true`, and mounts ONLY /proc/sys (no /etc, no /lib/modules
#      in the sysctls-scoped enforcer).
#   4. The converge write path re-checks the allow-list in code (the second,
#      independent never-write-not-allowed gate behind converge()).

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
COMPONENT="$REPO_ROOT/k8s/components/host-config-enforcer"
BASE="$REPO_ROOT/k8s/base"
DS="$COMPONENT/daemonset.yaml"
OBSERVE_DS="$BASE/host-config-reconciler/daemonset.yaml"
ENFORCER_GO="$REPO_ROOT/images/host-config-reconciler/enforcer.go"
ALLOWLIST_GO="$REPO_ROOT/images/host-config-reconciler/allowlist.go"

fail() { echo "  ✗ $1" >&2; FAILED=1; }
FAILED=0

echo "ci-host-config-enforcer-check: verifying W10 enforce-mode invariants..."

# (1) opt-in: present as a component, absent from base
[[ -f "$DS" ]] || fail "k8s/components/host-config-enforcer/daemonset.yaml is missing"
[[ -f "$COMPONENT/kustomization.yaml" ]] || fail "enforcer component kustomization.yaml missing"
grep -q 'kind: Component' "$COMPONENT/kustomization.yaml" || fail "enforcer kustomization is not a Kustomize Component"
if grep -rl "host-config-enforcer" "$BASE" >/dev/null 2>&1; then
  fail "host-config-enforcer is referenced under k8s/base — the privileged enforcer MUST stay opt-in (components only)"
fi
# No base kustomization may list the component either.
if grep -rn "components/host-config-enforcer" "$BASE" >/dev/null 2>&1; then
  fail "a k8s/base kustomization pulls in the host-config-enforcer component — must be overlay-only opt-in"
fi

# (2) observe detector stays locked down
if [[ -f "$OBSERVE_DS" ]]; then
  grep -q 'privileged: false' "$OBSERVE_DS" || fail "observe-only daemonset lost 'privileged: false'"
  grep -q 'readOnly: true' "$OBSERVE_DS" || fail "observe-only daemonset's /proc/sys mount is no longer readOnly"
  grep -q 'drop: \["ALL"\]' "$OBSERVE_DS" || fail "observe-only daemonset no longer drops ALL caps"
else
  fail "observe-only daemonset.yaml is missing"
fi

# (3) enforcer least-privilege
if [[ -f "$DS" ]]; then
  grep -q 'privileged: true' "$DS" && fail "enforcer uses full 'privileged: true' — use least-privilege caps (SYS_ADMIN+NET_ADMIN)"
  grep -q 'SYS_ADMIN' "$DS" || fail "enforcer is missing CAP_SYS_ADMIN (needed to write global sysctls)"
  grep -q 'NET_ADMIN' "$DS" || fail "enforcer is missing CAP_NET_ADMIN (needed to write net.* sysctls in the host netns)"
  grep -q 'HOSTCONFIG_ROLE' "$DS" || fail "enforcer does not set HOSTCONFIG_ROLE=converge"
  grep -q 'converge' "$DS" || fail "enforcer HOSTCONFIG_ROLE is not 'converge'"
  # Sysctls-scoped enforcer must NOT mount /etc or /lib/modules (those are the
  # deferred ulimits/modules surfaces).
  grep -qE 'path:[[:space:]]*/etc(\b|/)' "$DS" && fail "enforcer mounts /etc — out of scope for the sysctls enforcer"
  grep -qE 'path:[[:space:]]*/lib/modules' "$DS" && fail "enforcer mounts /lib/modules — out of scope for the sysctls enforcer"
fi

# (4) the converge write path re-checks the allow-list (independent gate)
if [[ -f "$ENFORCER_GO" ]]; then
  # realSysctlIO.write must refuse a non-allow-listed key before writing.
  grep -q 'func (r \*realSysctlIO) write' "$ENFORCER_GO" || fail "enforcer.go has no realSysctlIO.write"
  awk '/func \(r \*realSysctlIO\) write/{f=1} f&&/r\.allow\(key\)/{found=1} f&&/^}/{exit} END{exit !found}' "$ENFORCER_GO" \
    || fail "realSysctlIO.write does not re-check r.allow(key) before writing (the second never-write-not-allowed gate)"
else
  fail "images/host-config-reconciler/enforcer.go is missing"
fi

# (5) the allow-list must DENY the known-dangerous-to-write sysctls (root RCE /
# hardening-downgrade) even though they fall within an allowed prefix.
if [[ -f "$ALLOWLIST_GO" ]]; then
  grep -q 'sysctlDenyList' "$ALLOWLIST_GO" || fail "allowlist.go has no sysctlDenyList (kernel.core_pattern etc. would be writable — root RCE)"
  for dangerous in kernel.core_pattern kernel.modprobe kernel.poweroff_cmd kernel.hotplug fs.suid_dumpable; do
    grep -q "\"$dangerous\"" "$ALLOWLIST_GO" || fail "sysctlDenyList is missing '$dangerous' (must never be writable)"
  done
else
  fail "images/host-config-reconciler/allowlist.go is missing"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo "ci-host-config-enforcer-check: FAILED" >&2
  exit 1
fi
echo "ci-host-config-enforcer-check: OK"
