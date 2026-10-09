#!/usr/bin/env bash
# idempotent: moves firewall.conf only while it is a regular file at the old path and (re)creates the compat symlink only when it is missing or points elsewhere; a converged node (directory present, file in it, old path already the relative symlink) writes nothing and exits 0.
# allow-paths: /etc/hosting-platform/firewall /etc/hosting-platform/firewall/firewall.conf /etc/hosting-platform/firewall.conf
# blocks-on-failure: no    # ADR-056: only the security-probe reads this file, and the probe falls back to the old path; nothing later depends on this script.
set -euo pipefail

# Give firewall.conf a directory of its own, so the security-probe can mount
# just that directory.
#
# The probe used to mount all of /etc/hosting-platform to read this one file.
# Since the ADR-055 rebrand (2026.7.4/0001) that path is a symlink to
# /etc/insula, which also holds the admin, Stalwart, Valkey and Roundcube
# credential files — so every probe pod had them mounted, readable by its
# uid 0. The probe now mounts /etc/hosting-platform/firewall only.
#
# The old path stays as a RELATIVE symlink (firewall/firewall.conf): a probe
# pod still running the previous release mounts the whole directory, and a
# relative link resolves inside its mount where an absolute one would not.
# `mv` keeps the inode, so the new probe's fallback mount of the old file keeps
# seeing the content across the move too.
#
# bootstrap.sh (configure_firewall) writes the same layout on fresh nodes.
# Runs on every node: every node gets the firewall phase.

MIG="firewall-conf-own-directory"
ROOT=/etc/hosting-platform
DIR="$ROOT/firewall"
OLD="$ROOT/firewall.conf"
NEW="$DIR/firewall.conf"
LINK_TARGET="firewall/firewall.conf"

if [[ ! -e "$ROOT" && ! -L "$ROOT" ]]; then
  echo "${MIG}: $ROOT does not exist on this node — nothing to move."
  exit 0
fi

# The kubelet may already have created the directory for the new probe mount
# (hostPath DirectoryOrCreate, mode 0755) — install -d leaves it as it is.
install -d -m 0755 "$DIR"

if [[ -e "$NEW" && ! -f "$NEW" ]]; then
  echo "${MIG}: $NEW exists and is not a regular file — refusing to move firewall.conf onto it." >&2
  exit 1
fi

if [[ -f "$OLD" && ! -L "$OLD" ]]; then
  # A regular file at the old path is the newest copy: either this node was
  # never converted, or something rewrote the symlink in place (GNU `sed -i`
  # replaces a symlink with a regular file).
  mv -f "$OLD" "$NEW"
  chmod 0644 "$NEW"
  echo "${MIG}: moved $OLD to $NEW"
fi

if [[ -L "$OLD" && "$(readlink "$OLD")" == "$LINK_TARGET" ]]; then
  :
elif [[ -e "$OLD" && ! -L "$OLD" ]]; then
  echo "${MIG}: $OLD exists and is not a regular file or symlink — refusing to replace it." >&2
  exit 1
elif [[ -e "$NEW" ]]; then
  ln -sfn "$LINK_TARGET" "$OLD"
  echo "${MIG}: $OLD now links to $LINK_TARGET"
fi

# Proof, not a self-report.
if [[ ! -e "$NEW" ]]; then
  # Nothing to move and nothing to prove: this node has no posture file
  # anywhere (or only a link to one that was deleted). The probe reports the
  # posture as unknown; bootstrap's firewall phase is what writes the file.
  echo "${MIG}: no firewall.conf on this node — the security probe will report its SSH posture as unknown until bootstrap's firewall phase rewrites it."
  exit 0
fi
if ! cmp -s "$OLD" "$NEW"; then
  echo "${MIG}: $OLD does not resolve to $NEW after the move." >&2
  exit 1
fi
