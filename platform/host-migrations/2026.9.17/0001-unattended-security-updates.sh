#!/usr/bin/env bash
# idempotent: every write is content-compared first (cmp -s for the apt files,
#             grep -q for the dnf keys) and `systemctl enable` is itself
#             idempotent, so a node that already has the config writes nothing
#             and re-runs are free. Installing the package is a no-op once
#             present (checked with command -v before any package manager runs).
# allow-paths: /etc/apt/apt.conf.d/20auto-upgrades
#              /etc/apt/apt.conf.d/99platform-unattended-upgrades
#              /etc/dnf/automatic.conf
# blocks-on-failure: no    # ADR-056: nothing later depends on this. A node that
#                          # fails here keeps its current patch cadence (i.e. the
#                          # status quo ante) and retries on the next pass —
#                          # degraded patching, not an outage. Blocking the whole
#                          # migration chain on it would be worse than the gap.
set -euo pipefail

# 2026.9.17 — install and enable unattended OS security updates on already-
# installed clusters.
#
# bootstrap.sh now installs unattended-upgrades / dnf-automatic and writes the
# config, but that reaches FRESH INSTALLS ONLY — an existing node keeps whatever
# it was installed with, which was nothing.
#
# The failure this closes was invisible from the outside. Debian's stock
# apt-daily.timer and apt-daily-upgrade.timer are enabled out of the box, so
# `systemctl list-timers` showed a daily "apt upgrade" job with recent,
# successful runs. But apt.systemd.daily consults
# APT::Periodic::Unattended-Upgrade, which was never set, and the package that
# performs the upgrade step was never installed. The timers fired every day and
# installed nothing. Measured on the production node 2026-09-11: 21 upgradable,
# 20 of them security, including libssl3t64 and libexpat1.
#
# NO AUTOMATIC REBOOT — deliberately. A kernel or libssl update needs a restart
# to take effect, and on a single-node cluster an unattended reboot is an
# unannounced outage. Patches are installed; taking them into use stays a
# planned, operator-driven drain.
#
# Keep byte-identical with configure_auto_updates() in scripts/bootstrap.sh.

log() { echo "unattended-security-updates: $*"; }

# write_if_changed DEST <<'EOF' ... EOF — writes only on a content difference.
write_if_changed() {
  local dest="$1" tmp
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' RETURN
  cat > "$tmp"
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    log "${dest} already current"
    return 0
  fi
  install -m 0644 "$tmp" "$dest"
  log "wrote ${dest}"
}

# Set KEY = VALUE in a dnf-automatic ini, replacing an existing assignment or
# appending under [commands]. No-op when the value already matches.
set_dnf_key() {
  local file="$1" key="$2" val="$3"
  if grep -qE "^[[:space:]]*${key}[[:space:]]*=[[:space:]]*${val}[[:space:]]*$" "$file"; then
    log "${key} already ${val}"
    return 0
  fi
  if grep -qE "^[[:space:]]*${key}[[:space:]]*=" "$file"; then
    sed -i -E "s|^[[:space:]]*${key}[[:space:]]*=.*|${key} = ${val}|" "$file"
  elif grep -qE '^\[commands\]' "$file"; then
    sed -i -E "s|^\[commands\]|[commands]\n${key} = ${val}|" "$file"
  else
    printf '[commands]\n%s = %s\n' "$key" "$val" >> "$file"
  fi
  log "set ${key} = ${val}"
}

if command -v apt-get >/dev/null 2>&1; then
  if ! command -v unattended-upgrade >/dev/null 2>&1 \
    && ! command -v unattended-upgrades >/dev/null 2>&1; then
    log "installing unattended-upgrades"
    export DEBIAN_FRONTEND=noninteractive
    # Do NOT `apt-get update` unconditionally here: apt-daily.timer already
    # refreshes lists daily, and a failing mirror must not fail the migration.
    if ! apt-get install -y -qq unattended-upgrades >/dev/null 2>&1; then
      apt-get update -qq >/dev/null 2>&1 || true
      apt-get install -y -qq unattended-upgrades >/dev/null 2>&1 || {
        log "WARNING: could not install unattended-upgrades — leaving node as-is"
        exit 0
      }
    fi
  else
    log "unattended-upgrades already installed"
  fi

  write_if_changed /etc/apt/apt.conf.d/20auto-upgrades <<'AUTOUPGRADES'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTOUPGRADES

  # 99- so it is read LAST and wins over the distro's 50unattended-upgrades.
  # Overrides ONLY reboot/mail behaviour — the shipped default already scopes
  # Origins-Pattern to the running distro's -security suite, and hand-written
  # origin patterns are how you silently match nothing after a distro upgrade.
  write_if_changed /etc/apt/apt.conf.d/99platform-unattended-upgrades <<'PLATFORMUU'
// Managed by Insula bootstrap.sh / host-migrations. Security updates are
// installed automatically; the reboot they may require is NOT taken
// automatically — see configure_auto_updates() in bootstrap.sh.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "false";
Unattended-Upgrade::Mail "";
PLATFORMUU

  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 \
    || log "WARNING: could not enable apt-daily timers"
  log "apt unattended security updates configured"

elif command -v dnf >/dev/null 2>&1; then
  if ! command -v dnf-automatic >/dev/null 2>&1; then
    log "installing dnf-automatic"
    dnf install -y -q dnf-automatic >/dev/null 2>&1 || {
      log "WARNING: could not install dnf-automatic — leaving node as-is"
      exit 0
    }
  else
    log "dnf-automatic already installed"
  fi

  conf=/etc/dnf/automatic.conf
  if [ -f "$conf" ]; then
    set_dnf_key "$conf" upgrade_type security
    set_dnf_key "$conf" apply_updates yes
    set_dnf_key "$conf" reboot never
  else
    log "WARNING: ${conf} missing — skipping dnf-automatic configuration"
  fi

  systemctl enable --now dnf-automatic.timer >/dev/null 2>&1 \
    || systemctl enable --now dnf-automatic-install.timer >/dev/null 2>&1 \
    || log "WARNING: no dnf-automatic timer found to enable"
  log "dnf unattended security updates configured"

else
  log "neither apt-get nor dnf found — unsupported host, nothing to do"
fi

exit 0
