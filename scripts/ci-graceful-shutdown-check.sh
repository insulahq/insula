#!/usr/bin/env bash
#
# CI guard for kubelet graceful node shutdown.
#
# Nodes must drain pods and unmount their volumes before the host powers down.
# Without it, k3s.service's `KillMode=process` plus ordering only
# `After=network-online.target` lets systemd stop k3s while containers keep
# running and then tear down iscsid underneath them — which on production
# 2026-08-27 aborted the ext4 journal on the CNPG system-db Longhorn volume
# while Postgres was writing to it, and stalled shutdown for 3m28s.
#
# The configuration is unusually easy to break by looking correct, so each
# invariant that was empirically shown to be load-bearing is asserted here:
#
#   1. bootstrap.sh writes all three files (fresh installs), and calls the
#      function that does it — a function nobody calls is the classic
#      silent regression.
#   2. host-migration 2026.8.19/0001 writes the same three files (existing
#      clusters) — the two paths must not diverge.
#   3. The logind drop-in sorts AFTER unattended-upgrades' own drop-in.
#      systemd merges .conf.d drop-ins by FILENAME across /etc, /run and
#      /usr/lib; directory priority only breaks ties between identical
#      names. unattended-upgrades ships
#      /usr/lib/systemd/logind.conf.d/unattended-upgrades-logind-maxdelay.conf
#      with InhibitDelayMaxSec=30, so any digit-prefixed name loses to it and
#      the effective delay stays 30s — which is exactly why kubelet's own
#      self-healing 99-kubelet.conf never worked. Verified on DEV.
#   4. InhibitDelayMaxSec >= shutdownGracePeriod, or kubelet refuses to arm
#      the shutdown manager at all ("timed out after 5 attempts waiting for
#      logind InhibitDelayMaxSec to update").
#   5. The kubelet setting is delivered as a KubeletConfiguration drop-in,
#      never as --kubelet-arg: shutdownGracePeriod has no command-line flag.
#
# Exits non-zero on violation. Wired into the Infrastructure CI workflow.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FAILED=0
fail() { echo "  ✗ $1"; FAILED=1; }
pass() { echo "  ✓ $1"; }

readonly BOOTSTRAP="${PROJECT_DIR}/scripts/bootstrap.sh"
readonly MIGRATION="${PROJECT_DIR}/platform/host-migrations/2026.8.19/0001-graceful-node-shutdown.sh"

readonly KUBELET_DROPIN='kubelet.conf.d/10-graceful-shutdown.conf'
readonly LOGIND_DROPIN='logind.conf.d/zz-insula-graceful-shutdown.conf'
readonly ORDER_DROPIN='10-insula-iscsid-order.conf'

echo "▸ Invariant 1: bootstrap.sh provisions graceful shutdown on fresh installs"
if [[ ! -f "$BOOTSTRAP" ]]; then
  fail "scripts/bootstrap.sh not found"
else
  for f in "$KUBELET_DROPIN" "$LOGIND_DROPIN" "$ORDER_DROPIN"; do
    if grep -qF "$f" "$BOOTSTRAP"; then
      pass "bootstrap.sh writes $f"
    else
      fail "bootstrap.sh no longer writes $f"
    fi
  done
  if grep -qE '^\s*configure_graceful_shutdown\s*$' "$BOOTSTRAP"; then
    pass "configure_graceful_shutdown is actually called"
  else
    fail "configure_graceful_shutdown is defined but never called — fresh installs would ship unprotected"
  fi
fi

echo "▸ Invariant 2: the host-migration converges the same files on existing clusters"
if [[ ! -f "$MIGRATION" ]]; then
  fail "host-migration 2026.8.19/0001-graceful-node-shutdown.sh not found"
else
  for f in "$KUBELET_DROPIN" "$LOGIND_DROPIN" "$ORDER_DROPIN"; do
    if grep -qF "$f" "$MIGRATION"; then
      pass "migration writes $f"
    else
      fail "migration no longer writes $f — existing clusters would diverge from fresh installs"
    fi
  done
  # logind must be restarted BEFORE k3s, or kubelet re-arms against the stale
  # delay. This ordering is precisely what kubelet's own self-heal gets wrong.
  logind_line=$(grep -n 'systemctl restart systemd-logind' "$MIGRATION" | head -1 | cut -d: -f1 || true)
  k3s_line=$(grep -n 'systemctl restart k3s' "$MIGRATION" | head -1 | cut -d: -f1 || true)
  if [[ -n "$logind_line" && -n "$k3s_line" && "$logind_line" -lt "$k3s_line" ]]; then
    pass "migration restarts systemd-logind before k3s"
  else
    fail "migration must restart systemd-logind BEFORE k3s (logind=${logind_line:-none} k3s=${k3s_line:-none})"
  fi
fi

echo "▸ Invariant 3: the logind drop-in outranks unattended-upgrades'"
# Lexical comparison against the vendor file that actually ships on Debian and
# Ubuntu. Anything sorting before it is silently ineffective.
readonly VENDOR='unattended-upgrades-logind-maxdelay.conf'
logind_name="${LOGIND_DROPIN##*/}"
if [[ "$(printf '%s\n%s\n' "$logind_name" "$VENDOR" | LC_ALL=C sort | tail -1)" == "$logind_name" ]]; then
  pass "$logind_name sorts after $VENDOR"
else
  fail "$logind_name sorts BEFORE $VENDOR — systemd would apply the vendor's 30s and kubelet would refuse to arm. Keep a name sorting after 'u' (e.g. zz-)."
fi

echo "▸ Invariant 4: InhibitDelayMaxSec >= shutdownGracePeriod"
# Comment lines are excluded deliberately: both files DOCUMENT the vendor's
# competing InhibitDelayMaxSec=30 in prose, and matching that instead of the
# effective setting would make this guard assert the wrong number.
effective() { grep -vE '^[[:space:]]*#' "$MIGRATION" | grep -oE "$1" | head -1 | grep -oE '[0-9]+' || true; }
grace=$(effective 'shutdownGracePeriod:[[:space:]]*[0-9]+')
inhibit=$(effective 'InhibitDelayMaxSec=[0-9]+')
if [[ -n "$grace" && -n "$inhibit" && "$inhibit" -ge "$grace" ]]; then
  pass "InhibitDelayMaxSec=${inhibit}s >= shutdownGracePeriod=${grace}s"
else
  fail "InhibitDelayMaxSec (${inhibit:-unset}) must be >= shutdownGracePeriod (${grace:-unset}) or kubelet refuses to start the node shutdown manager"
fi

echo "▸ Invariant 5: shutdownGracePeriod is delivered as KubeletConfiguration, not a flag"
if grep -qE 'kubelet-arg.*shutdown-grace-period' "$BOOTSTRAP" "$MIGRATION" 2>/dev/null; then
  fail "shutdownGracePeriod has NO kubelet command-line flag — it must be a kubelet.conf.d KubeletConfiguration drop-in"
else
  pass "no --kubelet-arg=shutdown-grace-period (correct: config-file-only setting)"
fi

if [[ "$FAILED" -ne 0 ]]; then
  echo ""
  echo "ci-graceful-shutdown-check: FAILED — see docs/operations/CLUSTER_MAINTENANCE_AND_UPGRADES.md, Runbook 5."
  exit 1
fi

echo ""
echo "ci-graceful-shutdown-check: all invariants hold."
