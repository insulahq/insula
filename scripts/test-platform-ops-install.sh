#!/usr/bin/env bash
# TDD harness for scripts/lib/bootstrap-phases.sh — the platform-ops install
# phase (Holistic plan W8 / ADR-045).
#
# What this proves:
#   - phase_platform_ops is a GRACEFUL NO-OP until the signing key + release
#     asset exist (the real state of the repo today — the platform-ops binary
#     and its cosign key land in a later PR). It must NEVER abort a fresh
#     bootstrap.
#   - The security boundary is FAIL-CLOSED: a missing signature or a failed
#     cosign verification refuses the install (no unverified binary on PATH).
#   - The happy path atomically installs the binary (mode 755), persists the
#     cosign public key to /etc/platform/cosign.pub, and lays down the systemd
#     self-upgrade timer.
#   - Re-running is idempotent (already-current → skip, no re-fetch).
#
# Crypto note: cosign is exercised through $PLATFORM_OPS_COSIGN_BIN. When real
# cosign is on PATH the happy path uses a real generated keypair; otherwise a
# fake shim stands in. The logic under test is bootstrap's orchestration +
# fail-closed POLICY, not cosign's cryptography (that is cosign's job, wired
# with the real key when the release pipeline lands).
#
# Run: ./scripts/test-platform-ops-install.sh   (exit 0 = all pass)
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
LIB="$REPO_ROOT/scripts/lib/bootstrap-phases.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
yes() { if eval "$2"; then ok "$1"; else bad "$1 — predicate failed: $2"; fi; }

# ── Fixtures ────────────────────────────────────────────────────────────────

# REAL crypto fixtures — verification is openssl-only (no cosign on nodes), so
# the tests use real EC P-256 keys + real signatures. A cosign `sign-blob --key`
# signature is exactly `base64(openssl dgst -sha256 -sign)`, so signing here with
# openssl produces the same artifact a release would.
KEYDIR=$(mktemp -d)
openssl ecparam -genkey -name prime256v1 -noout -out "$KEYDIR/priv.pem"  2>/dev/null
openssl ec -in "$KEYDIR/priv.pem" -pubout -out "$KEYDIR/pub.pem"         2>/dev/null
openssl ecparam -genkey -name prime256v1 -noout -out "$KEYDIR/wrong.pem" 2>/dev/null  # mismatched key

# base64 signature of file $2 with key $1 → stdout (== cosign .sig format).
sign_b64() { openssl dgst -sha256 -sign "$1" "$2" | base64 -w0; }

# A fake platform-ops binary that prints a given version for `version`.
make_fake_binary() {
  local path="$1" version="$2"
  cat > "$path" <<SHIM
#!/usr/bin/env bash
[ "\$1" = "version" ] && { echo "$version"; exit 0; }
echo "platform-ops (fake)"; exit 0
SHIM
  chmod +x "$path"
}

# Lay down a local "release" dir: binary + a real signature for both arches.
# $1=release dir, $2=binary version, $3=signing key (priv.pem | wrong.pem).
make_signed_release() {
  local rel="$1" ver="$2" key="$3" a
  mkdir -p "$rel"
  for a in amd64 arm64; do
    make_fake_binary "$rel/platform-ops-linux-$a" "$ver"
    sign_b64 "$key" "$rel/platform-ops-linux-$a" > "$rel/platform-ops-linux-$a.sig"
  done
}

# ── 0. Library loads and exposes the contract ───────────────────────────────
yes "lib parses (bash -n)" "bash -n '$LIB'"
# shellcheck disable=SC1090
source "$LIB"
for fn in phase_platform_ops platform_ops_arch platform_ops_target_version \
          platform_ops_installed_version platform_ops_verify_blob \
          platform_ops_fetch platform_ops_install_timer; do
  yes "defines $fn" "declare -F $fn >/dev/null"
done

# ── 1. arch mapping ─────────────────────────────────────────────────────────
yes "arch x86_64 → amd64"  "[ \"\$(platform_ops_arch x86_64)\"  = amd64 ]"
yes "arch amd64  → amd64"  "[ \"\$(platform_ops_arch amd64)\"   = amd64 ]"
yes "arch aarch64 → arm64" "[ \"\$(platform_ops_arch aarch64)\" = arm64 ]"
yes "arch arm64  → arm64"  "[ \"\$(platform_ops_arch arm64)\"   = arm64 ]"
yes "arch riscv  → reject" "! platform_ops_arch riscv64 >/dev/null 2>&1"

# ── 2. target version read + validate ───────────────────────────────────────
yes "reads real platform/VERSION" "[ \"\$(platform_ops_target_version '$REPO_ROOT')\" = \"\$(tr -d '[:space:]' < '$REPO_ROOT/platform/VERSION')\" ]"
BADROOT=$(mktemp -d); mkdir -p "$BADROOT/platform"; printf 'not-a-version\n' > "$BADROOT/platform/VERSION"
yes "rejects malformed VERSION" "! platform_ops_target_version '$BADROOT' >/dev/null 2>&1"; rm -rf "$BADROOT"
NOROOT=$(mktemp -d)
yes "rejects missing VERSION" "! platform_ops_target_version '$NOROOT' >/dev/null 2>&1"; rm -rf "$NOROOT"
RCROOT=$(mktemp -d); mkdir -p "$RCROOT/platform"; printf '2026.6.2-rc.1\n' > "$RCROOT/platform/VERSION"
yes "accepts -rc.N prerelease" "[ \"\$(platform_ops_target_version '$RCROOT')\" = 2026.6.2-rc.1 ]"; rm -rf "$RCROOT"

# ── 3. verify_blob is fail-closed (openssl, real signatures) ─────────────────
VDIR=$(mktemp -d); echo "release bytes" > "$VDIR/b"
sign_b64 "$KEYDIR/priv.pem"  "$VDIR/b" > "$VDIR/good.sig"      # correct key
sign_b64 "$KEYDIR/wrong.pem" "$VDIR/b" > "$VDIR/wrongkey.sig"  # valid sig, wrong key
printf 'not%%valid-base64' > "$VDIR/malformed.sig"
: > "$VDIR/empty.sig"                       # zero bytes
printf '   \n\t\n' > "$VDIR/whitespace.sig" # decodes to 0 bytes
yes "verify valid sig → pass"            "platform_ops_verify_blob '$VDIR/b' '$VDIR/good.sig' '$KEYDIR/pub.pem'"
yes "verify wrong-key sig → fail"        "! platform_ops_verify_blob '$VDIR/b' '$VDIR/wrongkey.sig' '$KEYDIR/pub.pem'"
yes "verify malformed (non-base64) → fail" "! platform_ops_verify_blob '$VDIR/b' '$VDIR/malformed.sig' '$KEYDIR/pub.pem'"
yes "verify empty sig → fail"            "! platform_ops_verify_blob '$VDIR/b' '$VDIR/empty.sig' '$KEYDIR/pub.pem'"
yes "verify whitespace-only sig → fail"  "! platform_ops_verify_blob '$VDIR/b' '$VDIR/whitespace.sig' '$KEYDIR/pub.pem'"
printf 'x' >> "$VDIR/b"   # tamper the blob after signing
yes "verify tampered blob → fail"        "! platform_ops_verify_blob '$VDIR/b' '$VDIR/good.sig' '$KEYDIR/pub.pem'"
yes "verify w/ no openssl → fail-closed"  "! PLATFORM_OPS_OPENSSL_BIN=/nonexistent/openssl platform_ops_verify_blob '$VDIR/b' '$VDIR/good.sig' '$KEYDIR/pub.pem'"
rm -rf "$VDIR"

# ── 4. phase_platform_ops orchestration ─────────────────────────────────────
# Helper: build an isolated sandbox (repo root w/ VERSION, bin path, etc.).
sandbox() {
  local sb; sb=$(mktemp -d)
  mkdir -p "$sb/repo/platform" "$sb/sysd"
  printf '2026.6.1\n' > "$sb/repo/platform/VERSION"
  printf '%s' "$sb"
}
# Common env for an install attempt against local release dir $1 in sandbox $2.
# Exports nothing permanent; echoes via subshell in each predicate.

# 4a. Trust anchor absent in repo → graceful no-op (dormancy gate).
SB=$(sandbox); REL="$SB/rel"
make_signed_release "$REL" 2026.6.1 "$KEYDIR/priv.pem"
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_PUB_SRC="$SB/repo/platform/cosign.pub" \
  PLATFORM_OPS_COSIGN_PUB_DST="$SB/etc/cosign.pub" \
  PLATFORM_OPS_RELEASE_BASE="$REL" \
  PLATFORM_OPS_SYSTEMD_DIR="$SB/sysd" PLATFORM_OPS_SKIP_SYSTEMCTL=1 \
  phase_platform_ops "$SB/repo"
) ; rc=$?
yes "no signing key → returns 0 (no-op)" "[ $rc -eq 0 ]"
yes "no signing key → binary NOT installed" "[ ! -e '$SB/bin/platform-ops' ]"
rm -rf "$SB"

# 4b. Key present but NO asset in release (404) → graceful no-op.
SB=$(sandbox); REL="$SB/rel"; mkdir -p "$REL"   # empty release dir
printf 'PUBKEY\n' > "$SB/repo/platform/cosign.pub"
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_PUB_SRC="$SB/repo/platform/cosign.pub" \
  PLATFORM_OPS_COSIGN_PUB_DST="$SB/etc/cosign.pub" \
  PLATFORM_OPS_RELEASE_BASE="$REL" \
  PLATFORM_OPS_SYSTEMD_DIR="$SB/sysd" PLATFORM_OPS_SKIP_SYSTEMCTL=1 \
  phase_platform_ops "$SB/repo"
) ; rc=$?
yes "no asset → returns 0 (no-op)" "[ $rc -eq 0 ]"
yes "no asset → binary NOT installed" "[ ! -e '$SB/bin/platform-ops' ]"
rm -rf "$SB"

# 4c. FAIL-CLOSED: binary present, signature missing → refuse.
SB=$(sandbox); REL="$SB/rel"; mkdir -p "$REL"
cp "$KEYDIR/pub.pem" "$SB/repo/platform/cosign.pub"
make_fake_binary "$REL/platform-ops-linux-amd64" 2026.6.1
make_fake_binary "$REL/platform-ops-linux-arm64" 2026.6.1
# (no .sig files written)
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_PUB_SRC="$SB/repo/platform/cosign.pub" \
  PLATFORM_OPS_COSIGN_PUB_DST="$SB/etc/cosign.pub" \
  PLATFORM_OPS_RELEASE_BASE="$REL" \
  PLATFORM_OPS_SYSTEMD_DIR="$SB/sysd" PLATFORM_OPS_SKIP_SYSTEMCTL=1 \
  phase_platform_ops "$SB/repo"
) ; rc=$?
yes "missing sig → returns 0 (non-fatal)" "[ $rc -eq 0 ]"
yes "missing sig → binary NOT installed (fail-closed)" "[ ! -e '$SB/bin/platform-ops' ]"
rm -rf "$SB"

# 4d. FAIL-CLOSED: signature is from the WRONG key → openssl refuses.
SB=$(sandbox); REL="$SB/rel"
cp "$KEYDIR/pub.pem" "$SB/repo/platform/cosign.pub"
make_signed_release "$REL" 2026.6.1 "$KEYDIR/wrong.pem"
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_PUB_SRC="$SB/repo/platform/cosign.pub" \
  PLATFORM_OPS_COSIGN_PUB_DST="$SB/etc/cosign.pub" \
  PLATFORM_OPS_RELEASE_BASE="$REL" \
  PLATFORM_OPS_SYSTEMD_DIR="$SB/sysd" PLATFORM_OPS_SKIP_SYSTEMCTL=1 \
  phase_platform_ops "$SB/repo"
) ; rc=$?
yes "verify fail → returns 0 (non-fatal)" "[ $rc -eq 0 ]"
yes "verify fail → binary NOT installed (fail-closed)" "[ ! -e '$SB/bin/platform-ops' ]"
rm -rf "$SB"

# 4e. HAPPY PATH: key + asset + valid sig → atomic install + key + timer.
SB=$(sandbox); REL="$SB/rel"
cp "$KEYDIR/pub.pem" "$SB/repo/platform/cosign.pub"
make_signed_release "$REL" 2026.6.1 "$KEYDIR/priv.pem"
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_PUB_SRC="$SB/repo/platform/cosign.pub" \
  PLATFORM_OPS_COSIGN_PUB_DST="$SB/etc/cosign.pub" \
  PLATFORM_OPS_RELEASE_BASE="$REL" \
  PLATFORM_OPS_SYSTEMD_DIR="$SB/sysd" PLATFORM_OPS_SKIP_SYSTEMCTL=1 \
  phase_platform_ops "$SB/repo"
) ; rc=$?
yes "happy path → returns 0" "[ $rc -eq 0 ]"
yes "happy path → binary installed" "[ -x '$SB/bin/platform-ops' ]"
yes "happy path → binary is mode 755" "[ \"\$(stat -c '%a' '$SB/bin/platform-ops')\" = 755 ]"
yes "happy path → installed binary reports target version" "[ \"\$('$SB/bin/platform-ops' version)\" = 2026.6.1 ]"
yes "happy path → pubkey persisted (matches source)" "[ -f '$SB/etc/cosign.pub' ] && cmp -s '$SB/etc/cosign.pub' '$KEYDIR/pub.pem'"
yes "happy path → no temp turds left in bin dir" "[ -z \"\$(find '$SB/bin' -name 'platform-ops.*' 2>/dev/null)\" ]"
yes "happy path → timer unit written" "[ -f '$SB/sysd/platform-ops-update.timer' ]"
yes "happy path → service unit written" "[ -f '$SB/sysd/platform-ops-update.service' ]"
yes "timer is daily + persistent" "grep -q 'OnCalendar' '$SB/sysd/platform-ops-update.timer' && grep -q 'Persistent=true' '$SB/sysd/platform-ops-update.timer'"
yes "service runs self-upgrade --check" "grep -q 'self-upgrade --check' '$SB/sysd/platform-ops-update.service'"
yes "service ExecStart references the installed binary path" "grep -q 'ExecStart=$SB/bin/platform-ops self-upgrade --check' '$SB/sysd/platform-ops-update.service'"
yes "service is hardened (NoNewPrivileges + ProtectSystem)" "grep -q 'NoNewPrivileges=yes' '$SB/sysd/platform-ops-update.service' && grep -q 'ProtectSystem=strict' '$SB/sysd/platform-ops-update.service'"

# 4f. IDEMPOTENCY: re-run with the binary already at target version → skip.
# Corrupt the release so a re-fetch would FAIL the verify; a true skip never refetches.
printf 'BAD' > "$REL/platform-ops-linux-amd64.sig"
printf 'BAD' > "$REL/platform-ops-linux-arm64.sig"
before=$(stat -c '%Y' "$SB/bin/platform-ops")
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_PUB_SRC="$SB/repo/platform/cosign.pub" \
  PLATFORM_OPS_COSIGN_PUB_DST="$SB/etc/cosign.pub" \
  PLATFORM_OPS_RELEASE_BASE="$REL" \
  PLATFORM_OPS_SYSTEMD_DIR="$SB/sysd" PLATFORM_OPS_SKIP_SYSTEMCTL=1 \
  phase_platform_ops "$SB/repo"
) ; rc=$?
after=$(stat -c '%Y' "$SB/bin/platform-ops")
yes "idempotent re-run → returns 0" "[ $rc -eq 0 ]"
yes "idempotent re-run → binary untouched (no refetch)" "[ '$before' = '$after' ] && [ \"\$('$SB/bin/platform-ops' version)\" = 2026.6.1 ]"
rm -rf "$SB"

# ── 5. Real-repo guard: phase_platform_ops on the actual checkout returns 0
#      without installing anything. platform/cosign.pub now ships in the repo, so
#      the dormancy gate no longer applies; point RELEASE_BASE at an EMPTY local
#      dir so the "no asset yet" path is exercised offline (no network in a unit
#      test) — proves fresh bootstrap stays green until a signed asset ships.
EMPTYREL=$(mktemp -d); RRBIN=$(mktemp -d)/platform-ops
yes "real repo → phase_platform_ops is a clean no-op (returns 0, no install)" \
  "PLATFORM_OPS_BIN='$RRBIN' PLATFORM_OPS_RELEASE_BASE='$EMPTYREL' PLATFORM_OPS_SKIP_SYSTEMCTL=1 phase_platform_ops '$REPO_ROOT' && [ ! -e '$RRBIN' ]"
rm -rf "$EMPTYREL"

# ── 6. Regression: the install path must NOT leave a lingering RETURN trap that
#      re-fires (with out-of-scope $tmp/$staged) on a SUBSEQUENT function return.
#      Run phase_platform_ops PAST the dormancy gate (asset 404 → skip), then
#      return from another function under `set -u` — must not error "unbound".
trap_canary() { return 0; }
SBT=$(mktemp -d); mkdir -p "$SBT/repo/platform"; printf '2026.6.1\n' > "$SBT/repo/platform/VERSION"
printf 'PUBKEY\n' > "$SBT/repo/platform/cosign.pub"; EMPTY2=$(mktemp -d)
(
  set -uo pipefail
  PLATFORM_OPS_BIN="$SBT/bin/platform-ops" PLATFORM_OPS_RELEASE_BASE="$EMPTY2" \
    PLATFORM_OPS_SKIP_SYSTEMCTL=1 phase_platform_ops "$SBT/repo" >/dev/null 2>&1
  trap_canary    # would explode with "tmp: unbound variable" if the trap leaked
) ; yes "no lingering RETURN trap after install path (caller return is clean)" "[ \$? -eq 0 ]"
rm -rf "$SBT" "$EMPTY2"

rm -rf "$KEYDIR"
echo
echo "platform-ops-install tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
