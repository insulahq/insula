#!/usr/bin/env bash
# integration-sftp-gateway.sh — E2E test for the SFTP chroot landing directory.
#
# Exercises the REAL sftp-chroot binary + patched openssh sftp-server from the
# file-manager image (the artifact that runs in the file-manager pod), inside a
# privileged container, driven by a real `sftp` client. It proves the chroot
# start directory (`-d <chrootHome>`) the gateway computes via confineHome():
#
#   A. home_path "/public_html"  → user lands in /home/public_html (the FIX —
#      regression test for the bug where every sub-path collapsed to /home).
#   B. home_path "/"             → user lands in /home (PVC root) and sees subdirs.
#   C. containment               → at the chroot root `/`, listing is DENIED, so
#      platform dirs (.platform/etc/dev, mode 711) are invisible to the nobody uid.
#
# The `-d` values below MIRROR confineHome() in images/sftp-gateway/session.go
# (covered by unit tests in session_test.go: TestConfineHome / TestBuildCommand_SFTP).
#
# Requirements: docker with `--privileged` (bind-mount + chroot + mknod). The
# script builds the file-manager image locally if it is not already present.
#
# USAGE: ./scripts/integration-sftp-gateway.sh
#   IMAGE=<ref>   reuse an existing file-manager image instead of building one.
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE="${IMAGE:-fm-sftp-e2e:local}"

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; RESET='\033[0m'
pass=0; fail=0
ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; pass=$((pass+1)); }
bad()  { printf "  ${RED}✗${RESET} %s\n" "$1"; fail=$((fail+1)); }
info() { printf "${CYAN}%s${RESET}\n" "$1"; }

command -v docker >/dev/null || { echo "docker is required" >&2; exit 2; }

# ---- build (or reuse) the file-manager image ------------------------------
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  info "Building file-manager image ($IMAGE)…"
  docker build -t "$IMAGE" "$REPO_ROOT/images/file-manager" >/dev/null \
    || { echo "image build failed" >&2; exit 1; }
fi

# ---- run the chroot + sftp session inside one privileged container --------
# Everything (test data + /jail) is created IN the container so the test does
# not depend on host bind-mounts (which a DinD daemon can't see).
run_sftp() { # $1 = chrootHome (-d value), $2 = batch commands
  local chroot_home="$1" batch="$2"
  docker run --rm --privileged --entrypoint sh "$IMAGE" -lc '
    set -e
    mkdir -p /jail /data/public_html/uploads
    echo PUBLIC_MARKER > /data/public_html/MARKER_PUBLIC
    echo ROOT_MARKER   > /data/MARKER_ROOT
    /usr/local/bin/entrypoint.sh true   # build the chroot jail, then exit 0
    printf "%b" "'"$batch"'" | sftp -b - -D \
      "/usr/local/bin/sftp-chroot --root /jail --bind /data:/home /.platform/sftp-server -e -d '"$chroot_home"'" 2>&1
  ' 2>&1
}

info "== SFTP gateway chroot E2E =="

# ---- Test A: the FIX — subdirectory home lands in the subdirectory ---------
info "Test A — home_path /public_html → -d /home/public_html"
outA=$(run_sftp "/home/public_html" 'pwd\nls\n')
echo "$outA" | sed 's/^/    A| /'
if echo "$outA" | grep -q "Remote working directory: /home/public_html"; then
  ok "lands in the subdirectory (/home/public_html)"
else
  bad "did NOT land in /home/public_html (the bug: collapsed to /home)"
fi
if echo "$outA" | grep -q "MARKER_PUBLIC"; then
  ok "subdirectory contents are visible (MARKER_PUBLIC)"
else
  bad "subdirectory contents not visible"
fi

# ---- Test B: root home lands at the PVC root ------------------------------
info "Test B — home_path / → -d /home"
outB=$(run_sftp "/home" 'pwd\nls\n')
echo "$outB" | sed 's/^/    B| /'
if echo "$outB" | grep -q "Remote working directory: /home"; then
  ok "lands at the PVC root (/home)"
else
  bad "did NOT land at /home"
fi
if echo "$outB" | grep -q "public_html"; then
  ok "PVC root contents are visible (public_html)"
else
  bad "PVC root contents not visible"
fi

# ---- Test C: containment — chroot root is not enumerable ------------------
info "Test C — containment: listing the chroot root must be denied"
outC=$(run_sftp "/home" 'cd /\nls\n')
echo "$outC" | sed 's/^/    C| /'
if echo "$outC" | grep -qiE 'readdir\("/"\): Permission denied'; then
  ok "chroot root not listable — platform dirs (.platform/etc/dev) invisible to nobody"
else
  bad "chroot root WAS listable — platform dirs may be exposed"
fi

# ---- summary --------------------------------------------------------------
echo
if [[ "$fail" -eq 0 ]]; then
  printf "${GREEN}PASS${RESET} — %d checks\n" "$pass"; exit 0
else
  printf "${RED}FAIL${RESET} — %d passed, %d failed\n" "$pass" "$fail"; exit 1
fi
