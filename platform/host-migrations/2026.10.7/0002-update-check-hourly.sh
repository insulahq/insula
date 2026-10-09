#!/usr/bin/env bash
# description: Runs the node's update check hourly instead of daily, so a node an upgrade left out catches up within the hour.
# idempotent: rewrites the timer only while it is still the daily shape bootstrap wrote; a second run finds OnCalendar=hourly and exits without touching systemd
# allow-paths: /etc/systemd/system/platform-ops-update.timer
# blocks-on-failure: no    # ADR-056: nothing later depends on the timer's schedule; a node left on the daily check still updates, just later.
# phase: before-services    # ADR-064: a timer schedule; indifferent to which release the services run.
set -euo pipefail

# Check for a new release hourly instead of daily.
#
# The update timer is how a node fetches the insula CLI of the release its
# cluster runs — and with it that release's host-migrations. At OnCalendar=daily
# + RandomizedDelaySec=3600 a node applied a release's host changes up to ~25 h
# after the release's containers rolled. ADR-064 makes the upgrade itself push
# the release to every node; this timer becomes the safety net for a node that
# push missed (offline, or excluded by the operator), so "the next check" must
# mean within the hour. The check is one ConfigMap read when nothing changed.
#
# Fresh installs get this shape from scripts/lib/bootstrap-phases.sh; this
# migration is the existing-cluster half.

MIG=0002-update-check-hourly
UNIT=/etc/systemd/system/platform-ops-update.timer

if [ ! -f "$UNIT" ]; then
  echo "${MIG}: ${UNIT} absent -- platform-ops timers not installed here, nothing to do."
  exit 0
fi

if grep -qE '^OnCalendar=hourly[[:space:]]*$' "$UNIT"; then
  echo "${MIG}: already OnCalendar=hourly -- no change."
  exit 0
fi

# Only rewrite the shape bootstrap wrote. An operator who deliberately retimed
# this keeps their setting.
if ! grep -qE '^OnCalendar=daily[[:space:]]*$' "$UNIT"; then
  echo "${MIG}: OnCalendar is neither daily nor hourly -- operator-tuned, leaving it alone."
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
sed -e 's/^OnCalendar=daily[[:space:]]*$/OnCalendar=hourly/' \
    -e 's/^RandomizedDelaySec=3600[[:space:]]*$/RandomizedDelaySec=900/' \
    -e 's/^Description=Daily Insula platform-ops self-upgrade check[[:space:]]*$/Description=Hourly Insula platform-ops self-upgrade check/' \
    "$UNIT" > "$TMP"

# Verify before installing: a sed that matched nothing would leave the node on the
# daily schedule while this reports success.
if ! grep -qE '^OnCalendar=hourly[[:space:]]*$' "$TMP"; then
  echo "${MIG}: rewrite did not produce OnCalendar=hourly -- refusing to install it." >&2
  exit 1
fi

install -m 0644 "$TMP" "$UNIT"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload 2>/dev/null || true
  # restart, not reload: the new schedule takes effect now, not after the old
  # daily window elapses.
  systemctl restart platform-ops-update.timer 2>/dev/null \
    || echo "${MIG}: timer restart failed -- new schedule applies after the next daemon-reload." >&2
fi

echo "${MIG}: update check timer daily -> hourly (jitter 3600s -> 900s)."
