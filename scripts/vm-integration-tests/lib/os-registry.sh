#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/os-registry.sh — the supported-OS → cloud-image map.
#
# Mirrors the platform's OS support matrix (CLAUDE.md → "Supported OSes";
# bootstrap.sh dispatches apt vs dnf via OS_FAMILY and fails fast on EOL). These
# are the STOCK generic cloud images — bootstrap.sh installs everything itself, so
# a clean image is exactly what we want to exercise the real OS-dispatch path.
#
# The whole point of the VM tier over scripts/test-bootstrap-os-matrix.sh (which is
# container-based and only checks check_os/apt-vs-dnf) is that we boot the REAL OS
# with systemd and run the REAL bootstrap end to end, per OS.
#
# Format:  id → "cloud-image-url|family|tier[|expected-os-version]"
#   family: debian|rhel  (bootstrap auto-detects; carried here for reporting/selection)
#   tier:   1 (Debian/Ubuntu LTS) | 2 (RHEL-family)
#   expected-os-version: optional. When set, the harness asserts the BOOTED guest
#     reports it (Debian: /etc/debian_version) and aborts the run otherwise, so an
#     upstream image swap can never silently change what we are testing on.
# root login is enabled uniformly by the cloud-init seed, so bootstrap --remote
# (SSHes as root) works on every family — no per-OS ssh-user handling needed.
set -euo pipefail

declare -gA VMTEST_OS_IMAGES=(
  # ── Tier 1: Debian / Ubuntu LTS ────────────────────────────────────
  [debian-12]="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2|debian|1"
  # PINNED to a dated build, not `latest`: this is the default test target, so it
  # must be reproducible — a floating URL silently changes the OS under the suite
  # and makes a red run impossible to attribute. 20260722-2547 ships
  # base-files 13.8+deb13u6, i.e. Debian 13.6; the version assertion below is what
  # keeps that honest. To move to a newer point release, bump BOTH fields together
  # (builds: https://cloud.debian.org/images/cloud/trixie/).
  [debian-13]="https://cloud.debian.org/images/cloud/trixie/20260722-2547/debian-13-genericcloud-amd64-20260722-2547.qcow2|debian|1|13.6"
  [ubuntu-22.04]="https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img|debian|1"
  [ubuntu-24.04]="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img|debian|1"
  # ── Tier 2: RHEL family (Rocky/Alma are the freely-testable RHEL-9 stand-ins) ──
  [rocky-9]="https://dl.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base.latest.x86_64.qcow2|rhel|2"
  [alma-9]="https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2|rhel|2"
  [centos-stream-9]="https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2|rhel|2"
  [centos-stream-10]="https://cloud.centos.org/centos/10-stream/x86_64/images/CentOS-Stream-GenericCloud-10-latest.x86_64.qcow2|rhel|2"
  # Amazon Linux 2023: AL2023 has no stable "latest.qcow2" symlink — pin the current
  # KVM build URL from https://docs.aws.amazon.com/linux/al2023/ug/outside-ec2.html
  [amazonlinux-2023]="PIN_AL2023_KVM_QCOW2_URL|rhel|2"
)

os_field() { # os_field <id> <1=url|2=family|3=tier>
  local spec="${VMTEST_OS_IMAGES[$1]:-}"
  [[ -n "$spec" ]] || { echo "unknown OS id: $1 (see os_list)" >&2; return 1; }
  cut -d'|' -f"$2" <<<"$spec"
}
os_url()    { os_field "$1" 1; }
os_family() { os_field "$1" 2; }
os_tier()   { os_field "$1" 3; }
# Empty when the entry pins no version (the floating-URL OSes) — callers skip the
# assertion in that case rather than inventing an expectation.
os_expect_version() { os_field "$1" 4; }
os_list()   { printf '%s\n' "${!VMTEST_OS_IMAGES[@]}" | sort; }
os_known()  { [[ -n "${VMTEST_OS_IMAGES[$1]:-}" ]]; }

# VMTEST_DEFAULT_OS — the single OS every run uses unless told otherwise.
#
# Runs used to draw each node's OS at random from the whole supported matrix, on
# the theory that runs would sample the matrix over time. In practice that bought
# less than it cost: the bugs it caught were the genuinely OS-shaped ones
# (SELinux blocking Longhorn's kubelet-root-dir discovery on RHEL-family, the
# el10 work), while it made every red run ambiguous — a failure had to be
# triaged against the OS draw before it could be attributed to a change — and
# multiplied wall-clock and host RAM for a dimension most defects do not live on.
# One pinned OS makes a red run mean exactly one thing.
VMTEST_DEFAULT_OS="debian-13"

# os_pool_default — the default draw universe: the pinned default OS only.
# Override with VMTEST_OS_POOL="$(os_pool_all)" for a matrix run, or pin a single
# different OS with `run.sh --os rocky-9`. Every OS in the registry stays
# reachable that way; the platform's Tier-1/Tier-2 support claim is unchanged.
os_pool_default() { echo "$VMTEST_DEFAULT_OS"; }

# os_pool_all — every supported OS with a real (non-PIN) image URL, space-
# separated. This is the old default; it remains the way to sweep the matrix
# deliberately, e.g. before a release that touches OS dispatch or host packages.
os_pool_all() {
  local os out=""
  while read -r os; do [[ "$(os_url "$os")" == PIN_* ]] || out+="${os} "; done < <(os_list)
  echo "${out% }"
}
