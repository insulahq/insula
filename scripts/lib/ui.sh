#!/usr/bin/env bash
# scripts/lib/ui.sh — the insula console renderer (bash side).
#
# One visual language for everything the operator watches: bootstrap.sh here, and
# backend/src/cli/platform-ops/ui.ts for the TypeScript subcommands. Symbols,
# colours and the plain-mode prefixes are defined once in
# docs/development/CONSOLE_OUTPUT.md and mirrored in both.
#
# The problem it solves: a bootstrap run printed several thousand lines of
# kubectl/helm/k3s chatter, inside which the things an operator must actually
# read — a warning, a failure, which phase is running — were indistinguishable
# from noise. Seven `command not found` errors rode along in that stream for
# months without anyone reacting (2026-08-03). Volume was the camouflage.
#
# Model:
#   • PHASES are the top-level unit of progress: "3/9 Installing platform".
#   • STEPS live inside a phase. A step's command output is CAPTURED, not
#     streamed; on success only the step line remains, on failure the captured
#     output is replayed in full. Nothing is discarded — see the log file.
#   • OK / WARN / ERROR are the only things that survive a successful run, so
#     anything on screen at the end is something worth reading.
#
# Two modes, chosen automatically:
#   • rich  — stdout is a TTY: colour, in-place step updates, a progress bar.
#   • plain — not a TTY (--remote streaming, CI, the VM harness), NO_COLOR set,
#             TERM=dumb, or --plain: one self-contained line per event with a
#             stable prefix (OK:/WARN:/ERROR:/STEP:/PHASE:). Plain mode is a
#             CONTRACT, not a fallback: the VM harness greps it, so prefixes and
#             wording must stay stable.
#
# The full, unabridged transcript ALWAYS goes to $UI_LOG_FILE regardless of mode.
# The renderer decides what is shown, never what is recorded.

# ── Mode detection ───────────────────────────────────────────────────
UI_MODE="${UI_MODE:-auto}"          # auto | rich | plain
UI_LOG_FILE="${UI_LOG_FILE:-}"      # empty = no file transcript
UI_TOTAL_PHASES="${UI_TOTAL_PHASES:-0}"
UI_PHASE_INDEX=0
UI_PHASE_NAME=""
UI_STEP_OPEN=0                      # a step line is awaiting its verdict
UI_WARN_COUNT=0
UI_ERROR_COUNT=0

# Declared empty at SOURCE time, not only in ui_init: callers run under `set -u`
# and may emit a warning before init (argument parsing, early preflight). An
# unbound $UI_C_DIM there would abort the whole run over a colour code.
UI_C_RESET=""; UI_C_DIM=""; UI_C_BOLD=""
UI_C_GREEN=""; UI_C_YELLOW=""; UI_C_RED=""; UI_C_BLUE=""

ui_is_rich() { [[ "$UI_MODE" == rich ]]; }

ui_init() {
  if [[ "$UI_MODE" == auto ]]; then
    if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-dumb}" != dumb && "${CI:-}" != true ]]; then
      UI_MODE=rich
    else
      UI_MODE=plain
    fi
  fi
  if ui_is_rich; then
    UI_C_RESET=$'\033[0m'; UI_C_DIM=$'\033[2m';   UI_C_BOLD=$'\033[1m'
    UI_C_GREEN=$'\033[32m'; UI_C_YELLOW=$'\033[33m'; UI_C_RED=$'\033[31m'
    UI_C_BLUE=$'\033[34m'
  else
    UI_C_RESET=""; UI_C_DIM=""; UI_C_BOLD=""
    UI_C_GREEN=""; UI_C_YELLOW=""; UI_C_RED=""; UI_C_BLUE=""
  fi
  # Probe writability with `touch`, NOT with `: >>"$f" 2>/dev/null`: a failed
  # REDIRECTION is reported by the shell itself, before the command's own stderr
  # redirect can apply, so that form prints "Permission denied" to the operator's
  # console on every non-root run. touch owns its error message, so 2>/dev/null
  # actually silences it. A transcript we cannot write is a downgrade, not a
  # failure — the run continues without one.
  if [[ -n "$UI_LOG_FILE" ]]; then
    mkdir -p "$(dirname "$UI_LOG_FILE")" 2>/dev/null || true
    touch "$UI_LOG_FILE" 2>/dev/null || UI_LOG_FILE=""
  fi
  return 0
}

# ui_record <line…> — append to the transcript only. Never touches the screen.
ui_record() {
  [[ -n "$UI_LOG_FILE" ]] || return 0
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$UI_LOG_FILE" 2>/dev/null || true
}

# Clear the current line (rich only) so a step line can be rewritten in place.
_ui_clear_line() { ui_is_rich && printf '\r\033[2K'; return 0; }

# ── Phases ───────────────────────────────────────────────────────────
# ui_phase_total <n> — declare how many phases this run has, so progress is a
# fraction rather than a running count with no denominator.
ui_phase_total() { UI_TOTAL_PHASES="$1"; }

_ui_bar() { # _ui_bar <done> <total> → ▕████░░░░▏
  local done="$1" total="$2" width=24 filled
  (( total > 0 )) || { printf ''; return; }
  filled=$(( done * width / total ))
  printf '▕'
  local i
  for (( i = 0; i < width; i++ )); do (( i < filled )) && printf '█' || printf '░'; done
  printf '▏'
}

ui_phase() { # ui_phase <name>
  _ui_close_step_if_open
  UI_PHASE_INDEX=$(( UI_PHASE_INDEX + 1 ))
  UI_PHASE_NAME="$1"
  ui_record "PHASE ${UI_PHASE_INDEX}/${UI_TOTAL_PHASES} ${UI_PHASE_NAME}"
  if ui_is_rich; then
    printf '\n%s%s[%d/%d]%s %s%s%s %s%s%s\n' \
      "$UI_C_BOLD" "$UI_C_BLUE" "$UI_PHASE_INDEX" "$UI_TOTAL_PHASES" "$UI_C_RESET" \
      "$UI_C_BOLD" "$UI_PHASE_NAME" "$UI_C_RESET" \
      "$UI_C_DIM" "$(_ui_bar "$(( UI_PHASE_INDEX - 1 ))" "$UI_TOTAL_PHASES")" "$UI_C_RESET"
  else
    printf 'PHASE: [%d/%d] %s\n' "$UI_PHASE_INDEX" "$UI_TOTAL_PHASES" "$UI_PHASE_NAME"
  fi
}

# ── Steps ────────────────────────────────────────────────────────────
# ui_step <label> — announce work in progress. In rich mode the line is
# rewritten in place by the next ui_ok/ui_warn/ui_fail; in plain mode it stands
# on its own so a streamed log still shows what was attempted when a run hangs.
ui_step() {
  ui_record "STEP ${1}"
  if ui_is_rich; then
    printf '  %s·%s %s' "$UI_C_DIM" "$UI_C_RESET" "$1"
    UI_STEP_OPEN=1
  else
    printf 'STEP: %s\n' "$1"
  fi
}

_ui_close_step_if_open() {
  (( UI_STEP_OPEN == 1 )) || return 0
  ui_is_rich && printf '\n'
  UI_STEP_OPEN=0
  return 0
}

ui_ok() { # ui_ok <label>
  ui_record "OK ${1}"
  if ui_is_rich; then
    _ui_clear_line
    printf '  %s✔%s %s\n' "$UI_C_GREEN" "$UI_C_RESET" "$1"
    UI_STEP_OPEN=0
  else
    printf 'OK: %s\n' "$1"
  fi
}

ui_warn() { # ui_warn <message…>
  UI_WARN_COUNT=$(( UI_WARN_COUNT + 1 ))
  ui_record "WARN ${*}"
  _ui_clear_line
  if ui_is_rich; then
    printf '  %s!%s %s\n' "$UI_C_YELLOW" "$UI_C_RESET" "$*"
    UI_STEP_OPEN=0
  else
    printf 'WARN: %s\n' "$*" >&2
  fi
}

ui_fail() { # ui_fail <message…>
  UI_ERROR_COUNT=$(( UI_ERROR_COUNT + 1 ))
  ui_record "ERROR ${*}"
  _ui_clear_line
  if ui_is_rich; then
    printf '  %s✖%s %s\n' "$UI_C_RED" "$UI_C_RESET" "$*"
    UI_STEP_OPEN=0
  else
    printf 'ERROR: %s\n' "$*" >&2
  fi
}

# ui_detail <message…> — context that belongs on screen but is not itself an
# outcome (an endpoint, a chosen value). Dimmed in rich mode.
ui_detail() {
  ui_record "INFO ${*}"
  _ui_close_step_if_open
  if ui_is_rich; then
    printf '    %s%s%s\n' "$UI_C_DIM" "$*" "$UI_C_RESET"
  else
    printf 'INFO: %s\n' "$*"
  fi
}

# ── Completion report ────────────────────────────────────────────────
# The end-of-run report is the ONE screen an operator actually reads, and it was
# rendered entirely through ui_detail — because bootstrap.sh maps its legacy
# `log()` onto ui_detail, and ui_detail dims. So a successful install signed off
# in exactly the grey the renderer reserves for incidental context, with no
# visual separation between "here is your admin URL" and "here is a kubectl tip".
# Everything looked equally unimportant, which is the same failure as everything
# looking equally important.
#
# These three give the report its own register: a green headline, green section
# headings, undimmed body. Plain mode keeps the existing `INFO:` prefix for all
# three — the streamed contract does not move for a colour change.
#
# On "white" body text: this uses the terminal's DEFAULT foreground rather than
# an explicit white (\033[37m). Forcing white is correct on the dark terminals
# most operators use and unreadable on a light one; default-fg renders white on
# dark, black on light, and is undimmed either way — which is the actual ask.

# ui_banner <title> — the completion headline. Green rule / title / rule.
ui_banner() {
  local title="$1"
  local rule='════════════════════════════════════════════════'
  ui_record "BANNER ${title}"
  _ui_close_step_if_open
  if ui_is_rich; then
    printf '\n%s%s%s%s\n'  "$UI_C_BOLD" "$UI_C_GREEN" "$rule"  "$UI_C_RESET"
    printf '%s%s  %s%s\n'  "$UI_C_BOLD" "$UI_C_GREEN" "$title" "$UI_C_RESET"
    printf '%s%s%s%s\n'    "$UI_C_BOLD" "$UI_C_GREEN" "$rule"  "$UI_C_RESET"
  else
    printf 'INFO: %s\n' "$rule"
    printf 'INFO: %s\n' "$title"
    printf 'INFO: %s\n' "$rule"
  fi
}

# ui_section <name…> — a heading INSIDE the report (Endpoints, Admin sign-in, …).
# Green so the eye can jump between sections instead of reading a grey wall.
ui_section() {
  ui_record "SECTION ${*}"
  _ui_close_step_if_open
  if ui_is_rich; then
    printf '\n  %s%s%s%s\n' "$UI_C_BOLD" "$UI_C_GREEN" "$*" "$UI_C_RESET"
  else
    printf 'INFO: %s\n' "$*"
  fi
}

# ui_line <text…> — report body text. Deliberately NOT dimmed: this is the
# distinction from ui_detail, which stays dim for in-flight context.
ui_line() {
  # An empty argument is a deliberate spacer inside a section. Emit a truly
  # blank line rather than the indent, or the report ships trailing whitespace
  # that shows up as a stray block when an operator selects the text.
  if [[ -z "$*" ]]; then
    _ui_close_step_if_open
    printf '\n'
    return 0
  fi
  ui_record "INFO ${*}"
  _ui_close_step_if_open
  if ui_is_rich; then
    printf '    %s\n' "$*"
  else
    printf 'INFO: %s\n' "$*"
  fi
}

# ── Running commands ─────────────────────────────────────────────────
# ui_run <label> -- <command…>
#
# Runs the command with output captured. On success the operator sees one green
# line. On failure they see the label, the exit code, and the FULL captured
# output — which is the moment they actually need it, and the moment the old
# behaviour buried it under everything that had scrolled past since.
#
# Returns the command's exit status, so callers keep `set -e` semantics.
ui_run() {
  local label="$1"; shift
  [[ "${1:-}" == "--" ]] && shift
  local out rc=0
  ui_step "$label"
  out="$("$@" 2>&1)" || rc=$?
  [[ -n "$out" ]] && ui_record "OUTPUT ${label}"$'\n'"$out"
  if (( rc == 0 )); then
    ui_ok "$label"
  else
    ui_fail "${label} (exit ${rc})"
    if [[ -n "$out" ]]; then
      if ui_is_rich; then
        printf '%s%s%s\n' "$UI_C_DIM" "$(sed 's/^/      /' <<<"$out")" "$UI_C_RESET"
      else
        sed 's/^/    /' <<<"$out" >&2
      fi
    fi
  fi
  return "$rc"
}

# ── Summary ──────────────────────────────────────────────────────────
# ui_summary <headline> — the last thing printed. Reports warning/error counts
# so a run that "succeeded" with 4 warnings cannot look identical to a clean one.
ui_summary() {
  local headline="${1:-Done}"
  _ui_close_step_if_open
  ui_record "SUMMARY ${headline} warnings=${UI_WARN_COUNT} errors=${UI_ERROR_COUNT}"
  local counts=""
  (( UI_WARN_COUNT > 0 ))  && counts+=" ${UI_WARN_COUNT} warning(s)"
  (( UI_ERROR_COUNT > 0 )) && counts+=" ${UI_ERROR_COUNT} error(s)"
  if ui_is_rich; then
    printf '\n%s%s%s%s\n' "$UI_C_BOLD" "$headline" "$UI_C_RESET" "${counts:+ —${counts}}"
    # Draw phases ACTUALLY reached, never a forced 100%. A run that stopped at
    # phase 3 of 9 must not sign off with a full bar — that is precisely the
    # "looks complete, isn't" reading this renderer exists to prevent.
    printf '%s%s %d/%d phases%s\n' "$UI_C_DIM" \
      "$(_ui_bar "$UI_PHASE_INDEX" "$UI_TOTAL_PHASES")" \
      "$UI_PHASE_INDEX" "$UI_TOTAL_PHASES" "$UI_C_RESET"
    [[ -n "$UI_LOG_FILE" ]] && printf '%sfull log: %s%s\n' "$UI_C_DIM" "$UI_LOG_FILE" "$UI_C_RESET"
  else
    printf 'SUMMARY: %s%s (%d/%d phases)\n' "$headline" "${counts:+ —${counts}}" \
      "$UI_PHASE_INDEX" "$UI_TOTAL_PHASES"
    [[ -n "$UI_LOG_FILE" ]] && printf 'INFO: full log: %s\n' "$UI_LOG_FILE"
  fi
  return 0
}
