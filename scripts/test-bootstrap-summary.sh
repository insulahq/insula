#!/usr/bin/env bash
# TDD harness for bootstrap.sh's completion report + the advisory-smoke verdict.
#
# What this pins down (all of it regressed at least once on a real install):
#   1. The report is NOT dimmed. `log()` in bootstrap.sh maps to ui_detail, which
#      dims — so a report built out of log() renders a successful install in the
#      same grey used for incidental chatter. The banner and section headings
#      must carry green, and body text must carry no dim escape.
#   2. The report is the LAST thing printed. Post-install smoke is advisory and
#      must not be the operator's final impression of a successful install.
#   3. A FAILED advisory smoke produces NO warnings — it is reported once, inside
#      the report, as a factual line. Warnings are for things that need action.
#   4. The verdict shows just the counts, never the smoke script's internal event
#      name, and falls back to the exit code if the format ever changes.
#
# Run: ./scripts/test-bootstrap-summary.sh   (exit 0 = all pass)
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check()    { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi; }
contains() { if [[ "$3" == *"$2"* ]]; then ok "$1"; else bad "$1 — [$2] not found"; fi; }
lacks()    { if [[ "$3" != *"$2"* ]]; then ok "$1"; else bad "$1 — [$2] should NOT appear"; fi; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

# Render print_summary through the REAL bootstrap.sh + ui.sh in rich mode.
# $1 = SMOKE_VERDICT, $2 = SMOKE_ADVICE
render_summary() {
  UI_MODE=rich UI_LOG_FILE="$WORK/ui.log" SUMMARY_VERDICT="$1" SUMMARY_ADVICE="$2" \
  bash -c '
    source '"$REPO_ROOT"'/scripts/bootstrap.sh >/dev/null 2>&1
    UI_MODE=rich; ui_init
    PLATFORM_DOMAIN=example.test; PLATFORM_ENV=production
    KUBECONFIG=/etc/rancher/k3s/k3s.yaml; K3S_VERSION=v1.36.2+k3s1; SKIP_FLUX=false
    SMOKE_VERDICT="$SUMMARY_VERDICT"; SMOKE_ADVICE="$SUMMARY_ADVICE"
    print_summary
  ' 2>&1
}

echo "bootstrap completion report (colour registers):"
out=$(render_summary "" "")
grn=$'\033[32m'; dim=$'\033[2m'
contains "banner is green"                 "${grn}════"                 "$out"
contains "banner title is green"           "${grn}  BOOTSTRAP COMPLETE" "$out"
contains "section headings are green"      "${grn}Endpoints"            "$out"
contains "section headings are green (2)"  "${grn}Installed"            "$out"
lacks    "report body is NOT dimmed"       "${dim}    Admin:"           "$out"
# The whole point: no line of the report may be emitted through the dim renderer.
if grep -q $'\033\[2m' <<<"$out"; then
  bad "report contains a dim escape — it is being rendered through ui_detail again"
else
  ok "report contains no dim escapes at all"
fi
contains "endpoints still present"  "https://admin.example.test"  "$out"
contains "kubectl hint still present" "kubectl get nodes"         "$out"

echo "bootstrap completion report (advisory smoke verdict):"
out=$(render_summary "" "")
lacks "no smoke section when smoke did not run" "Post-install checks" "$out"
out=$(render_summary "All cluster-network checks passed (PASS=27 FAIL=0)." "")
contains "PASS verdict is reported"     "All cluster-network checks passed" "$out"
lacks    "PASS verdict carries no advice" "make diagnose"                   "$out"
out=$(render_summary "PASS=23 FAIL=4 — see /var/log/x.log" "Forensic snapshot:              make diagnose")
contains "FAIL verdict shows counts"    "PASS=23 FAIL=4"          "$out"
contains "FAIL verdict is framed as advisory" "advisory"          "$out"
contains "FAIL verdict says it does not block" "do not block the install" "$out"
contains "FAIL verdict offers a re-run" "make smoke"              "$out"
lacks    "verdict never leaks the smoke event name" "run.summary" "$out"

echo "advisory smoke verdict extraction (real emit() format):"
# The real line, from smoke-test-cluster-network.sh: printf '[%s] %s — %s\n'
extract() { grep -o 'PASS=[0-9]\+ FAIL=[0-9]\+' <<<"$1" | tail -1 || true; }
check "extracts counts from the real line" "PASS=23 FAIL=4" \
  "$(extract '[INFO] run.summary — PASS=23 FAIL=4')"
check "survives a separator change"        "PASS=1 FAIL=0" \
  "$(extract '[INFO] run.summary: PASS=1 FAIL=0')"
check "unknown format yields empty (rc fallback engages)" "" \
  "$(extract '[INFO] run.summary — everything is fine')"
check "empty summary yields empty"         "" "$(extract '')"

echo "advisory smoke emits NO warnings (rich + plain):"
# A failing advisory smoke must not increment the warning tally — that tally is
# what ui_summary prints, and "Bootstrap complete — 4 warning(s)" on an install
# that succeeded is exactly the false alarm this whole change removes.
# Drive the REAL run_post_install_smoke against a stub smoke script that emits
# the genuine emit() format. bootstrap.sh resolves the smoke script relative to
# its own BASH_SOURCE, so the copy has to live in an isolated scripts/ dir —
# sourcing it in place would find the repo's real smoke script and run it against
# whatever cluster happens to be reachable.
ISO="$WORK/iso/scripts"; mkdir -p "$ISO/lib"
cp "$REPO_ROOT/scripts/bootstrap.sh" "$ISO/"
cp "$REPO_ROOT"/scripts/lib/*.sh "$ISO/lib/"
cat > "$ISO/smoke-test-cluster-network.sh" <<'STUB'
#!/usr/bin/env bash
printf '[PASS] netpol.egress — ok\n'
printf '[FAIL] dex.ready — CrashLoopBackOff\n'
printf '[INFO] run.summary — PASS=23 FAIL=4\n'
exit 1
STUB
chmod +x "$ISO/smoke-test-cluster-network.sh"

smoke=$(
  UI_MODE=plain UI_LOG_FILE="$WORK/s.log" SMOKE_LOG_FILE="$WORK/smoke.log" bash -c '
    source '"$ISO"'/bootstrap.sh >/dev/null 2>&1
    UI_MODE=plain; ui_init
    SKIP_SMOKE=false; REQUIRE_SMOKE_PASS=false; SMOKE_WAIT_SECONDS=1
    kubectl() { return 1; }          # no cluster: exercise the not-Ready branch
    run_post_install_smoke
    echo "VERDICT=[${SMOKE_VERDICT}] WARNINGS=${UI_WARN_COUNT}"
  ' 2>&1
)
contains "advisory FAIL records the counts as the verdict" "VERDICT=[PASS=23 FAIL=4" "$smoke"
contains "advisory FAIL raises ZERO warnings"              "WARNINGS=0"              "$smoke"
lacks    "advisory FAIL never emits a WARN line"           "WARN:"                   "$smoke"
lacks    "no 'exits 0 because' apologia"                   "exits 0 because"         "$smoke"
contains "advisory FAIL says it does not block"            "does not block"          "$smoke"

# --require-smoke-pass is an opt-in GATE: it must still be fatal, and must still
# be an ERROR. Softening the advisory path must not soften the gate.
gated=$(
  UI_MODE=plain UI_LOG_FILE="$WORK/g.log" SMOKE_LOG_FILE="$WORK/gsmoke.log" bash -c '
    source '"$ISO"'/bootstrap.sh >/dev/null 2>&1
    UI_MODE=plain; ui_init
    SKIP_SMOKE=false; REQUIRE_SMOKE_PASS=true; SMOKE_WAIT_SECONDS=1
    kubectl() { return 1; }
    run_post_install_smoke
    echo "SHOULD-NOT-REACH"
  ' 2>&1
)
contains "--require-smoke-pass still ERRORs" "ERROR: Smoke FAILED" "$gated"
lacks    "--require-smoke-pass still exits"  "SHOULD-NOT-REACH"    "$gated"

skipped=$(
  UI_MODE=plain bash -c '
    source '"$REPO_ROOT"'/scripts/bootstrap.sh >/dev/null 2>&1
    UI_MODE=plain; ui_init; SKIP_SMOKE=true
    run_post_install_smoke
    echo "VERDICT=[${SMOKE_VERDICT}] WARNINGS=${UI_WARN_COUNT}"
  ' 2>&1
)
contains "--skip-smoke leaves no verdict"  "VERDICT=[]"   "$skipped"
contains "--skip-smoke raises no warning"  "WARNINGS=0"   "$skipped"

echo "ordering: the report is the last thing main() prints:"
# Structural, not runtime — main() cannot be executed here. Assert the call order
# inside the server branch: smoke BEFORE print_summary.
BS="$REPO_ROOT/scripts/bootstrap.sh"
smoke_line=$(grep -n '^      run_post_install_smoke$' "$BS" | head -1 | cut -d: -f1)
summ_line=$(grep -n '^    print_summary$' "$BS" | head -1 | cut -d: -f1)
if [[ -n "$smoke_line" && -n "$summ_line" ]] && (( smoke_line < summ_line )); then
  ok "run_post_install_smoke runs BEFORE print_summary (line $smoke_line < $summ_line)"
else
  bad "print_summary must come AFTER run_post_install_smoke (smoke=$smoke_line summary=$summ_line)"
fi

echo
if (( fail == 0 )); then
  echo "test-bootstrap-summary: OK (${pass} checks)"
else
  echo "test-bootstrap-summary: ${fail} FAILED / ${pass} passed" >&2
fi
[[ $fail -eq 0 ]]
