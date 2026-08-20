#!/usr/bin/env bash
# idempotent: greps for the ExecStartPost line and exits 0 when already present;
#             the write is a temp-file + atomic mv, so a re-run is a no-op and a
#             partially-written unit is never left behind.
# allow-paths: /etc/systemd/system/platform-ops-update.service
# blocks-on-failure: no    # ADR-056: nothing later depends on this; a node that
#                          # misses it still converges on its hourly timer.
set -euo pipefail

# 2026.8.7 — an upgrade now triggers a host-config converge on completion, so
# host state stops lagging the platform version by up to an hour.
#
# bootstrap.sh writes this unit ONCE at install time, so the ExecStartPost added
# to scripts/lib/bootstrap-phases.sh reaches FRESH installs only. Existing nodes
# need this migration or the auto-trigger silently never applies to them.

UNIT=/etc/systemd/system/platform-ops-update.service
LINE='ExecStartPost=-/usr/bin/systemctl start --no-block platform-ops-host-config.service'

# A node that has no self-upgrade unit (agent-only install, unit intentionally
# removed) is not an error — there is nothing to amend.
if [ ! -f "$UNIT" ]; then
  echo "0001-converge-on-self-upgrade: ${UNIT} absent — nothing to do"
  exit 0
fi

# Idempotence: already carries the trigger (fresh install, or a re-run).
if grep -qF -- "$LINE" "$UNIT"; then
  echo "0001-converge-on-self-upgrade: already present — no-op"
  exit 0
fi

# Defensive: only amend a unit that actually has a [Service] section to append
# to. Anything else is not the unit we wrote, so leave it alone rather than
# corrupt an operator's customised file.
if ! grep -q '^\[Service\]' "$UNIT"; then
  echo "0001-converge-on-self-upgrade: ${UNIT} has no [Service] section — refusing to edit" >&2
  exit 1
fi

tmp="$(mktemp "${UNIT}.mig.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

# Append the trigger as the LAST ExecStartPost/ExecStart directive of [Service]:
# insert immediately before the first section header that follows [Service], or
# at EOF when [Service] is the final section.
# Blank lines inside [Service] are buffered so the directive is appended to the
# last real directive rather than stranded against the next section header.
awk -v line="$LINE" '
  /^\[Service\]/            { in_svc = 1; print; next }
  in_svc && /^[[:space:]]*$/ { blanks = blanks $0 "\n"; next }
  in_svc && /^\[/           { print line; printf "%s", blanks; blanks = ""
                              in_svc = 0; print; next }
  in_svc                    { printf "%s", blanks; blanks = ""; print; next }
                            { print }
  END                       { if (in_svc) { print line; printf "%s", blanks } }
' "$UNIT" > "$tmp"

# Never install a unit we failed to amend (awk succeeded but produced nothing
# useful) — verify the line landed and the file is not truncated.
if ! grep -qF -- "$LINE" "$tmp"; then
  echo "0001-converge-on-self-upgrade: amendment did not take — leaving ${UNIT} untouched" >&2
  exit 1
fi
if [ "$(wc -l < "$tmp")" -lt "$(wc -l < "$UNIT")" ]; then
  echo "0001-converge-on-self-upgrade: rewritten unit is shorter than the original — refusing" >&2
  exit 1
fi

chmod 0644 "$tmp"
mv -f "$tmp" "$UNIT"
trap - EXIT

systemctl daemon-reload || true
echo "0001-converge-on-self-upgrade: self-upgrade now triggers a host-config converge"
