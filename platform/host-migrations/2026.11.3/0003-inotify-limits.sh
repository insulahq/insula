#!/usr/bin/env bash
# description: Raises the node's inotify limits to what the platform declares (8192 instances, 524288 watches) without lowering a higher value, so file watchers such as CrowdSec stop failing to start.
# idempotent: the drop-in is rendered from the live values and replaced only when its content differs; a value the kernel already holds above the declared one is kept, so a re-run after success writes nothing and changes nothing.
# allow-paths: /etc/sysctl.d/99-platform-inotify.conf
# blocks-on-failure: no    # ADR-056: on failure the node keeps its current limits and the next converge retries; no later migration depends on this one.
# phase: before-services    # ADR-064: a host sysctl; needs nothing from the new release's manifests
set -euo pipefail

# Backfills bootstrap.sh's configure_inotify_limits onto EXISTING clusters.
#
# WHY: every node ran the kernel default fs.inotify.max_user_instances = 128.
# host-config-desired declares 8192 (and max_user_watches 524288), but the sysctl
# converger only reports drift, and nothing wrote the values. Each containerd shim
# and most controllers hold an inotify instance, so a busy node runs out; then a
# starting crowdsec-agent dies with "could not create fsnotify watcher: couldn't
# initialize inotify: too many open files". That was seen on lab staging (a node at
# 127 of 128, crash-looping) and on DEV during a CrowdSec roll.
#
# The limit is per user and costs no memory until instances or watches are used.
# max_user_watches already scales with RAM on kernels >= 5.11 and can sit above
# 524288, so each value is the larger of the live value and the declared one: this
# only ever raises.

MIG="inotify-limits"
CONF="/etc/sysctl.d/99-platform-inotify.conf"
WANT_INSTANCES=8192
WANT_WATCHES=524288

read_sysctl() { tr -d '[:space:]' < "/proc/sys/fs/inotify/$1"; }
cur_i="$(read_sysctl max_user_instances)"
cur_w="$(read_sysctl max_user_watches)"
case "$cur_i$cur_w" in *[!0-9]*|"") echo "${MIG}: could not read the live inotify limits (got '${cur_i}' / '${cur_w}')." >&2; exit 1 ;; esac
i=$(( cur_i > WANT_INSTANCES ? cur_i : WANT_INSTANCES ))
w=$(( cur_w > WANT_WATCHES ? cur_w : WANT_WATCHES ))

render() {
  printf '%s\n' \
    "# Managed by the platform (host-migration 2026.11.3/0003; bootstrap.sh" \
    "# configure_inotify_limits on fresh installs). The values host-config-desired" \
    "# declares, or the kernel's own when it already held more. Edit to override." \
    "fs.inotify.max_user_instances = ${i}" \
    "fs.inotify.max_user_watches = ${w}"
}

if [ -f "$CONF" ] && [ "$(cat "$CONF")" = "$(render)" ] \
   && [ "$cur_i" -ge "$WANT_INSTANCES" ] && [ "$cur_w" -ge "$WANT_WATCHES" ]; then
  echo "${MIG}: ${CONF} in place and live (instances ${cur_i}, watches ${cur_w}) — nothing to do."
  exit 0
fi

install -d -m 0755 /etc/sysctl.d
tmp="$(mktemp "${CONF}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
render > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$CONF"
trap - EXIT

# Apply this file alone (sysctl --system would re-apply every drop-in on the node).
sysctl -q -p "$CONF"

now_i="$(read_sysctl max_user_instances)"
now_w="$(read_sysctl max_user_watches)"
if [ "$now_i" -lt "$WANT_INSTANCES" ] || [ "$now_w" -lt "$WANT_WATCHES" ]; then
  echo "${MIG}: wrote ${CONF} but the kernel reports instances ${now_i}, watches ${now_w}." >&2
  exit 1
fi

# A drop-in sorting after this one, in any sysctl.d directory, would set the keys
# again at the next boot. Say so; the operator owns that file.
for d in /etc/sysctl.d /run/sysctl.d /usr/local/lib/sysctl.d /usr/lib/sysctl.d /lib/sysctl.d; do
  for f in "$d"/*.conf; do
    [ -f "$f" ] || continue
    [ "$(basename "$f")" \> "$(basename "$CONF")" ] || continue
    if grep -qE '^[[:space:]]*fs\.inotify\.max_user_(instances|watches)' "$f"; then
      echo "${MIG}: note — ${f} sorts after ${CONF} and also sets an inotify limit; it wins at boot." >&2
    fi
  done
done

echo "${MIG}: inotify limits now instances ${now_i} (was ${cur_i}), watches ${now_w} (was ${cur_w})."
exit 0
