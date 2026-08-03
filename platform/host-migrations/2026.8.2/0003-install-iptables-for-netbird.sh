#!/usr/bin/env bash
# idempotent: installs the iptables package only when the binary is absent, and restarts NetBird only inside that same branch, so a converged node is a no-op
# allow-paths: (package install only — writes no host files directly)
set -euo pipefail

# Install the host `iptables` binary on nodes bootstrapped before it joined the
# base package set.
#
# We do not use iptables ourselves: k3s bundles its own and the platform
# firewall is nftables. It matters because OTHER host software probes for the
# binary and silently changes behaviour when it is missing. NetBird does exactly
# that, and says so in its own log:
#
#   WARN client/firewall/nftables/router_linux.go:1096: Will use nftables to
#   manipulate the filter table because iptables is not available
#
# It then writes NATIVE nft rules — `iifname "wt0" accept`, `oifname "wt0"
# ct state established,related accept` — into `table ip filter`, which is the
# table Calico manages through iptables-nft. Felix cannot represent those and
# fails every dataplane resync:
#
#   [ERROR] felix/table.go 946: iptables-save failed because there are
#   incompatible nft rules in the table. Remove the nft rules to continue.
#
# calico-node then sits at 0/1 Ready indefinitely ("felix is not ready:
# readiness probe reporting 503") and NetworkPolicy stops being programmed.
# Tenant isolation depends on that policy, so this is a security regression, not
# a cosmetic one. Diagnosed on a fresh single-node install, 2026-08-03.
#
# Installing the binary makes NetBird select its iptables backend on next start;
# those rules ARE iptables-nft-compatible, so Felix can read the table again.
# Nodes without NetBird are unaffected — the package is small and the restart
# below is skipped when the service is absent.

if command -v iptables >/dev/null 2>&1; then
  echo "0003-install-iptables-for-netbird: iptables already present — nothing to do."
  exit 0
fi

echo "0003-install-iptables-for-netbird: iptables missing — installing."
if command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables >/dev/null
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q iptables >/dev/null
else
  echo "0003-install-iptables-for-netbird: neither apt-get nor dnf — cannot install." >&2
  exit 1
fi

if ! command -v iptables >/dev/null 2>&1; then
  echo "0003-install-iptables-for-netbird: install reported success but iptables is still absent." >&2
  exit 1
fi
echo "0003-install-iptables-for-netbird: iptables installed."

# NetBird picks its firewall backend only at startup, so the binary alone
# changes nothing until it restarts. The restart lives INSIDE the branch that
# actually installed something — the early return above means a converged node
# never bounces its mesh again on subsequent host-config runs.
if systemctl is-active --quiet netbird 2>/dev/null; then
  echo "0003-install-iptables-for-netbird: restarting netbird to re-create its rules via the iptables backend."
  if ! systemctl restart netbird; then
    echo "0003-install-iptables-for-netbird: netbird restart FAILED — mesh may be down, investigate." >&2
    exit 1
  fi
else
  echo "0003-install-iptables-for-netbird: netbird not active — no restart needed."
fi

# Felix retries its resync on a timer, so calico-node recovers by itself once
# the incompatible rules are gone. Deliberately NOT deleting the calico-node pod
# here: it is healthy apart from the probe, and Felix reprogramming cleanly is
# the signal worth having — a restart would mask whether this actually worked.
echo "0003-install-iptables-for-netbird: done. Verify: kubectl -n calico-system get pod -l k8s-app=calico-node"
