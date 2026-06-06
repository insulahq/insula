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

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=0 "$CUT" --dry-run --yes --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q 'firewall shape unchanged ✓' && ok "unchanged" || bad "unchanged: $out"

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=2 AUDIT_WAIVERS=0 "$CUT" --dry-run --yes --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q 'CHANGED — covered by 2 host-migration' && ok "covered" || bad "covered: $out"

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=1 "$CUT" --dry-run --yes --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q '1 \[no-host-migration\] waiver(s) acknowledged' && ok "waived" || bad "waived: $out"

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=0 "$CUT" --dry-run --yes --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q '⚠ UNCOVERED' && ok "uncovered verdict shown" || bad "uncovered verdict: $out"
echo "$out" | grep -q 'WOULD BLOCK' && ok "uncovered → dry-run WOULD-BLOCK note" || bad "no would-block note: $out"

out=$(AUDIT_PREV_TAG=v9999.1.1 AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=0 "$CUT" --dry-run --yes --allow-uncovered-host-changes --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q '⚠ UNCOVERED' && ! echo "$out" | grep -q 'WOULD BLOCK' && ok "--allow suppresses the block note" || bad "--allow: $out"

out=$(AUDIT_SHAPE_CHANGED=1 AUDIT_MIGRATIONS=0 AUDIT_WAIVERS=0 "$CUT" --dry-run --yes --skip-host-migration-audit --version 9999.1.2 --root "$REPO_ROOT" 2>&1)
echo "$out" | grep -q 'host-migration audit : skipped' && ok "--skip-host-migration-audit" || bad "skip: $out"

echo "[B] real-path gate (throwaway git repo)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q -b main
git -C "$TMP" config user.email t@t; git -C "$TMP" config user.name t
mkdir -p "$TMP/scripts" "$TMP/platform"
cp "$CUT" "$TMP/scripts/cut-release.sh"
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

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
