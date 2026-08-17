#!/usr/bin/env bash
# TDD harness for bootstrap.sh's quiet kctl/helm_cmd wrappers.
# Run: ./scripts/test-bootstrap-quiet-wrappers.sh   (exit 0 = all pass)
#
# These wrappers suppress command output on the operator's screen. The property
# that MUST hold, and the reason this test exists: over a hundred call sites read
# kubectl's stdout via `$(kctl get … -o jsonpath=…)`. If suppression ever leaks
# into command-substitution position those all receive empty strings, and the
# install fails in a way that reads like a cluster fault rather than a logging
# change. The wrapper distinguishes the two by `[ -t 1 ]`, so proving it needs a
# REAL terminal — hence script(1) rather than a plain subshell.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
contains() { if [[ "$3" == *"$2"* ]]; then ok "$1"; else bad "$1 — [$2] missing from: $3"; fi; }
lacks()    { if [[ "$3" != *"$2"* ]]; then ok "$1"; else bad "$1 — [$2] should be absent from: $3"; fi; }

command -v script >/dev/null 2>&1 || { echo "SKIP: script(1) unavailable — cannot allocate a pty"; exit 0; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/probe.sh" <<EOF
set -uo pipefail
KUBECONFIG=/dev/null
ui_record() { :; }
kubectl() {
  case "\$*" in
    *fail*) echo "the cluster said no" >&2; return 1 ;;
    *)      echo "jsonpath-value"; echo "kubectl chatter" >&2; return 0 ;;
  esac
}
EOF
# Splice in the SHIPPED wrapper so this tests the real thing, not a copy.
sed -n '/^kctl() {/,/^}/p' "$REPO_ROOT/scripts/bootstrap.sh" >> "$WORK/probe.sh"
grep -q 'kubectl --kubeconfig' "$WORK/probe.sh" || { echo "FAIL: could not extract kctl()" >&2; exit 1; }

cat >> "$WORK/probe.sh" <<'EOF'
if [ -t 1 ]; then echo "TTY=yes"; else echo "TTY=no"; fi
v="$(kctl get thing -o jsonpath=x)"
echo "CAPTURED=[$v]"
echo "MARK-success-begin"
kctl get thing -o jsonpath=x
echo "MARK-success-end"
kctl get fail || echo "RC=$?"
EOF

rm -f "$WORK/out"
script -qec "bash $WORK/probe.sh" "$WORK/out" >/dev/null 2>&1
out=$(sed 's/\r$//' "$WORK/out" | grep -v '^Script ')

echo "kctl (on a real terminal):"
contains "the probe really had a pty"          "TTY=yes"                  "$out"
contains "command substitution still gets stdout" "CAPTURED=[jsonpath-value]" "$out"
# Between the two markers, a successful statement-position call must print nothing.
between=$(sed -n '/MARK-success-begin/,/MARK-success-end/p' <<<"$out" | grep -v MARK- || true)
lacks    "success prints no stdout"            "jsonpath-value"           "$between"
lacks    "success prints no stderr"            "kubectl chatter"          "$between"
contains "failure surfaces the error"          "the cluster said no"      "$out"
contains "failure propagates the exit status"  "RC=1"                     "$out"

echo "kctl (no terminal — the --remote / CI path):"
plain=$(bash "$WORK/probe.sh" 2>&1)
contains "no-tty keeps the pass-through"       "TTY=no"                   "$plain"
contains "no-tty still yields captured value"  "CAPTURED=[jsonpath-value]" "$plain"
pbetween=$(sed -n '/MARK-success-begin/,/MARK-success-end/p' <<<"$plain" | grep -v MARK- || true)
contains "no-tty leaves the log exhaustive"    "jsonpath-value"           "$pbetween"

# ─── capture_pod_logs: one-shot pod output MUST reach the transcript ─────────
#
# The mail bootstrap runs its real work in throwaway Pods. Their logs are the
# only record of what happened, and every reader used one of the two kctl forms
# that record NOTHING:
#
#   kctl logs … | sed …     → stdout is a pipe → passthrough → screen only
#   x=$(kctl logs …)        → command substitution → captured, recorded nowhere
#
# So /var/log/insula-bootstrap.log had a hole exactly where the Stalwart
# configure pod's output should have been, which is how an ACME order that never
# succeeded read as a clean install. These assertions are the reason that cannot
# regress: they check the TRANSCRIPT, not the screen.

cat > "$WORK/podprobe.sh" <<EOF
set -uo pipefail
KUBECONFIG=/dev/null
RECORD_FILE="$WORK/recorded"
: > "\$RECORD_FILE"
ui_record() { printf '%s\n' "\$*" >> "\$RECORD_FILE"; }
ui_is_rich() { return 1; }
UI_C_DIM=""; UI_C_RESET=""
kubectl() {
  case "\$*" in
    *emptypod*) return 0 ;;
    *) echo "configure-ok listeners_created=true"; echo "AcmeProvider created (id=abc)" ;;
  esac
}
EOF
sed -n '/^kctl() {/,/^}/p'             "$REPO_ROOT/scripts/bootstrap.sh" >> "$WORK/podprobe.sh"
sed -n '/^capture_pod_logs() {/,/^}/p' "$REPO_ROOT/scripts/bootstrap.sh" >> "$WORK/podprobe.sh"
sed -n '/^print_pod_logs() {/,/^}/p'   "$REPO_ROOT/scripts/bootstrap.sh" >> "$WORK/podprobe.sh"
grep -q 'capture_pod_logs()' "$WORK/podprobe.sh" || { echo "FAIL: could not extract capture_pod_logs()" >&2; exit 1; }

cat >> "$WORK/podprobe.sh" <<'EOF'
logs="$(capture_pod_logs mail configpod 'stalwart configure')"
echo "RETURNED=[$(head -1 <<<"$logs")]"
grep -q '^configure-ok ' <<<"$logs" && echo "MARKER=found"
echo "SCREEN-begin"; print_pod_logs "$logs"; echo "SCREEN-end"
empty="$(capture_pod_logs mail emptypod 'empty one')"
echo "EMPTY=[${empty}]"
EOF

rm -f "$WORK/podout" "$WORK/recorded"
script -qec "bash $WORK/podprobe.sh" "$WORK/podout" >/dev/null 2>&1
podout=$(sed 's/\r$//' "$WORK/podout" | grep -v '^Script ')
recorded=$(cat "$WORK/recorded" 2>/dev/null || true)

echo "capture_pod_logs (on a real terminal — the case that lost the output):"
contains "returns the logs to the caller"       "RETURNED=[configure-ok listeners_created=true]" "$podout"
contains "caller can still grep the marker"     "MARKER=found"                  "$podout"
# THE regression assertion. Everything else here is secondary to this line.
contains "pod output REACHES THE TRANSCRIPT"    "configure-ok listeners_created=true" "$recorded"
contains "transcript keeps every line, not just the first" "AcmeProvider created (id=abc)" "$recorded"
contains "transcript labels which pod it came from" "POD LOGS stalwart configure (mail/configpod)" "$recorded"
# An empty log is a finding in itself — "the container said nothing" is not the
# same as "we never looked", and the transcript must be able to tell them apart.
contains "an empty log is recorded as EMPTY"    "empty one (mail/emptypod) — EMPTY" "$recorded"
contains "an empty log returns empty"           "EMPTY=[]"                      "$podout"
# And it must still be visible on screen, not merely archived.
screen=$(sed -n '/SCREEN-begin/,/SCREEN-end/p' <<<"$podout")
contains "output is ALSO shown on screen"       "configure-ok"                  "$screen"

echo "no call site may go back to the unrecorded forms:"
# `kctl logs` piped or in command substitution is the exact shape that lost the
# output. capture_pod_logs is the only sanctioned reader.
# Skip comment lines (the helper's own docblock names these forms in prose) and
# the one sanctioned reader inside capture_pod_logs itself.
stray=$(grep -n 'kctl logs' "$REPO_ROOT/scripts/bootstrap.sh" \
          | grep -vE '^[0-9]+:[[:space:]]*#' \
          | grep -v 'out="$(kctl logs' || true)
if [[ -z "$stray" ]]; then
  ok "every pod-log read goes through capture_pod_logs"
else
  bad "raw 'kctl logs' call site(s) bypass the transcript:"$'\n'"$stray"
fi

echo
if (( fail == 0 )); then echo "test-bootstrap-quiet-wrappers: OK (${pass} checks)"
else echo "test-bootstrap-quiet-wrappers: ${fail} FAILED / ${pass} passed" >&2; fi
[[ $fail -eq 0 ]]
