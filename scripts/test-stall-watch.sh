#!/usr/bin/env bash
# Regression guard for scripts/stall-watch: the parsers (selftest), and the
# recorder end to end — it must notice its own process being frozen, write the
# event with the right shape, stop by itself at STOP_AT, and summarize the day.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SW="$ROOT/scripts/stall-watch/stall-watch.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

python3 "$SW" selftest || fail "selftest"

export STALL_WATCH_STATE_DIR="$WORK/state" STALL_WATCH_LOG_DIR="$WORK/log" STALL_WATCH_CONF="$WORK/conf"

# No STOP_AT: must refuse to run unbounded.
: > "$STALL_WATCH_CONF"
if python3 "$SW" run >/dev/null 2>&1; then fail "ran without STOP_AT"; fi

# STOP_AT in the past: nothing to do, exit 0.
echo "STOP_AT=2000-01-01T00:00:00Z" > "$STALL_WATCH_CONF"
python3 "$SW" run >/dev/null || fail "past STOP_AT should exit 0"

# A short real run, frozen for 3 s in the middle.
echo "STOP_AT=$(date -u -d '+9 seconds' +%Y-%m-%dT%H:%M:%SZ)" > "$STALL_WATCH_CONF"
python3 "$SW" run > "$WORK/run.out" 2>&1 &
PID=$!
sleep 3
kill -STOP "$PID"; sleep 3; kill -CONT "$PID"
wait "$PID" || fail "recorder exited non-zero: $(cat "$WORK/run.out")"
grep -q "reached STOP_AT" "$WORK/run.out" || fail "recorder did not stop at STOP_AT"

EV="$WORK/log/events.tsv"
[ -f "$EV" ] || fail "no events.tsv after a 3 s freeze"
head -1 "$EV" | grep -q $'^observed_at\tkind\tseconds\tstarted_at$' || fail "events header"
awk -F'\t' 'NR>1 && $2=="frozen" && $3>=2.0 && $3<5.0 {ok=1} END {exit !ok}' "$EV" \
  || fail "freeze not recorded as a 2-5 s frozen event: $(cat "$EV")"

DAILY="$WORK/log/daily.tsv"
[ -f "$DAILY" ] || fail "no daily.tsv written at STOP_AT"
awk -F'\t' -v d="$(date -u +%F)" 'NR>1 && $1==d && $6>=1 {ok=1} END {exit !ok}' "$DAILY" \
  || fail "daily line does not count the freeze: $(cat "$DAILY")"

python3 "$SW" report >/dev/null || fail "report"
echo "test-stall-watch: OK"
