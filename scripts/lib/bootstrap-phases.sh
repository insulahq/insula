#!/usr/bin/env bash
# bootstrap-phases.sh — extractable bootstrap phase library (Holistic plan W8 /
# ADR-045).
#
# This file is SOURCED by scripts/bootstrap.sh (and by unit tests). It defines
# phase functions; it has NO side effects at source time. The 90 battle-tested
# install_* functions stay in bootstrap.sh for now — this library currently
# owns the NET-NEW platform-ops install phase, the substrate that later
# workstreams (W9 migration registry, W17 CLI subcommands) grow into.
#
# platform-ops is the operator CLI (a self-contained, cosign-signed binary at
# /usr/local/bin/platform-ops). bootstrap installs it on first run. Until the
# release pipeline that builds + signs it lands (a later PR), there is no asset
# and no signing key in the repo, so phase_platform_ops is a deliberate,
# logged NO-OP. It is best-effort: it never aborts a bootstrap. Its ONE hard
# rule is fail-closed — an unverified binary is never placed on PATH.
#
# Testability: every external touch-point is an injectable seam (env override),
# all defaulting to the real production value:
#   PLATFORM_OPS_REPO            GitHub owner/repo            (insulahq/insula)
#   PLATFORM_OPS_RELEASE_BASE    release asset base URL/dir   (derived from repo+version)
#   PLATFORM_OPS_BIN             install destination          (/usr/local/bin/platform-ops)
#   PLATFORM_OPS_COSIGN_BIN      cosign executable            (cosign)
#   PLATFORM_OPS_COSIGN_PUB_SRC  in-repo trust anchor         (<root>/platform/cosign.pub)
#   PLATFORM_OPS_COSIGN_PUB_DST  persisted pubkey             (/etc/platform/cosign.pub)
#   PLATFORM_OPS_SYSTEMD_DIR     unit dir                     (/etc/systemd/system)
#   PLATFORM_OPS_SKIP_SYSTEMCTL  set to skip daemon-reload/enable (for non-systemd envs)

# NB: this is a sourced FUNCTION library — it deliberately does NOT `set -euo
# pipefail`. A `set` in a sourced file mutates the PARENT shell's options, which
# would force `-e` onto the rest of bootstrap.sh and break the test harness's
# intentional no-`-e` design. Instead each function is written to behave
# correctly regardless of the caller's `-e` state (fallible commands are
# guarded). (apply-secrets-bundle.sh DOES set options because it is sourced to
# take over execution; this lib only defines functions.)
#
# Minimal logging fallbacks so the lib is usable standalone (in tests). When
# sourced by bootstrap.sh the richer log/warn/error already exist and win.
declare -F log   >/dev/null 2>&1 || log()   { echo "[phases] $*"; }
declare -F warn  >/dev/null 2>&1 || warn()  { echo "[phases] WARN: $*" >&2; }

# Map `uname -m` (or an explicit arg, for tests) to the release asset arch token.
# shellcheck disable=SC2120  # optional arg is a test seam; prod uses the default
platform_ops_arch() {
  local machine="${1:-$(uname -m)}"
  case "$machine" in
    x86_64|amd64)  echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) return 1 ;;
  esac
}

# Echo the trimmed, validated target version from <root>/platform/VERSION.
# CalVer YYYY.M.PATCH with an optional -rc.N prerelease. Non-zero if absent or
# malformed.
platform_ops_target_version() {
  local root="${1:-${REPO_ROOT:-.}}" file v
  file="${root}/platform/VERSION"
  [ -r "$file" ] || return 1
  v="$(tr -d '[:space:]' < "$file")"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || return 1
  echo "$v"
}

# Echo the version reported by an already-installed binary (empty if absent).
platform_ops_installed_version() {
  local bin="${1:-${PLATFORM_OPS_BIN:-/usr/local/bin/platform-ops}}"
  [ -x "$bin" ] || return 0
  "$bin" version 2>/dev/null | head -n1 | tr -d '[:space:]'
}

# Fetch src→dest. http(s):// via curl (bounded timeouts; redirects pinned to
# https so a MitM can't downgrade to cleartext); anything else treated as a
# local path (lets tests point RELEASE_BASE at a directory). Non-zero on failure.
platform_ops_fetch() {
  local src="$1" dest="$2"
  case "$src" in
    https://*) curl -fsSL --proto-redir '=https' --connect-timeout 15 --max-time 120 "$src" -o "$dest" 2>/dev/null ;;
    http://*)  warn "platform-ops: fetching over plain HTTP (transport unencrypted; content is still cosign-verified): ${src}"
               curl -fsSL --connect-timeout 15 --max-time 120 "$src" -o "$dest" 2>/dev/null ;;
    file://*)  cp -f "${src#file://}" "$dest" 2>/dev/null ;;
    *)         cp -f "$src" "$dest" 2>/dev/null ;;
  esac
}

# Fail-closed cosign verification of a downloaded blob. Returns non-zero — i.e.
# REFUSES — when cosign is unavailable or the signature does not verify. The
# caller must treat any non-zero as "do not install".
platform_ops_verify_blob() {
  local blob="$1" sig="$2" pubkey="$3" cosign="${PLATFORM_OPS_COSIGN_BIN:-cosign}" out
  if ! command -v "$cosign" >/dev/null 2>&1; then
    warn "platform-ops: cosign not available ('${cosign}') — cannot verify; refusing install."
    return 1
  fi
  # Capture cosign's stderr (drop stdout) so a verify failure is diagnosable
  # in the bootstrap log rather than silently swallowed. Exit code is the gate.
  if ! out="$("$cosign" verify-blob --key "$pubkey" --signature "$sig" "$blob" 2>&1 >/dev/null)"; then
    [ -n "$out" ] && warn "platform-ops: cosign verify-blob: ${out}"
    return 1
  fi
}

# Lay down (and, unless skipped, enable) the daily self-upgrade systemd timer.
platform_ops_install_timer() {
  local dir="${PLATFORM_OPS_SYSTEMD_DIR:-/etc/systemd/system}"
  local bin="${PLATFORM_OPS_BIN:-/usr/local/bin/platform-ops}"
  mkdir -p "$dir" || { warn "platform-ops: cannot create unit dir ${dir} — skipping timer."; return 1; }
  cat > "${dir}/platform-ops-update.service" <<UNIT
[Unit]
Description=Insula platform-ops self-upgrade check
Documentation=https://github.com/${PLATFORM_OPS_REPO:-insulahq/insula}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${bin} self-upgrade --check
Nice=10
UNIT
  cat > "${dir}/platform-ops-update.timer" <<'UNIT'
[Unit]
Description=Daily Insula platform-ops self-upgrade check

[Timer]
OnCalendar=daily
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  if [ -z "${PLATFORM_OPS_SKIP_SYSTEMCTL:-}" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable --now platform-ops-update.timer 2>/dev/null \
      || warn "platform-ops: could not enable platform-ops-update.timer (non-fatal)."
  fi
  log "platform-ops: self-upgrade timer installed (${dir}/platform-ops-update.timer)."
}

# Install the operator CLI on first run. Best-effort + fail-closed (see header).
# Returns 0 in every expected outcome (installed, already-current, dormant,
# refused) so it can never abort bootstrap; the caller may still `|| true`.
phase_platform_ops() {
  local root="${1:-${REPO_ROOT:-.}}"
  local version arch bin pub_src pub_dst base asset sig_url tmp tmp_bin tmp_sig staged

  version="$(platform_ops_target_version "$root")" || {
    warn "platform-ops: no valid platform/VERSION under '${root}' — skipping install."
    return 0
  }
  # shellcheck disable=SC2119  # intentional: use uname -m default in production
  arch="$(platform_ops_arch)" || {
    warn "platform-ops: unsupported arch '$(uname -m)' — skipping install."
    return 0
  }
  bin="${PLATFORM_OPS_BIN:-/usr/local/bin/platform-ops}"
  pub_src="${PLATFORM_OPS_COSIGN_PUB_SRC:-${root}/platform/cosign.pub}"
  pub_dst="${PLATFORM_OPS_COSIGN_PUB_DST:-/etc/platform/cosign.pub}"

  # Idempotency: already at the target version → nothing to do, no re-fetch.
  if [ "$(platform_ops_installed_version "$bin")" = "$version" ]; then
    log "platform-ops: already at ${version} — skipping."
    return 0
  fi

  # Dormancy gate (the real state until the release pipeline lands): without an
  # in-repo signing key there is no trust anchor and no published asset.
  if [ ! -r "$pub_src" ]; then
    log "platform-ops: signing key not present (${pub_src}) — binary not yet published; skipping (expected until the platform-ops release pipeline lands)."
    return 0
  fi

  base="${PLATFORM_OPS_RELEASE_BASE:-https://github.com/${PLATFORM_OPS_REPO:-insulahq/insula}/releases/download/v${version}}"
  asset="${base}/platform-ops-linux-${arch}"
  sig_url="${asset}.sig"

  tmp="$(mktemp -d)"
  tmp_bin="${tmp}/platform-ops"; tmp_sig="${tmp}/platform-ops.sig"
  # Stage beside the final binary (same fs → atomic mv). Clean both the temp
  # dir AND any staged turd if mv never happens (e.g. interrupted mid-install).
  staged="${bin}.new.$$"
  trap 'rm -rf "$tmp"; rm -f "$staged"' RETURN

  if ! platform_ops_fetch "$asset" "$tmp_bin"; then
    warn "platform-ops: no asset for v${version} (${asset}) yet — skipping install."
    return 0
  fi
  if ! platform_ops_fetch "$sig_url" "$tmp_sig"; then
    warn "platform-ops: binary present but signature missing (${sig_url}) — refusing to install unverified binary."
    return 0
  fi
  if ! platform_ops_verify_blob "$tmp_bin" "$tmp_sig" "$pub_src"; then
    warn "platform-ops: cosign verification FAILED — refusing to install unverified binary."
    return 0
  fi

  # Verified. Persist the trust anchor, then atomically swap the binary into
  # place (mv within the same dir is atomic; no window with a partial file).
  mkdir -p "$(dirname "$pub_dst")"
  chmod 700 "$(dirname "$pub_dst")" 2>/dev/null \
    || warn "platform-ops: could not chmod 700 $(dirname "$pub_dst") — may be world-readable (non-fatal)."
  install -m 644 "$pub_src" "$pub_dst"
  mkdir -p "$(dirname "$bin")"
  install -m 755 "$tmp_bin" "$staged"
  mv -f "$staged" "$bin"
  log "platform-ops: installed ${version} (${arch}) → ${bin}; pubkey → ${pub_dst}."

  platform_ops_install_timer || warn "platform-ops: self-upgrade timer install failed (non-fatal)."
  return 0
}
