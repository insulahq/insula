#!/usr/bin/env bash
# TDD harness for scripts/ci-migration-coverage.sh (Tier 1 forcing function).
# Run: ./scripts/test-ci-migration-coverage.sh   (exit 0 = all pass)
set -uo pipefail
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
GUARD="$REPO_ROOT/scripts/ci-migration-coverage.sh"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

# A fake bootstrap.sh with a known firewall shape ($1 = extra rule line, '' for base).
fake_bootstrap() {
  local extra="${1:-}"
  cat <<EOF
#!/usr/bin/env bash
set_decls="
  set blacklist_v4 {
    type ipv4_addr
    flags interval
  }
"
cat > /etc/nftables.conf <<NFT
table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;
    ip  saddr @blacklist_v4 drop
    tcp dport 80 accept
    tcp dport 443 accept
    ${extra}
  }
}
NFT
EOF
}

# Run the guard with a fixture bootstrap + baseline + injected signals.
# Args: <bootstrap-file> <baseline-file> <MIGRATION_ADDED> <WAIVER> <BASELINE_UPDATED>
run() {
  FWSHAPE_BOOTSTRAP="$1" FWSHAPE_BASELINE="$2" \
  MIGRATION_ADDED="$3" WAIVER="$4" BASELINE_UPDATED="$5" \
  bash "$GUARD" >/dev/null 2>&1
}
expect() { # <desc> <expected-rc> <actual-rc>
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want rc=$2 got rc=$3)"; fi
}

D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
fake_bootstrap "" > "$D/bootstrap.sh"
# baseline = current shape of the unchanged bootstrap
FWSHAPE_BOOTSTRAP="$D/bootstrap.sh" FWSHAPE_BASELINE="$D/baseline" bash "$GUARD" --update-baseline >/dev/null

echo "== shape unchanged → always OK (signals irrelevant) =="
run "$D/bootstrap.sh" "$D/baseline" 0 0 0; expect "unchanged passes" 0 $?

echo "== shape CHANGED → coverage required =="
fake_bootstrap "tcp dport 9999 accept" > "$D/changed.sh"
run "$D/changed.sh" "$D/baseline" 0 0 0; expect "changed + nothing → FAIL" 1 $?
run "$D/changed.sh" "$D/baseline" 1 0 0; expect "changed + migration but baseline NOT refreshed → FAIL" 1 $?
run "$D/changed.sh" "$D/baseline" 0 0 1; expect "changed + baseline refreshed but NO migration → FAIL" 1 $?
run "$D/changed.sh" "$D/baseline" 1 0 1; expect "changed + migration + baseline refreshed → OK" 0 $?
run "$D/changed.sh" "$D/baseline" 0 1 1; expect "changed + waiver + baseline refreshed → OK" 0 $?
run "$D/changed.sh" "$D/baseline" 0 1 0; expect "changed + waiver but baseline NOT refreshed → FAIL" 1 $?

echo "== waiver must START a commit-message line — prose mention does NOT waive (git-derived) =="
# Exercises the real git-log waiver grep (not the WAIVER env override): a
# mid-sentence prose/markdown mention of the token must not count, only a line
# that begins with it. Regression for the v2026.6.4 false "1 waiver" match.
G=$(mktemp -d)
git -C "$G" init -q
git -C "$G" -c user.email=t@t -c user.name=t commit -q --allow-empty -m "base"
WBASE=$(git -C "$G" rev-parse HEAD)
git -C "$G" -c user.email=t@t -c user.name=t commit -q --allow-empty \
  -m "fix: document the [no-host-migration] token inline (prose, mid-line)"
BASE_REF="$WBASE" REPO_ROOT="$G" FWSHAPE_BOOTSTRAP="$D/changed.sh" FWSHAPE_BASELINE="$D/baseline" \
  MIGRATION_ADDED=0 BASELINE_UPDATED=1 bash "$GUARD" >/dev/null 2>&1
expect "prose mention of token does NOT waive → FAIL" 1 $?
git -C "$G" -c user.email=t@t -c user.name=t commit -q --allow-empty \
  -m "$(printf 'fix: open port 9999\n\n[no-host-migration] only fresh installs need this rule')"
BASE_REF="$WBASE" REPO_ROOT="$G" FWSHAPE_BOOTSTRAP="$D/changed.sh" FWSHAPE_BASELINE="$D/baseline" \
  MIGRATION_ADDED=0 BASELINE_UPDATED=1 bash "$GUARD" >/dev/null 2>&1
expect "line-anchored waiver → OK" 0 $?
rm -rf "$G"

echo "== removing a drop RULE is detected (HIGH: pattern must match @set_v4) =="
fake_bootstrap "" | sed '/ip  saddr @blacklist_v4 drop/d' > "$D/nodrop.sh"
run "$D/nodrop.sh" "$D/baseline" 0 0 0; expect "drop rule removed + no coverage → FAIL" 1 $?

echo "== whitespace / comment edits do NOT count as a shape change =="
fake_bootstrap "" | sed 's/    tcp dport 80 accept/        tcp dport 80 accept    # reindented + comment/' > "$D/cosmetic.sh"
run "$D/cosmetic.sh" "$D/baseline" 0 0 0; expect "reindent+comment → still OK" 0 $?

echo "== real repo passes its own committed baseline =="
bash "$GUARD" >/dev/null 2>&1; expect "live repo OK" 0 $?

echo
echo "RESULT: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
