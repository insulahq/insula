#!/usr/bin/env bash
# idempotent: rewrites the timer only when it is still the daily shape bootstrap wrote; a second run finds OnCalendar=hourly and exits without touching systemd
# allow-paths: /etc/systemd/system/platform-ops-host-config.timer
set -euo pipefail

# Converge hourly instead of daily.
#
# The host-config converge is what applies a release's host-migrations. When one
# fails -- or is blocked behind a failure -- it is retried only on the next tick.
# At 'OnCalendar=daily' + 'RandomizedDelaySec=3600' that is up to ~25 hours of a
# cluster sitting on an unapplied migration with nothing surfaced anywhere. That
# is exactly how the 2026-08-05 staging failure went unnoticed: the post-upgrade
# converge exited 1 on all three nodes and the next automatic attempt would have
# been the following night.
#
# The converge is idempotent and costs about a second when nothing is pending, so
# an hourly tick is cheap insurance. The jitter is kept but narrowed to 15 min:
# enough to stop a large cluster stampeding the API at :00, small enough that
# "within the hour" means it.
#
# Fresh installs get this shape from scripts/lib/bootstrap-phases.sh; this
# migration is the existing-cluster half.

MIG=0002-host-config-converge-hourly
UNIT=/etc/systemd/system/platform-ops-host-config.timer

if [ ! -f "$UNIT" ]; then
  echo "${MIG}: ${UNIT} absent -- platform-ops timers not installed here, nothing to do."
  exit 0
fi

if grep -qE '^OnCalendar=hourly[[:space:]]*$' "$UNIT"; then
  echo "${MIG}: already OnCalendar=hourly -- no change."
  exit 0
fi

# Only rewrite the shape bootstrap wrote. An operator who deliberately retimed
# this keeps their setting: silently overwriting it would be indistinguishable
# from a bug the next time someone tuned it on purpose.
if ! grep -qE '^OnCalendar=daily[[:space:]]*$' "$UNIT"; then
  echo "${MIG}: OnCalendar is neither daily nor hourly -- operator-tuned, leaving it alone."
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
sed -e 's/^OnCalendar=daily[[:space:]]*$/OnCalendar=hourly/' \
    -e 's/^RandomizedDelaySec=3600[[:space:]]*$/RandomizedDelaySec=900/' \
    -e 's/^Description=Daily Insula platform-ops host-config converge[[:space:]]*$/Description=Hourly Insula platform-ops host-config converge/' \
    "$UNIT" > "$TMP"

# Verify the rewrite before installing it: a sed that silently matched nothing
# would otherwise leave the node on the daily schedule while this reports success.
if ! grep -qE '^OnCalendar=hourly[[:space:]]*$' "$TMP"; then
  echo "${MIG}: rewrite did not produce OnCalendar=hourly -- refusing to install it." >&2
  exit 1
fi

install -m 0644 "$TMP" "$UNIT"

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload 2>/dev/null || true
  # restart, not just reload, so the new schedule takes effect immediately rather
  # than after the old daily window elapses.
  systemctl restart platform-ops-host-config.timer 2>/dev/null \
    || echo "${MIG}: timer restart failed -- new schedule applies after the next daemon-reload." >&2
fi

echo "${MIG}: host-config converge timer daily -> hourly (jitter 3600s -> 900s)."
