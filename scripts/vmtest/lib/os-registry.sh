#!/usr/bin/env bash
# scripts/vmtest/lib/os-registry.sh — the supported-OS → cloud-image map.
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
# Format:  id → "cloud-image-url|family|tier"
#   family: debian|rhel  (bootstrap auto-detects; carried here for reporting/selection)
#   tier:   1 (Debian/Ubuntu LTS) | 2 (RHEL-family)
# root login is enabled uniformly by the cloud-init seed, so bootstrap --remote
# (SSHes as root) works on every family — no per-OS ssh-user handling needed.
set -euo pipefail

declare -gA VMTEST_OS_IMAGES=(
  # ── Tier 1: Debian / Ubuntu LTS ────────────────────────────────────
  [debian-12]="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2|debian|1"
  [debian-13]="https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2|debian|1"
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
os_list()   { printf '%s\n' "${!VMTEST_OS_IMAGES[@]}" | sort; }
os_known()  { [[ -n "${VMTEST_OS_IMAGES[$1]:-}" ]]; }
