#!/usr/bin/env bash
# test-cut-release-audit.sh — tests the cut-release.sh host-migration audit
# (Tier 3). Drives the verdict matrix via --dry-run with AUDIT_* signal
# overrides (against the real repo), and the real-path block + --allow override
# in a throwaway git repo.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/.." && pwd)
CUT="$HERE/cut-release.sh"

pass=0 fail=0
ok()  { echo "  ✓ $1"; pass=$((pass + 1)); }
bad() { echo "  ✗ $1" >&2; fail=$((fail + 1)); }

# run_dry VARS... -- prints the dry-run plan; uses --version to avoid colliding
# with a real tag, --root the real repo so ci-migration-coverage.sh resolves.
echo "[A] verdict matrix (--dry-run, AUDIT_* overrides)"

# Section A dry-runs hit cut-release's breaking-gate against the REAL CHANGELOG.
# Pass --breaking iff [Unreleased] currently carries a '### BREAKING' heading, so
# this test (which exercises the host-migration audit matrix, not the gate) stays
# green whether or not unreleased breaking changes are pending. cut-release errors
# BOTH ways — --breaking without a heading, and a heading without --breaking — so
# the flag must track the CHANGELOG state.
BRK=""
if awk '/^## \[Unreleased\]/{f=1;next} f&&/^## /{exit} f' "$REPO_ROOT/CHANGELOG.md" 2>/dev/null | grep -qiE '^#{3,4} +BREAKING'; then
  BRK="--breaking"
fi

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=0 "$CUT" --dry-run --yes $BRK --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q 'firewall shape unchanged ✓' && ok "unchanged" || bad "unchanged: $out"

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=2 AUDIT_WAIVERS=0 "$CUT" --dry-run --yes $BRK --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q 'CHANGED — covered by 2 host-migration' && ok "covered" || bad "covered: $out"

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=1 "$CUT" --dry-run --yes $BRK --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q '1 \[no-host-migration\] waiver(s) acknowledged' && ok "waived" || bad "waived: $out"

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=0 "$CUT" --dry-run --yes $BRK --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q '⚠ UNCOVERED' && ok "uncovered verdict shown" || bad "uncovered verdict: $out"
echo "$out" | grep -q 'WOULD BLOCK' && ok "uncovered → dry-run WOULD-BLOCK note" || bad "no would-block note: $out"

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=0 "$CUT" --dry-run --yes $BRK --allow-uncovered-host-changes --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q '⚠ UNCOVERED' && ! echo "$out" | grep -q 'WOULD BLOCK' && ok "--allow suppresses the block note" || bad "--allow: $out"

out=$(AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=0 "$CUT" --dry-run --yes $BRK --skip-host-migration-audit --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q 'host-migration audit : skipped' && ok "--skip-host-migration-audit" || bad "skip: $out"

echo "[B] real-path gate (throwaway git repo)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q -b main
git -C "$TMP" config user.email t@t; git -C "$TMP" config user.name t
mkdir -p "$TMP/scripts" "$TMP/platform"
cp "$CUT" "$TMP/scripts/cut-release.sh"
# cut-release.sh sources scripts/lib/require-tools.sh for its dependency
# preflight — mirror that dependency into the temp repo so the copied script
# exercises the real path (it degrades gracefully if absent, but copy it so the
# preflight actually runs here).
mkdir -p "$TMP/scripts/lib"; cp "$HERE/lib/require-tools.sh" "$TMP/scripts/lib/require-tools.sh"
printf '2026.6.3\n' > "$TMP/platform/VERSION"
printf '# Changelog\n\n## [Unreleased]\n\n- something\n' > "$TMP/CHANGELOG.md"
git -C "$TMP" add -A; git -C "$TMP" commit -qm init; git -C "$TMP" tag v2026.6.3

# Uncovered + no override → exit 1, no tag created.
rc=0
AUDIT_PREV_TAG=v2026.6.3 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=0 \
  "$TMP/scripts/cut-release.sh" --yes --year-month 2026.6 --root "$TMP" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 1 ] && ok "uncovered → real cut exits 1" || bad "expected exit 1, got $rc"
git -C "$TMP" rev-parse v2026.6.4 >/dev/null 2>&1 && bad "tag v2026.6.4 created despite block" || ok "no tag created on block"

# Uncovered + --allow → proceeds, commits + tags v2026.6.4.
rc=0
AUDIT_PREV_TAG=v2026.6.3 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=0 \
  "$TMP/scripts/cut-release.sh" --yes --allow-uncovered-host-changes --year-month 2026.6 --root "$TMP" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 0 ] && ok "--allow → cut proceeds (exit 0)" || bad "expected exit 0 with --allow, got $rc"
git -C "$TMP" rev-parse v2026.6.4 >/dev/null 2>&1 && ok "tag v2026.6.4 created with --allow" || bad "tag not created with --allow"

echo "[C] breaking gate is not a SIGPIPE race"
# Regression: the gate used to be `unreleased_body | grep -q '### BREAKING'`.
# grep -q exits at the first match, awk takes SIGPIPE on the rest, and
# `set -o pipefail` turns the pipeline into 141 — so the verdict depended on how
# long [Unreleased] was and where the heading sat in it. A long section with an
# early heading failed ~90% of runs; a short one passed every time, which is why
# it survived. Both directions misfire, and the no-flag direction FAILS OPEN.
# Build exactly that shape and demand a stable verdict over repeated runs.
BRK_TMP=$(mktemp -d); trap 'rm -rf "$TMP" "$BRK_TMP"' EXIT
mkdir -p "$BRK_TMP/scripts/lib" "$BRK_TMP/platform"
cp "$CUT" "$BRK_TMP/scripts/cut-release.sh"
cp "$HERE/lib/require-tools.sh" "$BRK_TMP/scripts/lib/require-tools.sh"
printf '2026.6.3\n' > "$BRK_TMP/platform/VERSION"
# Reproducing the race needs BOTH of these, which is why it hid for so long:
#   1. the [Unreleased] block must exceed awk's 4096-byte stdio buffer, so awk
#      does a mid-stream write that grep can match on and exit;
#   2. a long tail after it, because awk has no `exit` and keeps READING to EOF
#      — that is the window in which grep -q leaves, so awk's flush-at-exit
#      lands on a closed pipe.
# Miss either and the pipeline returns 0 every time: a big block with a short
# tail flushes before grep is gone, and a small block with a long tail is
# buffered into one write that happens while grep is still reading. Both
# shapes pass against the buggy code, so both are useless as regression tests.
# Measured: this shape → 17/20 runs returned 141; either half alone → 0/20.
{
  printf '# Changelog\n\n## [Unreleased]\n\n### BREAKING\n- early heading\n\n### Fixed\n'
  for i in $(seq 1 120); do
    printf -- '- filler entry %s with enough text to push past the 4096-byte buffer\n' "$i"
  done
  printf '\n## [2026.6.3] - 2026-06-01\n\n'
  for i in $(seq 1 6000); do printf -- '- historical entry %s\n' "$i"; done
} > "$BRK_TMP/CHANGELOG.md"
git -C "$BRK_TMP" init -q -b main
git -C "$BRK_TMP" config user.email t@t; git -C "$BRK_TMP" config user.name t
git -C "$BRK_TMP" add -A; git -C "$BRK_TMP" commit -qm init; git -C "$BRK_TMP" tag v2026.6.3

# --breaking + heading present → must succeed EVERY time.
races=0
for _ in $(seq 1 15); do
  rc=0
  AUDIT_PREV_TAG=v2026.6.3 AUDIT_SHAPE_CHANGED=0 "$BRK_TMP/scripts/cut-release.sh" \
    --dry-run --yes --breaking --version 9999.1.2 --root "$BRK_TMP" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 0 ] || races=$((races + 1))
done
[ "$races" -eq 0 ] && ok "--breaking accepted on all 15 runs" \
  || bad "--breaking wrongly rejected on $races/15 runs (SIGPIPE race)"

# No --breaking + heading present → must BLOCK every time (the fail-open case).
opens=0
for _ in $(seq 1 15); do
  rc=0
  AUDIT_PREV_TAG=v2026.6.3 AUDIT_SHAPE_CHANGED=0 "$BRK_TMP/scripts/cut-release.sh" \
    --dry-run --yes --version 9999.1.2 --root "$BRK_TMP" >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 1 ] || opens=$((opens + 1))
done
[ "$opens" -eq 0 ] && ok "unacknowledged BREAKING blocked on all 15 runs" \
  || bad "gate failed OPEN on $opens/15 runs — a breaking release would cut unacknowledged"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
