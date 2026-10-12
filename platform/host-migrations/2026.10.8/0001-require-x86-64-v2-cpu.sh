#!/usr/bin/env bash
# description: Checks that an x86-64 node's CPU is x86-64-v2 before the upgrade goes on: the mail server in this release cannot start on an older or generic virtual CPU.
# idempotent: reads /proc/cpuinfo and changes nothing; a second run gives the same answer.
# allow-paths: none — reads /proc/cpuinfo only, touches no host file
# blocks-on-failure: yes    # ADR-056: the point of the script — the upgrade must not go on to a mail server this node cannot run.
# phase: before-services    # ADR-064: it has to stop the run while the previous release's mail server is still running.
set -euo pipefail

# Stop the upgrade on a node whose CPU cannot run this release's mail server.
#
# Stalwart v0.16.26 is built for x86-64-v2 and exits at start on a CPU without
# SSE3, SSSE3, SSE4.1, SSE4.2, POPCNT, CMPXCHG16B or LAHF/SAHF. Physical CPUs
# have had these for over a decade (Intel since Nehalem, AMD since Bulldozer);
# a virtual machine given a generic CPU model — QEMU's qemu64 or kvm64, the
# default on older Proxmox — does not. Upgrading such a node would take mail
# down the moment the mail server is scheduled there, with nothing wrong in the
# upgrade itself.
#
# This runs before the services roll, so a node that fails it leaves the whole
# cluster on the release it was on. arm64 nodes have no such requirement.
#
# Fresh installs and joining nodes get the same check from bootstrap.sh's
# preflight (cpu_missing_x86_64_v2); the two flag lists must stay the same.

MIG=0001-require-x86-64-v2-cpu

arch="$(uname -m)"
if [ "$arch" != "x86_64" ]; then
  echo "${MIG}: ${arch} node -- no x86-64 CPU level to check."
  exit 0
fi

# The flags line is the same for every core; the first one is enough. No such
# line at all is not a pass — and under pipefail a bare grep would end the
# script here without a word.
flags=" $({ grep -m1 '^flags' /proc/cpuinfo || true; } | cut -d: -f2) "
if [ -z "${flags// /}" ]; then
  echo "${MIG}: /proc/cpuinfo has no 'flags' line -- cannot tell whether this CPU is x86-64-v2." >&2
  echo "${MIG}: the mail server in this release needs one. Check the node's CPU (lscpu), then run the upgrade again." >&2
  exit 1
fi
missing=""
for f in pni ssse3 cx16 sse4_1 sse4_2 popcnt lahf_lm; do
  case "$flags" in
    *" $f "*) ;;
    *) missing="${missing:+$missing }$f" ;;
  esac
done

if [ -n "$missing" ]; then
  echo "${MIG}: this node's CPU is not x86-64-v2 -- missing: ${missing}." >&2
  echo "${MIG}: the mail server in this release cannot start on it. On a virtual machine, set the CPU type to 'host' (or 'x86-64-v2' or newer) at the hypervisor, restart the VM, then run the upgrade again." >&2
  exit 1
fi

echo "${MIG}: CPU is x86-64-v2 -- ok."
