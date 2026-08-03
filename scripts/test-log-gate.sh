#!/usr/bin/env bash
# TDD harness for scripts/vm-integration-tests/lib/log-gate.sh.
# Run: ./scripts/test-log-gate.sh   (exit 0 = all pass)
#
# The gate's whole justification is a specific historical failure: bootstrap
# printed seven `command not found` lines on every run for months while every
# gate stayed green. The first test below is that exact log. If it ever stops
# failing the gate, the gate is worthless.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
# shellcheck source=vm-integration-tests/lib/log-gate.sh
source "$REPO_ROOT/scripts/vm-integration-tests/lib/log-gate.sh"

pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

expect_rc() { # expect_rc <desc> <want-rc> <logfile>
  local out; out=$(log_gate_scan "$3" test 2>&1); local rc=$?
  if [[ "$rc" == "$2" ]]; then ok "$3: $1"; else bad "$1 — wanted rc=$2, got rc=$rc: $out"; fi
}

echo "log-gate:"

# 1. The real thing: the v2026.7.27 heredoc bug, verbatim.
cat > "$WORK/regression.log" <<'EOF'
[2026-08-03 14:29:01] Installing Flux v2...
/tmp/insula-bootstrap-RVYmao/scripts/bootstrap.sh: line 4718: op:: command not found
/tmp/insula-bootstrap-RVYmao/scripts/bootstrap.sh: line 4718: ssa:: command not found
/tmp/insula-bootstrap-RVYmao/scripts/bootstrap.sh: line 4718: kustomize: command not found
/tmp/insula-bootstrap-RVYmao/scripts/bootstrap.sh: line 4718: system-db: command not found
[2026-08-03 14:29:14] Flux v2 installed and configured for production.
EOF
expect_rc "the shipped bug FAILS the gate" 1 "$WORK/regression.log"

# 2. A clean run passes.
cat > "$WORK/clean.log" <<'EOF'
PHASE: [1/5] Hardening the host
OK: install base packages
PHASE: [2/5] Installing Kubernetes (k3s)
OK: install k3s v1.36.2
SUMMARY: Bootstrap complete (5/5 phases)
EOF
expect_rc "a clean run passes" 0 "$WORK/clean.log"

# 3. Warnings are counted, never fatal — a gate that fails on every WARN gets
#    switched off, and some warnings are legitimate operator advice.
cat > "$WORK/warns.log" <<'EOF'
PHASE: [1/5] Hardening the host
WARN: host iptables tools absent — k3s will use its bundled copy
WARN: swap detected and disabled
SUMMARY: Bootstrap complete (5/5 phases)
EOF
out=$(log_gate_scan "$WORK/warns.log" test 2>&1); rc=$?
if [[ $rc -eq 0 && "$out" == *"2 warning(s)"* ]]; then ok "warnings counted, not fatal"
else bad "warnings should pass with a count — rc=$rc out=$out"; fi

# 4. Other unambiguous script defects.
for pat in 'bootstrap.sh: line 12: FOO: unbound variable' \
           'bootstrap.sh: line 88: syntax error near unexpected token' \
           'python3: Argument list too long'; do
  printf '%s\n' "$pat" > "$WORK/defect.log"
  expect_rc "catches: ${pat:0:40}" 1 "$WORK/defect.log"
done

# 5. A missing log is NOT a pass. Judging a run we cannot read as clean is how
#    an empty gate looks green forever.
out=$(log_gate_scan "$WORK/does-not-exist.log" test 2>&1); rc=$?
if [[ $rc -eq 2 ]]; then ok "a missing transcript is inconclusive, not clean"
else bad "missing log should return 2, got $rc"; fi

echo
if (( fail == 0 )); then echo "test-log-gate: OK (${pass} checks)"
else echo "test-log-gate: ${fail} FAILED / ${pass} passed" >&2; fi
[[ $fail -eq 0 ]]
