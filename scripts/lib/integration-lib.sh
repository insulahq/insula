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

# ─── process liveness (ZOMBIE-SAFE) ──────────────────────────────────
# A finished-but-unreaped child lingers as a ZOMBIE (state 'Z', shown as
# `<defunct>`): it still holds a PID slot, so BOTH `kill -0 <pid>` AND
# `ps -p <pid>` report it "alive". Any `while kill -0 $pid; …` or
# `while ps -p $pid; …` wait loop therefore HANGS FOREVER when the parent
# never reaps the child — e.g. a `nohup … &` job orphaned to a PID 1 that
# does not reap (common in containers). The ONLY robust test is the process
# STATE: treat 'Z' (and a vanished PID) as dead. Use these instead of
# hand-rolling `kill -0` / `ps -p` liveness checks.
il_pid_alive() {  # <pid> → 0 iff running AND not a zombie
  local pid="${1:-}" st=""
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  if [[ -r "/proc/$pid/stat" ]]; then
    # /proc/<pid>/stat: state is the first field AFTER the final ')'
    # (comm — field 2 — may itself contain spaces and parens).
    st="$(sed -E 's/^.*\) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $1}')"
  else
    # portable fallback where /proc is absent (macOS/BSD)
    st="$(ps -o state= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  fi
  [[ -n "$st" && "${st:0:1}" != "Z" ]]
}

# il_wait_pid <pid> [timeout_s] — wait until <pid> is truly gone, zombie-safe.
#   Returns 0 once the process is gone (reaping it first if it is our child,
#   which clears any zombie immediately), 1 if <timeout_s> (>0) elapses first.
il_wait_pid() {
  local pid="${1:-}" timeout="${2:-0}" waited=0
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  wait "$pid" 2>/dev/null || true          # reap if it is our child (no-op otherwise)
  while il_pid_alive "$pid"; do
    (( timeout > 0 && waited >= timeout )) && return 1
    sleep 1; waited=$((waited + 1))
  done
  return 0
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

# ─── idempotent-retry (genuine-transient tolerance) ──────────────────
# il_retry <attempts> <sleep_s> <desc> <cmd-string>
#   Runs <cmd-string> (eval'd) up to <attempts> times; success = exit 0.
#   Between failures it sleeps <sleep_s>. On success it echoes the command's
#   STDOUT (so callers can capture:  out=$(il_retry 3 2 "read x" "kubectl …")).
#   ALL diagnostics go to stderr so stdout capture stays clean.
#   Use ONLY for IDEMPOTENT reads/probes — a dropped `kubectl exec` (EOF), a
#   momentary API-server blip. NEVER for a mutation that isn't safe to repeat.
#   This is the antidote to "a single dropped exec fails the whole suite":
#   a real operator would just re-run it, and so does this.
il_retry() {
  local attempts="$1" nap="$2" desc="$3" cmd="$4"
  local n=0 out rc
  while :; do
    n=$((n+1))
    out="$(eval "$cmd" 2>/dev/null)"; rc=$?
    if (( rc == 0 )); then
      (( n > 1 )) && printf '  %s•%s %s — ok on attempt %d/%d\n' "$IL_CYAN" "$IL_RESET" "$desc" "$n" "$attempts" >&2
      printf '%s' "$out"; return 0
    fi
    if (( n >= attempts )); then
      printf '  %s✗%s %s — failed after %d attempts (last rc=%d)\n' "$IL_RED" "$IL_RESET" "$desc" "$n" "$rc" >&2
      return "$rc"
    fi
    printf '  %s⋯%s %s — attempt %d/%d rc=%d, retrying in %ss\n' "$IL_YELLOW" "$IL_RESET" "$desc" "$n" "$attempts" "$rc" "$nap" >&2
    sleep "$nap"
  done
}

# ─── webmail-engine baseline (cross-suite / cross-run isolation) ──────
# The two webmail engines are MUTUALLY EXCLUSIVE: activating one scales the
# other's Deployment to 0 (webmail-reconciler). BULWARK is the canonical
# default. A suite that flips the engine and fails to restore it leaks
# "roundcube scaled to 0" into every later scenario AND into the next run on
# the long-lived cluster — the real cause behind "passes standalone, fails in
# the full run". So: suites needing a specific engine MUST establish it
# themselves (not assume), and flip-suites MUST restore to canonical.
IL_WEBMAIL_CANONICAL_ENGINE="${IL_WEBMAIL_CANONICAL_ENGINE:-bulwark}"

# il_webmail_engine_get <api_base> <token> → echoes 'bulwark'|'roundcube' (or empty on error)
il_webmail_engine_get() {
  local body
  body=$(curl -sk -m 15 -H "Authorization: Bearer $2" "$1/api/v1/admin/webmail-settings" 2>/dev/null) || return 1
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r '.data.defaultWebmailEngine // .defaultWebmailEngine // empty' 2>/dev/null
  else
    printf '%s' "$body" | sed -n 's/.*"defaultWebmailEngine"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -1
  fi
}

# il_webmail_engine_set <api_base> <token> <engine> [settle_s]
#   Idempotent: no-op if already at <engine>. PATCHes then sleeps <settle_s>
#   (default 15s) so the reconciler applies the scale + annotations before the
#   caller reads them. Returns non-zero only on a failed PATCH.
il_webmail_engine_set() {
  local base="$1" token="$2" want="$3" settle="${4:-15}" cur
  cur=$(il_webmail_engine_get "$base" "$token")
  [[ "$cur" == "$want" ]] && return 0
  curl -sk -m 30 -X PATCH "$base/api/v1/admin/webmail-settings" \
    -H "Authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"defaultWebmailEngine\":\"$want\"}" -o /dev/null 2>/dev/null || return 1
  sleep "$settle"
  return 0
}

# il_poll_until <desc> <timeout_s> <interval_s> <cmd...>
#
# Run <cmd> repeatedly until it succeeds (exit 0), or <timeout_s> elapses.
# Returns 0 on convergence, 1 on timeout (with a diagnostic on stderr).
#
# This codifies "poll, don't snapshot" — the DEFAULT assertion shape for the
# integration suites. The cluster is eventually-consistent and reconciler-driven
# (Flux, CNPG, the tenant-PSA reconciler, quota admission all reconcile
# continuously), so a read-ONCE assertion flakes purely by timing — the single
# biggest recurring class of test-level non-determinism this codebase has fought
# (pitr task-center chip, barman archiver catch-up, tenant PSS enforce label, a
# pod reaching Running). Any new check that asserts an eventually-true condition
# should wrap it here instead of reading once. Example:
#   il_poll_until "chip succeeded" 120 5 bash -c '[[ "$(read_chip_status)" == succeeded ]]'
il_poll_until() {
  local desc="$1" timeout="$2" interval="$3"; shift 3
  local waited=0
  while (( waited < timeout )); do
    if "$@"; then return 0; fi
    sleep "$interval"; waited=$((waited + interval))
  done
  echo "il_poll_until: '$desc' did not converge within ${timeout}s" >&2
  return 1
}
