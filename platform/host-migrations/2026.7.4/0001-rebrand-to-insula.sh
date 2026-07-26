#!/usr/bin/env bash
# idempotent: every step guards on its end state (binary exists / path already a
#   symlink to the branded root / ExecStart already re-pointed). A re-run after
#   success touches nothing. Partial-apply re-does only the unfinished steps.
# allow-paths: /usr/local/bin/insula /usr/local/bin/platform-ops /var/lib/insula /etc/insula /var/lib/platform /var/lib/hosting-platform /etc/platform /etc/hosting-platform /etc/systemd/system/platform-ops-update.service /etc/systemd/system/platform-ops-host-config.service
#
# ADR-055 rebrand — bring an EXISTING node onto the insula-branded binary + host
# footprint. Fresh installs already get this from bootstrap.sh
# (configure_branded_paths + PLATFORM_OPS_BIN=/usr/local/bin/insula); this is the
# in-place equivalent for nodes provisioned before the rename.
#
# TWO invariants make this safe (see ADR-055):
#   * The code's path CONSTANTS are unchanged (/var/lib/platform, /etc/platform,
#     …). We make the branded roots the REAL storage and turn the generic roots
#     into symlinks INTO them — so host-migration markers, the secrets bundle, the
#     cosign anchor, and credentials all resolve through the SAME inode before AND
#     after. No marker is ever "missing" → no migration re-runs.
#   * Binary/paths are re-pointed with symlinks (+ one atomic dir merge), never a
#     from-scratch move that could strand the marker tree or the DR bundle.
#
# SELF-REFERENCE: this migration is run by platform-ops-host-config.service
# (ExecStart=/usr/local/bin/platform-ops host-config apply). We re-point that unit
# to /usr/local/bin/insula here — safe because the running invocation is unaffected
# (already started), the platform-ops→insula symlink keeps the old path valid, and
# systemd re-reads the unit on the next timer fire.
set -euo pipefail

log() { echo "host-migration(rebrand-to-insula): $*"; }

# ── 1. Branded roots exist ───────────────────────────────────────────────────
install -d -m 0755 /var/lib/insula
install -d -m 0700 /etc/insula

# ── 2. Consolidate each generic root INTO its branded root, then symlink back ──
# Merge (not clobber): our four roots share no filenames, so entries move cleanly.
consolidate() {
  local generic="$1" branded="$2" entry base
  # Already the compat symlink → done.
  if [ -L "$generic" ]; then
    log "$generic already a symlink — skipping."
    return 0
  fi
  # Nothing at the generic path → just leave the branded root (bootstrap/other
  # migrations will populate it); create the compat symlink for uniformity.
  if [ ! -e "$generic" ]; then
    ln -s "$branded" "$generic"
    log "$generic absent — created compat symlink → $branded."
    return 0
  fi
  # A real directory: move its contents into the branded root (atomic per entry
  # on the same filesystem — host-migrations/ and snapshots/ are dir-renames, not
  # copies), then replace the now-empty dir with the compat symlink.
  if [ -d "$generic" ]; then
    shopt -s dotglob nullglob
    for entry in "$generic"/*; do
      base="$(basename "$entry")"
      if [ -e "$branded/$base" ]; then
        log "WARNING: $branded/$base already exists — leaving $entry for manual review."
      else
        mv "$entry" "$branded/$base"
      fi
    done
    shopt -u dotglob nullglob
    if rmdir "$generic" 2>/dev/null; then
      ln -s "$branded" "$generic"
      log "$generic consolidated into $branded (symlinked)."
    else
      log "WARNING: $generic not empty after merge — left in place (manual review)."
    fi
  else
    log "WARNING: $generic exists but is not a directory — left in place."
  fi
}
consolidate /var/lib/platform          /var/lib/insula
consolidate /var/lib/hosting-platform  /var/lib/insula
consolidate /etc/platform              /etc/insula
consolidate /etc/hosting-platform      /etc/insula

# ── 3. Branded binary name + compat symlink ──────────────────────────────────
# self-upgrade already installed the new code to /usr/local/bin/platform-ops
# (old ExecStart). Copy it to the branded name, then make platform-ops a symlink.
if [ -x /usr/local/bin/platform-ops ] && [ ! -e /usr/local/bin/insula ]; then
  cp -a /usr/local/bin/platform-ops /usr/local/bin/insula
  log "installed /usr/local/bin/insula (copy of platform-ops)."
fi
if [ -x /usr/local/bin/insula ] && [ -e /usr/local/bin/platform-ops ] && [ ! -L /usr/local/bin/platform-ops ]; then
  rm -f /usr/local/bin/platform-ops
  ln -s /usr/local/bin/insula /usr/local/bin/platform-ops
  log "/usr/local/bin/platform-ops → insula (compat symlink)."
fi

# ── 4. Re-point the systemd units' ExecStart to the branded binary ───────────
reloaded=0
for unit in platform-ops-update platform-ops-host-config; do
  f="/etc/systemd/system/${unit}.service"
  if [ -f "$f" ] && grep -q '/usr/local/bin/platform-ops' "$f"; then
    sed -i 's#/usr/local/bin/platform-ops#/usr/local/bin/insula#g' "$f"
    log "re-pointed ${unit}.service ExecStart → /usr/local/bin/insula."
    reloaded=1
  fi
done
if [ "$reloaded" = 1 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || log "WARNING: systemctl daemon-reload failed (non-fatal — re-read on next boot)."
fi

log "rebrand complete (binary=insula, host roots=/var/lib/insula + /etc/insula, generic paths symlinked)."
