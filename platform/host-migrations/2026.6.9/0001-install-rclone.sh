#!/usr/bin/env bash
# idempotent: no-op when `rclone` is already on PATH (the guard below); the
#   package install / pinned static fallback are themselves re-runnable
#   (install -m overwrites), and the runner's per-node .done marker prevents
#   re-runs after success.
# allow-paths: /usr/local/bin/rclone (static fallback); apt/dnf-managed system
#   paths when the distro packages rclone (the preferred package-install path).
set -euo pipefail

# Backfills `rclone` onto existing nodes. bootstrap.sh installs it on FRESH
# clusters (install_packages_{apt,dnf} + install_rclone_if_missing); this is the
# one-time backfill for nodes bootstrapped BEFORE rclone became a host
# dependency. rclone is needed host-side by the DR restore scripts
# (restore-{etcd,mail,postgres}-from-shim.sh, `platform-ops dr restore-component`)
# — they pull a snapshot from the backup-rclone-shim S3 endpoint before the local
# restore. The backup UPLOAD path uses a pod (rclone image) and is unaffected.

if command -v rclone >/dev/null 2>&1; then
  echo "host-migration: rclone already present ($(command -v rclone)) — no-op."
  exit 0
fi

# 1. Prefer the distro package (distro-managed security updates). EPEL is
#    already enabled on RHEL-family nodes (bootstrap installs epel-release);
#    Debian/Ubuntu ship rclone in main. A package failure is non-fatal — the
#    static fallback below covers AL2023 (no EPEL) and any repo gap.
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq rclone >/dev/null 2>&1 || true
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q rclone >/dev/null 2>&1 || true
fi

if command -v rclone >/dev/null 2>&1; then
  echo "host-migration: rclone installed via distro package."
  exit 0
fi

# 2. Static-binary fallback — pinned to the same line the backup-rclone-shim
#    DaemonSet runs (rclone/rclone:1.74.1) so host restore and pod upload speak
#    an identical rclone. Mirrors bootstrap.sh install_rclone_if_missing. Needs
#    curl + unzip (both present on a bootstrapped node).
arch="amd64"
case "$(uname -m)" in
  x86_64) arch="amd64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) echo "host-migration: unsupported arch '$(uname -m)' — install rclone manually." >&2; exit 1 ;;
esac
rclone_ver="v1.74.1"
base="rclone-${rclone_ver}-linux-${arch}"
url="https://github.com/rclone/rclone/releases/download/${rclone_ver}/${base}.zip"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
if ! curl -fsSL "$url" -o "${tmpdir}/rclone.zip" 2>/dev/null; then
  echo "host-migration: rclone not packaged AND download from ${url} failed (check outbound HTTPS to github.com)." >&2
  exit 1
fi
unzip -q "${tmpdir}/rclone.zip" -d "$tmpdir"
install -m 0755 "${tmpdir}/${base}/rclone" /usr/local/bin/rclone
echo "host-migration: rclone ${rclone_ver} installed to /usr/local/bin/rclone (static fallback)."
exit 0
