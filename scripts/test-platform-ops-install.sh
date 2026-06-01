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

# A fake cosign that "verifies" iff the signature file content is the literal
# token GOOD. Lets us drive both the success and the fail-closed branches
# deterministically without real keys. Mirrors `cosign verify-blob`'s contract:
# exit 0 = verified, non-zero = rejected.
make_fake_cosign() {
  local d="$1"
  cat > "$d/cosign" <<'SHIM'
#!/usr/bin/env bash
# usage: cosign verify-blob --key K --signature S BLOB
sig=""; while [ $# -gt 0 ]; do case "$1" in --signature) sig="$2"; shift 2;; --key) shift 2;; *) blob="$1"; shift;; esac; done
[ -f "$sig" ] && [ "$(cat "$sig")" = "GOOD" ]
SHIM
  chmod +x "$d/cosign"
  printf '%s/cosign' "$d"
}

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

# Lay down a local "release" dir: binary + signature for both arches.
# $1=release dir, $2=sig content (GOOD|BAD), $3=binary version.
make_release() {
  local rel="$1" sigval="$2" ver="$3"
  mkdir -p "$rel"
  make_fake_binary "$rel/platform-ops-linux-amd64" "$ver"
  make_fake_binary "$rel/platform-ops-linux-arm64" "$ver"
  printf '%s' "$sigval" > "$rel/platform-ops-linux-amd64.sig"
  printf '%s' "$sigval" > "$rel/platform-ops-linux-arm64.sig"
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

# ── 3. verify_blob is fail-closed ───────────────────────────────────────────
VDIR=$(mktemp -d); COSIGN=$(make_fake_cosign "$VDIR")
echo bin > "$VDIR/b"; printf 'GOOD' > "$VDIR/g.sig"; printf 'BAD' > "$VDIR/b.sig"
yes "verify GOOD sig → pass" "PLATFORM_OPS_COSIGN_BIN='$COSIGN' platform_ops_verify_blob '$VDIR/b' '$VDIR/g.sig' /dev/null"
yes "verify BAD sig → fail"  "! PLATFORM_OPS_COSIGN_BIN='$COSIGN' platform_ops_verify_blob '$VDIR/b' '$VDIR/b.sig' /dev/null"
yes "verify w/ no cosign on PATH → fail-closed" "! PLATFORM_OPS_COSIGN_BIN='/nonexistent/cosign' platform_ops_verify_blob '$VDIR/b' '$VDIR/g.sig' /dev/null"
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

# 4a. Signing key absent in repo → graceful no-op (TODAY'S REAL STATE).
SB=$(sandbox); REL="$SB/rel"; mkdir -p "$REL"
make_release "$REL" GOOD 2026.6.1
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
printf 'PUBKEY\n' > "$SB/repo/platform/cosign.pub"
make_fake_binary "$REL/platform-ops-linux-amd64" 2026.6.1
make_fake_binary "$REL/platform-ops-linux-arm64" 2026.6.1
# (no .sig files written)
COSIGN=$(make_fake_cosign "$SB")
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_BIN="$COSIGN" \
  PLATFORM_OPS_COSIGN_PUB_SRC="$SB/repo/platform/cosign.pub" \
  PLATFORM_OPS_COSIGN_PUB_DST="$SB/etc/cosign.pub" \
  PLATFORM_OPS_RELEASE_BASE="$REL" \
  PLATFORM_OPS_SYSTEMD_DIR="$SB/sysd" PLATFORM_OPS_SKIP_SYSTEMCTL=1 \
  phase_platform_ops "$SB/repo"
) ; rc=$?
yes "missing sig → returns 0 (non-fatal)" "[ $rc -eq 0 ]"
yes "missing sig → binary NOT installed (fail-closed)" "[ ! -e '$SB/bin/platform-ops' ]"
rm -rf "$SB"

# 4d. FAIL-CLOSED: cosign verification fails → refuse.
SB=$(sandbox); REL="$SB/rel"; mkdir -p "$REL"
printf 'PUBKEY\n' > "$SB/repo/platform/cosign.pub"
make_fake_binary "$REL/platform-ops-linux-amd64" 2026.6.1
make_fake_binary "$REL/platform-ops-linux-arm64" 2026.6.1
printf 'BAD' > "$REL/platform-ops-linux-amd64.sig"
printf 'BAD' > "$REL/platform-ops-linux-arm64.sig"
COSIGN=$(make_fake_cosign "$SB")
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_BIN="$COSIGN" \
  PLATFORM_OPS_COSIGN_PUB_SRC="$SB/repo/platform/cosign.pub" \
  PLATFORM_OPS_COSIGN_PUB_DST="$SB/etc/cosign.pub" \
  PLATFORM_OPS_RELEASE_BASE="$REL" \
  PLATFORM_OPS_SYSTEMD_DIR="$SB/sysd" PLATFORM_OPS_SKIP_SYSTEMCTL=1 \
  phase_platform_ops "$SB/repo"
) ; rc=$?
yes "verify fail → returns 0 (non-fatal)" "[ $rc -eq 0 ]"
yes "verify fail → binary NOT installed (fail-closed)" "[ ! -e '$SB/bin/platform-ops' ]"
rm -rf "$SB"

# 4e. HAPPY PATH: key + asset + good sig → atomic install + key + timer.
SB=$(sandbox); REL="$SB/rel"; mkdir -p "$REL"
printf 'PUBKEY\n' > "$SB/repo/platform/cosign.pub"
make_fake_binary "$REL/platform-ops-linux-amd64" 2026.6.1
make_fake_binary "$REL/platform-ops-linux-arm64" 2026.6.1
printf 'GOOD' > "$REL/platform-ops-linux-amd64.sig"
printf 'GOOD' > "$REL/platform-ops-linux-arm64.sig"
COSIGN=$(make_fake_cosign "$SB")
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_BIN="$COSIGN" \
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
yes "happy path → cosign pubkey persisted" "[ -f '$SB/etc/cosign.pub' ] && grep -q PUBKEY '$SB/etc/cosign.pub'"
yes "happy path → no temp turds left in bin dir" "[ -z \"\$(find '$SB/bin' -name 'platform-ops.*' 2>/dev/null)\" ]"
yes "happy path → timer unit written" "[ -f '$SB/sysd/platform-ops-update.timer' ]"
yes "happy path → service unit written" "[ -f '$SB/sysd/platform-ops-update.service' ]"
yes "timer is daily + persistent" "grep -q 'OnCalendar' '$SB/sysd/platform-ops-update.timer' && grep -q 'Persistent=true' '$SB/sysd/platform-ops-update.timer'"
yes "service runs self-upgrade --check" "grep -q 'self-upgrade --check' '$SB/sysd/platform-ops-update.service'"
yes "service ExecStart references the installed binary path" "grep -q 'ExecStart=$SB/bin/platform-ops self-upgrade --check' '$SB/sysd/platform-ops-update.service'"

# 4f. IDEMPOTENCY: re-run with the binary already at target version → skip.
# Corrupt the release so a re-fetch would FAIL the verify; a true skip never refetches.
printf 'BAD' > "$REL/platform-ops-linux-amd64.sig"
printf 'BAD' > "$REL/platform-ops-linux-arm64.sig"
before=$(stat -c '%Y' "$SB/bin/platform-ops")
(
  PLATFORM_OPS_BIN="$SB/bin/platform-ops" \
  PLATFORM_OPS_COSIGN_BIN="$COSIGN" \
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

# ── 5. Real-repo guard: phase_platform_ops on the actual checkout is a clean
#      no-op today (no platform/cosign.pub yet) — proves fresh bootstrap is safe.
yes "real repo → phase_platform_ops is a clean no-op (returns 0)" \
  "PLATFORM_OPS_BIN=\"\$(mktemp -d)/platform-ops\" PLATFORM_OPS_SKIP_SYSTEMCTL=1 phase_platform_ops '$REPO_ROOT'"

echo
echo "platform-ops-install tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
