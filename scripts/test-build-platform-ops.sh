#!/usr/bin/env bash
# Integration harness for the platform-ops SEA build (Holistic plan W17).
#
# Proves the build PIPELINE end-to-end (not just the CLI unit tests):
#   1. scripts/build-platform-ops.sh produces a runnable self-contained binary
#      with the backend graph (pg/Drizzle) bundled in.
#   2. The binary's subcommands behave (version/help/migrations/exit codes).
#   3. (when cosign is present) a real key-based sign → verify → install
#      roundtrip succeeds through W8's ACTUAL phase_platform_ops/verify code,
#      and a tampered binary is REJECTED — i.e. the offline supply-chain path
#      that bootstrap uses actually works with real signatures.
#
# Needs: node + the backend's esbuild/postject devDeps (npm ci in backend).
# cosign is optional: set PLATFORM_OPS_COSIGN_BIN or have `cosign` on PATH to
# run the crypto roundtrip; otherwise that block is skipped with a notice.
#
# Run: ./scripts/test-build-platform-ops.sh   (exit 0 = all pass)
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
COSIGN="${PLATFORM_OPS_COSIGN_BIN:-cosign}"
OUT="$(mktemp -d)/dist"
BIN="${OUT}/platform-ops-linux-$(case "$(uname -m)" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; esac)"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
yes() { if eval "$2"; then ok "$1"; else bad "$1 — predicate failed: $2"; fi; }

echo "=== build ==="
if ! "$REPO_ROOT/scripts/build-platform-ops.sh" --version 2026.6.1 --out-dir "$OUT" >/tmp/po-build.log 2>&1; then
  cat /tmp/po-build.log; echo "BUILD FAILED"; exit 1
fi
yes "build produced an executable" "[ -x '$BIN' ]"

echo "=== smoke ==="
yes "version prints baked build version"        "'$BIN' version | grep -q 2026.6.1"
yes "version --json has binary field"           "'$BIN' version --json | grep -q '\"binary\":\"2026.6.1\"'"
yes "help lists commands"                       "'$BIN' help | grep -qi 'cluster'"
yes "migrations list is a graceful stub"        "'$BIN' migrations list | grep -qi 'no platform-migration registry'"
yes "unknown command exits 2"                   "'$BIN' frobnicate >/dev/null 2>&1; [ \$? -eq 2 ]"
yes "self-upgrade --check is a no-op (exit 0)"  "'$BIN' self-upgrade --check | grep -qi 'no-op'"
yes "cluster status fails gracefully (no crash)" "'$BIN' cluster status >/dev/null 2>&1; rc=\$?; [ \$rc -ne 0 ]"
yes "DB graph bundled: enrich path degrades on unreachable DB" \
  "DATABASE_URL='postgres://x:x@127.0.0.1:1/none' '$BIN' version --json | grep -q '\"installed\"'"

echo "=== crypto roundtrip (real cosign SIGN → openssl VERIFY → install) ==="
# Proves a genuine cosign-signed release verifies through the node-side openssl
# path (no cosign on the node) on a REAL SEA binary. cosign is signing-only.
if command -v "$COSIGN" >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/scripts/lib/bootstrap-phases.sh"
  K="$(mktemp -d)"; PW="$(openssl rand -base64 18)"
  ( cd "$K" && COSIGN_PASSWORD="$PW" "$COSIGN" generate-key-pair >/dev/null 2>&1 )
  # Sign offline (no Rekor), exactly as release.yml will.
  COSIGN_PASSWORD="$PW" "$COSIGN" sign-blob --key "$K/cosign.key" --tlog-upload=false --yes "$BIN" > "$K/sig" 2>/dev/null
  yes "openssl verify accepts a real cosign signature" \
    "platform_ops_verify_blob '$BIN' '$K/sig' '$K/cosign.pub'"
  cp "$BIN" "$K/tampered"; printf 'x' >> "$K/tampered"
  yes "openssl verify REJECTS a tampered binary (fail-closed)" \
    "! platform_ops_verify_blob '$K/tampered' '$K/sig' '$K/cosign.pub'"

  # Full install via the real phase_platform_ops, from a local file:// release.
  REL="$K/rel"; mkdir -p "$REL"
  ARCHTOK="$(case "$(uname -m)" in x86_64|amd64) echo amd64;; aarch64|arm64) echo arm64;; esac)"
  cp "$BIN" "$REL/platform-ops-linux-${ARCHTOK}"
  cp "$K/sig" "$REL/platform-ops-linux-${ARCHTOK}.sig"
  REPO="$K/repo"; mkdir -p "$REPO/platform"; echo 2026.6.1 > "$REPO/platform/VERSION"; cp "$K/cosign.pub" "$REPO/platform/cosign.pub"
  PLATFORM_OPS_BIN="$K/bin/platform-ops" \
  PLATFORM_OPS_RELEASE_BASE="$REL" \
  PLATFORM_OPS_COSIGN_PUB_DST="$K/etc/cosign.pub" \
  PLATFORM_OPS_SYSTEMD_DIR="$K/sysd" PLATFORM_OPS_SKIP_SYSTEMCTL=1 \
    phase_platform_ops "$REPO" >/dev/null 2>&1
  yes "phase_platform_ops installs the verified binary"   "[ -x '$K/bin/platform-ops' ]"
  yes "installed binary runs + reports its version"       "'$K/bin/platform-ops' version | grep -q 2026.6.1"
  rm -rf "$K"
else
  echo "  (cosign not found — skipping crypto roundtrip; set PLATFORM_OPS_COSIGN_BIN to enable)"
fi

rm -rf "$(dirname "$OUT")"
echo
echo "build-platform-ops tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
