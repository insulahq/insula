#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/lab-state.sh — the lab's persistent state file.
#
# The lab's services keep their credentials for life (unlike a throw-away run,
# whose services VM regenerates them per run): a PowerDNS API key that a cluster's
# DNS provider row holds, S3 keys a backup target holds, the step-ca password, the
# clusters' admin passwords. They are generated ONCE and kept in LAB_STATE_FILE
# (0600, outside the repo). Values are shell-quoted (`%q`), so the file is sourced.

lab_state_load() {
  # shellcheck source=/dev/null
  [[ -r "$LAB_STATE_FILE" ]] && source "$LAB_STATE_FILE"
  return 0
}

# lab_state_set <name> <value> — set (or replace) one entry, keep the file 0600.
lab_state_set() {
  local name="$1" value="$2" tmp
  mkdir -p "$(dirname "$LAB_STATE_FILE")"
  tmp="$(mktemp "${LAB_STATE_FILE}.XXXXXX")"
  chmod 0600 "$tmp"
  # grep exits 1 when every line was filtered out — not an error here.
  if [[ -r "$LAB_STATE_FILE" ]]; then grep -v "^${name}=" "$LAB_STATE_FILE" > "$tmp" || true; fi
  printf '%s=%q\n' "$name" "$value" >> "$tmp"
  mv -f "$tmp" "$LAB_STATE_FILE"
  printf -v "$name" '%s' "$value"
}

# lab_state_secret <name> [hex-chars] — the stored value, generated on first use.
lab_state_secret() {
  local name="$1" len="${2:-32}"
  lab_state_load
  if [[ -z "${!name:-}" ]]; then
    lab_state_set "$name" "$(openssl rand -hex "$(( (len + 1) / 2 ))" | cut -c1-"$len")"
  fi
  printf '%s' "${!name}"
}
