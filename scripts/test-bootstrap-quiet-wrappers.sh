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

echo
if (( fail == 0 )); then echo "test-bootstrap-quiet-wrappers: OK (${pass} checks)"
else echo "test-bootstrap-quiet-wrappers: ${fail} FAILED / ${pass} passed" >&2; fi
[[ $fail -eq 0 ]]
