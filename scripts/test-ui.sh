#!/usr/bin/env bash
# TDD harness for scripts/lib/ui.sh — the console renderer.
# Run: ./scripts/test-ui.sh   (exit 0 = all pass)
#
# Plain mode is a CONTRACT, not cosmetics: the VM harness's log gate greps these
# prefixes, and --remote streams them to the operator. The prefix and wording
# assertions below are what stop a later "tidy-up" from silently breaking that.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check()    { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }
contains() { if [[ "$3" == *"$2"* ]]; then ok "$1"; else bad "$1 — [$2] not found in: $3"; fi; }
lacks()    { if [[ "$3" != *"$2"* ]]; then ok "$1"; else bad "$1 — [$2] should NOT appear in: $3"; fi; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

echo "ui.sh (plain mode — the grep contract):"

out=$(
  UI_MODE=plain UI_LOG_FILE="$WORK/t.log" bash -c '
    source '"$REPO_ROOT"'/scripts/lib/ui.sh
    ui_init; ui_phase_total 3
    ui_phase "Preparing host"
    ui_step "install packages"
    ui_ok   "install packages"
    ui_warn "swap is enabled"
    ui_detail "endpoint https://admin.example.test"
    ui_phase "Installing k3s"
    ui_fail "k3s did not start"
    ui_summary "Bootstrap finished"
  ' 2>&1
)
contains "phase carries index/total"  "PHASE: [1/3] Preparing host"  "$out"
contains "ok has OK: prefix"          "OK: install packages"          "$out"
contains "warn has WARN: prefix"      "WARN: swap is enabled"         "$out"
contains "error has ERROR: prefix"    "ERROR: k3s did not start"      "$out"
contains "detail has INFO: prefix"    "INFO: endpoint"                "$out"
contains "summary counts warnings"    "1 warning(s)"                  "$out"
contains "summary counts errors"      "1 error(s)"                    "$out"
lacks    "no ANSI escapes in plain"   $'\033['                        "$out"

echo "ui.sh (streams):"
errout=$(
  UI_MODE=plain bash -c '
    source '"$REPO_ROOT"'/scripts/lib/ui.sh
    ui_init; ui_warn "w"; ui_fail "e"; ui_ok "good"
  ' 2>/dev/null
)
contains "ok goes to stdout"          "OK: good"  "$errout"
lacks    "warn does NOT go to stdout" "WARN:"     "$errout"
lacks    "error does NOT go to stdout" "ERROR:"   "$errout"

echo "ui.sh (ui_run — capture on success, replay on failure):"
runout=$(
  UI_MODE=plain UI_LOG_FILE="$WORK/r.log" bash -c '
    source '"$REPO_ROOT"'/scripts/lib/ui.sh
    ui_init
    ui_run "quiet success" -- bash -c "echo noisy-stdout; echo noisy-stderr >&2; exit 0"
    echo "rc_success=$?"
    ui_run "loud failure" -- bash -c "echo diagnostic-detail; exit 3"
    echo "rc_failure=$?"
  ' 2>&1
)
lacks    "success hides command stdout" "noisy-stdout"        "$runout"
lacks    "success hides command stderr" "noisy-stderr"        "$runout"
contains "success shows one OK line"    "OK: quiet success"   "$runout"
check    "success returns 0"            "rc_success=0"        "$(grep -o 'rc_success=[0-9]*' <<<"$runout")"
contains "failure surfaces exit code"   "ERROR: loud failure (exit 3)" "$runout"
contains "failure replays output"       "diagnostic-detail"   "$runout"
check    "failure propagates status"    "rc_failure=3"        "$(grep -o 'rc_failure=[0-9]*' <<<"$runout")"

echo "ui.sh (transcript keeps EVERYTHING the screen dropped):"
contains "log kept suppressed stdout"   "noisy-stdout"        "$(cat "$WORK/r.log")"
contains "log kept suppressed stderr"   "noisy-stderr"        "$(cat "$WORK/r.log")"
contains "log records outcomes"         "OK quiet success"    "$(cat "$WORK/r.log")"

echo "ui.sh (an incomplete run must not sign off as complete):"
stopped=$(
  UI_MODE=plain bash -c '
    source '"$REPO_ROOT"'/scripts/lib/ui.sh
    ui_init; ui_phase_total 9
    ui_phase "one"; ui_phase "two"; ui_phase "three"
    ui_fail "stopped here"
    ui_summary "Bootstrap stopped"' 2>&1
)
contains "summary reports phases REACHED" "(3/9 phases)" "$stopped"
lacks    "never claims all phases"        "(9/9 phases)" "$stopped"
finished=$(
  UI_MODE=plain bash -c '
    source '"$REPO_ROOT"'/scripts/lib/ui.sh
    ui_init; ui_phase_total 2; ui_phase "a"; ui_phase "b"
    ui_summary "Bootstrap complete"' 2>&1
)
contains "a real completion shows full"   "(2/2 phases)" "$finished"

echo "ui.sh (mode detection):"
m=$(UI_MODE=auto bash -c 'source '"$REPO_ROOT"'/scripts/lib/ui.sh; ui_init; echo "$UI_MODE"' </dev/null)
check "non-TTY auto-detects plain" "plain" "$m"
m=$(UI_MODE=auto NO_COLOR=1 bash -c 'source '"$REPO_ROOT"'/scripts/lib/ui.sh; ui_init; echo "$UI_MODE"')
check "NO_COLOR forces plain"      "plain" "$m"
m=$(UI_MODE=auto TERM=dumb bash -c 'source '"$REPO_ROOT"'/scripts/lib/ui.sh; ui_init; echo "$UI_MODE"')
check "TERM=dumb forces plain"     "plain" "$m"

echo "ui.sh (rich mode renders, and is never used for machine output):"
rich=$(UI_MODE=rich bash -c '
    source '"$REPO_ROOT"'/scripts/lib/ui.sh
    ui_init; ui_phase_total 2; ui_phase "P"; ui_ok "done"; ui_summary "Finished"' 2>&1)
contains "rich uses a check glyph"  "✔"       "$rich"
contains "rich draws a bar"         "▕"       "$rich"
contains "rich emits colour"        $'\033['  "$rich"

echo
if (( fail == 0 )); then echo "test-ui: OK (${pass} checks)"; else echo "test-ui: ${fail} FAILED / ${pass} passed" >&2; fi
[[ $fail -eq 0 ]]
