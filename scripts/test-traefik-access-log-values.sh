#!/usr/bin/env bash
# The Traefik access log is configured in two places that must agree:
#   - bootstrap.sh's TRAEFIKVALUES heredoc (fresh installs)
#   - platform/host-migrations/2026.10.3/0002-traefik-access-log-helm-values.sh
#     (existing clusters, embedded DESIRED values)
# and the chart renders nothing unless accessLog.enabled is true — the defect
# that left every install without an access log while its values looked right.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOT="$HERE/scripts/bootstrap.sh"
MIG="$HERE/platform/host-migrations/2026.10.3/0002-traefik-access-log-helm-values.sh"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }
command -v yq >/dev/null 2>&1 && yq --version 2>/dev/null | grep -q mikefarah \
  || { echo "FAIL: mikefarah yq v4 required"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sed -n "/<<'TRAEFIKVALUES'/,/^TRAEFIKVALUES$/p" "$BOOT" | sed '1d;$d' > "$WORK/values.yaml"
[[ -s "$WORK/values.yaml" ]] || { echo "FAIL: TRAEFIKVALUES heredoc not found in bootstrap.sh"; exit 1; }
yq -o=json '{"accessLog": .accessLog, "additionalVolumeMounts": .additionalVolumeMounts,
  "deployment": {"additionalVolumes": .deployment.additionalVolumes,
                 "initContainers": .deployment.initContainers}}' "$WORK/values.yaml" \
  | jq -S . > "$WORK/boot.json"
sed -n "/<<'DESIREDJSON'/,/^DESIREDJSON$/p" "$MIG" | sed '1d;$d' | jq -S . > "$WORK/mig.json"

[[ "$(jq -r '.accessLog.enabled' "$WORK/boot.json")" == "true" ]] \
  && ok "bootstrap sets accessLog.enabled: true (the chart renders nothing without it)" \
  || no "bootstrap's accessLog.enabled is not true"
[[ "$(jq -r '.accessLog.filePath' "$WORK/boot.json")" == "/var/log/traefik/access.log" ]] \
  && ok "bootstrap writes the file the CrowdSec agent tails" || no "unexpected accessLog.filePath"
if diff -u "$WORK/boot.json" "$WORK/mig.json" > "$WORK/diff.txt"; then
  ok "migration DESIRED values == bootstrap's fresh-install values"
else
  no "migration and bootstrap disagree:"; sed 's/^/      /' "$WORK/diff.txt"
fi
grep -q -- '--reuse-values' "$MIG" && grep -q -- '--version "${deployed_ver}"' "$MIG" \
  && ok "migration keeps the release values and never moves the chart" \
  || no "migration must use --reuse-values and pin the deployed chart version"

# ── Retention: bootstrap's fragment/units == the 2026.10.3/0003 migration's ──
RET="$HERE/platform/host-migrations/2026.10.3/0003-traefik-access-log-retention.sh"
boot_var() { # <DELIM> — body of bootstrap's heredoc with that delimiter
  local body; body="$(sed -n "/<<'$1'\$/,/^$1\$/p" "$BOOT" | sed '1d;$d')"
  [[ -n "$body" ]] && printf '%s\n' "$body" || echo "<missing heredoc $1>"
}
mig_heredoc() { sed -n "/<<'$1'/,/^$1\$/p" "$RET" | sed '1d;$d'; }
for pair in TRAEFIKLOGROTATE:FRAGMENT TRAEFIKLOGROTATESERVICE:SERVICE TRAEFIKLOGROTATETIMER:TIMER; do
  v="${pair%%:*}"; h="${pair#*:}"
  if diff -u <(boot_var "$v") <(mig_heredoc "$h") > "$WORK/rdiff.txt"; then
    ok "retention ${h,,}: bootstrap == migration"
  else
    no "retention ${h,,} differs:"; sed 's/^/      /' "$WORK/rdiff.txt"
  fi
done
frag="$(boot_var TRAEFIKLOGROTATE)"
grep -qE '^\s+maxage 30$' <<<"$frag" && grep -qE '^\s+rotate 30$' <<<"$frag" && grep -qE '^\s+daily$' <<<"$frag" \
  && ok "access log kept 30 days and reaped after (daily, rotate 30, maxage 30)" \
  || no "retention is not daily/rotate 30/maxage 30"
grep -qE '^\s+copytruncate$' <<<"$frag" \
  && ok "copytruncate — Traefik and the CrowdSec tail keep their open file" \
  || no "missing copytruncate (Traefik would keep writing to the rotated inode)"
command -v logrotate >/dev/null 2>&1 && {
  printf '%s\n' "$frag" | sed "s#/var/log/traefik/access.log#$WORK/access.log#; /su root root/d" > "$WORK/frag.conf"
  : > "$WORK/access.log"
  logrotate -d -s "$WORK/status" "$WORK/frag.conf" >/dev/null 2>&1 \
    && ok "logrotate parses the fragment" || no "logrotate -d rejects the fragment"
}

echo; echo "traefik access-log values: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
