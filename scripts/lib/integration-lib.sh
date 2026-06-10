#!/usr/bin/env bash
# integration-lib.sh — shared primitives for the integration harnesses.
#
# WHY: the 65 `integration-*.sh` harnesses are ~95% copy-paste. The most
# damaging duplication is the *poll loop*: nearly every suite re-implements
# "run a command every N seconds until it matches X, give up after T". Those
# hand-rolled loops have two chronic faults this lib fixes:
#   1. NO fail-fast — they wait the FULL deadline even when the thing being
#      waited on has already entered a TERMINAL failure state (CrashLoopBackOff,
#      task=failed, ReplicaFailure). A 300s wait that could have failed at 5s.
#   2. NO timing — you can't see which phase is the long pole.
#
# `il_wait_for` adds a FAIL_RX lever: a regex that, when matched, ABORTS the
# wait immediately as a failure. Plus per-phase timing and structured counters.
#
# OPT-IN and additive: existing harnesses keep working untouched. New or
# retrofitted ones `source` this near the top:
#
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-lib.sh"
#
# Commands passed to the poll helpers are `eval`'d (so pipelines work, matching
# the existing private-worker-helpers idiom). These are trusted, in-repo test
# commands — never interpolate untrusted input into them.

# Guard against double-source (harnesses may source several libs).
[[ -n "${_INTEGRATION_LIB_LOADED:-}" ]] && return 0
_INTEGRATION_LIB_LOADED=1

# ─── colours (respect NO_COLOR / non-tty) ────────────────────────────
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  IL_GREEN=$'\033[32m'; IL_RED=$'\033[31m'; IL_YELLOW=$'\033[33m'; IL_CYAN=$'\033[36m'; IL_RESET=$'\033[0m'
else
  IL_GREEN=''; IL_RED=''; IL_YELLOW=''; IL_CYAN=''; IL_RESET=''
fi

# ─── counters ────────────────────────────────────────────────────────
IL_PASS=0; IL_FAIL=0; IL_SKIP=0; IL_FAILED_NAMES=()
il_ok()   { IL_PASS=$((IL_PASS+1)); printf '  %s✓%s %s\n' "$IL_GREEN" "$IL_RESET" "$*"; }
il_fail() { IL_FAIL=$((IL_FAIL+1)); IL_FAILED_NAMES+=("$*"); printf '  %s✗%s %s\n' "$IL_RED" "$IL_RESET" "$*" >&2; }
il_skip() { IL_SKIP=$((IL_SKIP+1)); printf '  %s⊝%s %s\n' "$IL_YELLOW" "$IL_RESET" "$*"; }
il_info() { printf '  %s•%s %s\n' "$IL_CYAN" "$IL_RESET" "$*"; }

# il_summary [label] — print the tally; return 1 if any failures.
il_summary() {
  printf '\n%s── %s: %s%d passed%s, %s%d skipped%s, %s%d failed%s ──%s\n' \
    "$IL_CYAN" "${1:-results}" \
    "$IL_GREEN" "$IL_PASS" "$IL_RESET" \
    "$IL_YELLOW" "$IL_SKIP" "$IL_RESET" \
    "$IL_RED" "$IL_FAIL" "$IL_RESET" "$IL_RESET"
  (( IL_FAIL == 0 ))
}

# ─── fail-fast condition polling (the P2 core) ───────────────────────
# il_wait_for <deadline_s> <desc> <ok_rx> <fail_rx|-> <cmd-string>
#   Polls <cmd-string> every $IL_POLL_INTERVAL (default 4s) until ONE of:
#     • stdout matches <ok_rx>            → il_ok,  return 0
#     • <fail_rx> != '-' AND stdout
#       matches <fail_rx>                 → il_fail (TERMINAL), return 2  ← fail-fast
#     • deadline_s elapsed                → il_fail (timeout),  return 1
#   Pass '-' as <fail_rx> to disable the terminal check (pure wait-until).
#   <ok_rx> '' means "any successful exit of the command" (rare; prefer a rx).
il_wait_for() {
  local deadline="$1" desc="$2" ok_rx="$3" fail_rx="$4" cmd="$5"
  local interval="${IL_POLL_INTERVAL:-4}" waited=0 out
  while :; do
    out="$(eval "$cmd" 2>/dev/null)" || true
    if [[ -n "$ok_rx" ]] && grep -qE "$ok_rx" <<<"$out"; then
      il_ok "$desc (after ${waited}s)"; return 0
    fi
    if [[ "$fail_rx" != "-" && -n "$fail_rx" ]] && grep -qE "$fail_rx" <<<"$out"; then
      il_fail "$desc — TERMINAL failure after ${waited}s (matched /$fail_rx/)"; return 2
    fi
    if (( waited >= deadline )); then
      il_fail "$desc — timeout after ${deadline}s (wanted /$ok_rx/)"; return 1
    fi
    sleep "$interval"; waited=$((waited+interval))
  done
}

# il_wait_http <deadline_s> <url> <ok_status> [fail_status_rx]
#   Polls curl until HTTP status == <ok_status>; aborts early if the status
#   matches <fail_status_rx> (e.g. '^4' to bail on any 4xx). -k for the
#   cert-issuance window. Honours $IL_POLL_INTERVAL.
il_wait_http() {
  local deadline="$1" url="$2" ok="$3" fail_rx="${4:-}"
  local interval="${IL_POLL_INTERVAL:-5}" waited=0 code
  while :; do
    code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo 000)
    if [[ "$code" == "$ok" ]]; then il_ok "GET $url → $code (after ${waited}s)"; return 0; fi
    if [[ -n "$fail_rx" && "$code" =~ $fail_rx ]]; then
      il_fail "GET $url → $code (terminal, after ${waited}s)"; return 2
    fi
    if (( waited >= deadline )); then
      il_fail "GET $url never reached $ok within ${deadline}s (last=$code)"; return 1
    fi
    sleep "$interval"; waited=$((waited+interval))
  done
}

# ─── per-phase timing (P4) ───────────────────────────────────────────
# Usage:  il_phase_begin "create tenant"   …work…   il_phase_end
# Records each phase's wall time; il_timings_json emits the array.
IL_PHASE_NAMES=(); IL_PHASE_SECS=(); _il_phase_name=""; _il_phase_start=0
il_phase_begin() {
  _il_phase_name="$1"; _il_phase_start=$(date +%s)
  printf '%s▸ %s%s\n' "$IL_CYAN" "$_il_phase_name" "$IL_RESET"
}
il_phase_end() {
  [[ -z "$_il_phase_name" ]] && return 0
  local secs=$(( $(date +%s) - _il_phase_start ))
  IL_PHASE_NAMES+=("$_il_phase_name"); IL_PHASE_SECS+=("$secs")
  il_info "phase '$_il_phase_name' took ${secs}s"
  _il_phase_name=""
}
# il_timings_json → [{"phase":...,"seconds":N}, ...]  (empty array if none)
il_timings_json() {
  local i out="["
  for i in "${!IL_PHASE_NAMES[@]}"; do
    [[ "$out" != "[" ]] && out+=","
    out+="{\"phase\":$(_il_jstr "${IL_PHASE_NAMES[$i]}"),\"seconds\":${IL_PHASE_SECS[$i]}}"
  done
  printf '%s]' "$out"
}
# minimal JSON string escaper (no jq dependency in the hot path)
_il_jstr() { printf '"%s"' "${1//\"/\\\"}"; }

# ─── cleanup-trap registration ───────────────────────────────────────
# il_on_cleanup "<command-string>" — pushed onto a LIFO stack run by
# il_run_cleanups (wire it: trap il_run_cleanups EXIT). Safe to register
# many; each is eval'd best-effort.
IL_CLEANUPS=()
il_on_cleanup() { IL_CLEANUPS+=("$1"); }
il_run_cleanups() {
  local i
  for (( i=${#IL_CLEANUPS[@]}-1; i>=0; i-- )); do
    eval "${IL_CLEANUPS[$i]}" >/dev/null 2>&1 || true
  done
  IL_CLEANUPS=()
}
