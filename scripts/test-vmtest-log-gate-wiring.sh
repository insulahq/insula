#!/usr/bin/env bash
# TDD harness for spawn-cluster.sh's bootstrap_node → log-gate wiring.
# Run: ./scripts/test-vmtest-log-gate-wiring.sh   (exit 0 = all pass)
#
# The invariant: the transcript is scanned on EVERY bootstrap, and above all on
# a FAILING one — that is when its output is worth most.
#
# This exists because the first version got it backwards. `bootstrap_node` called
# bootstrap.sh bare under `set -euo pipefail`, so a non-zero exit unwound the
# function immediately and the gate never ran. A real failing run (7ce830fe,
# Stalwart could not schedule on an undersized node) is what surfaced it: the
# diagnostics fired, the gate did not. Reading the code had not.
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SPAWN="$REPO_ROOT/scripts/vm-integration-tests/spawn-cluster.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# Drive the SHIPPED bootstrap_node against stubs. $1 = the rc bootstrap.sh returns.
run_case() {
  local boot_rc="$1" gate_rc="$2"
  cat > "$WORK/case.sh" <<EOF
set -euo pipefail
REPO="$WORK"; APEX=example.test; VMTEST_SSH_KEY=/dev/null; VMTEST_ENV=dev
declare -A NODE_OS=( [n1]=debian-13 )
wait_ssh() { :; }; wait_cloudinit() { :; }; assert_guest_os_version() { :; }
log_gate_fetch_and_scan() { echo "GATE-RAN"; return ${gate_rc}; }
EOF
  sed -n '/^bootstrap_node() {/,/^}/p' "$SPAWN" >> "$WORK/case.sh"
  echo 'bootstrap_node n1 10.0.0.1 server; echo "REACHED-END rc=$?"' >> "$WORK/case.sh"
  mkdir -p "$WORK/scripts"
  printf '#!/usr/bin/env bash\nexit %s\n' "$boot_rc" > "$WORK/scripts/bootstrap.sh"
  chmod +x "$WORK/scripts/bootstrap.sh"
  bash "$WORK/case.sh" 2>&1
}

echo "bootstrap_node → log-gate wiring:"

out=$(run_case 0 0)
[[ "$out" == *GATE-RAN* ]]     && ok "gate runs on a SUCCESSFUL bootstrap"      || bad "gate did not run on success: $out"
[[ "$out" == *REACHED-END* ]]  && ok "success continues the run"                || bad "success should continue: $out"

# The regression that shipped: bootstrap fails, gate skipped.
out=$(run_case 1 0)
[[ "$out" == *GATE-RAN* ]]     && ok "gate runs on a FAILING bootstrap"         || bad "REGRESSION — gate skipped when bootstrap failed: $out"
[[ "$out" != *REACHED-END* ]]  && ok "a failing bootstrap still aborts the run" || bad "a failed bootstrap must abort: $out"

# A clean bootstrap whose transcript shows a script defect must abort.
out=$(run_case 0 1)
[[ "$out" == *GATE-RAN* ]]     && ok "gate runs when bootstrap exits 0"         || bad "gate did not run: $out"
[[ "$out" != *REACHED-END* ]]  && ok "a defect in the transcript aborts the run" || bad "gate rc=1 must abort: $out"

# An unfetchable transcript is inconclusive: warn, do not fail a good bootstrap.
out=$(run_case 0 2)
[[ "$out" == *REACHED-END* ]]  && ok "an unfetchable transcript does not fail a good run" || bad "gate rc=2 should warn only: $out"
[[ "$out" == *WARNING* ]]      && ok "…but it does warn"                        || bad "gate rc=2 should warn: $out"

echo
if (( fail == 0 )); then echo "test-vmtest-log-gate-wiring: OK (${pass} checks)"
else echo "test-vmtest-log-gate-wiring: ${fail} FAILED / ${pass} passed" >&2; fi
[[ $fail -eq 0 ]]
