#!/usr/bin/env bash
# test-new-host-migration.sh — unit tests for the host-migration scaffolder.
# Hermetic: scaffolds into a temp --root; asserts the output satisfies the
# per-file contract ci-host-migrations-check.sh enforces (name regex, shebang,
# set -euo pipefail, both header contracts, shellcheck-clean), plus numbering,
# overwrite-refusal, and input validation.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$HERE/.." && pwd)
SCAFFOLD="$HERE/new-host-migration.sh"

pass=0 fail=0
ok()   { echo "  ✓ $1"; pass=$((pass + 1)); }
bad()  { echo "  ✗ $1" >&2; fail=$((fail + 1)); }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/platform/host-migrations"
V="2026.7.1"

echo "[1] --print-path prints the path and writes nothing"
out=$("$SCAFFOLD" relabel-foo --version "$V" --root "$TMP" --print-path)
[ "$out" = "platform/host-migrations/$V/0001-relabel-foo.sh" ] && ok "path = $out" || bad "path = $out"
[ ! -e "$TMP/platform/host-migrations/$V" ] && ok "no dir created on --print-path" || bad "dir created on --print-path"

echo "[2] create writes an executable stub"
"$SCAFFOLD" relabel-foo --version "$V" --root "$TMP" >/dev/null
f="$TMP/platform/host-migrations/$V/0001-relabel-foo.sh"
[ -f "$f" ] && ok "file created" || bad "file not created"
[ -x "$f" ] && ok "file is executable" || bad "file not executable"

echo "[3] stub satisfies the per-file contract"
[ "$(sed -n '1p' "$f")" = '#!/usr/bin/env bash' ] && ok "shebang line 1" || bad "shebang line 1"
grep -q 'set -euo pipefail' "$f" && ok "set -euo pipefail" || bad "set -euo pipefail missing"
grep -qE '^# idempotent:' "$f" && ok "# idempotent: header" || bad "# idempotent: header missing"
grep -qE '^# allow-paths:' "$f" && ok "# allow-paths: header" || bad "# allow-paths: header missing"
basename "$f" | grep -qE '^[0-9]{4}-[a-z0-9][a-z0-9-]*\.sh$' && ok "name matches checker regex" || bad "name regex"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning "$f" >/dev/null 2>&1 && ok "shellcheck -S warning clean" || bad "shellcheck reported issues"
else
  echo "  · shellcheck not installed — skipping"
fi

echo "[4] an un-edited stub FAILS LOUDLY (never silently no-ops)"
( bash "$f" >/dev/null 2>&1 ); rc=$?
[ "$rc" -ne 0 ] && ok "un-edited stub exits non-zero (rc=$rc)" || bad "un-edited stub exited 0 (would look applied)"

echo "[5] auto-numbering: second migration in the version → 0002"
"$SCAFFOLD" another-change --version "$V" --root "$TMP" >/dev/null
[ -f "$TMP/platform/host-migrations/$V/0002-another-change.sh" ] && ok "second is 0002" || bad "numbering did not advance to 0002"

echo "[6] order-stable: numbering never clobbers an existing migration"
# Seed an existing migration, then scaffold — it must pick the NEXT number and
# leave the seeded file byte-for-byte untouched (a shipped migration's path is
# its contract; never rename/renumber/overwrite).
mkdir -p "$TMP/col/scripts" "$TMP/col/platform/host-migrations/$V"
printf 'original-contract\n' > "$TMP/col/platform/host-migrations/$V/0001-shipped.sh"
new=$("$SCAFFOLD" shipped --version "$V" --root "$TMP/col" --print-path)
[ "$new" = "platform/host-migrations/$V/0002-shipped.sh" ] && ok "same name reuse picks next number (0002)" || bad "expected 0002, got $new"
"$SCAFFOLD" shipped --version "$V" --root "$TMP/col" >/dev/null
[ "$(cat "$TMP/col/platform/host-migrations/$V/0001-shipped.sh")" = "original-contract" ] && ok "existing 0001 untouched" || bad "existing 0001 was clobbered"

echo "[7] input validation"
"$SCAFFOLD" "Bad_Name" --version "$V" --root "$TMP" --print-path >/dev/null 2>&1; [ $? -eq 2 ] && ok "bad NAME → exit 2" || bad "bad NAME not rejected"
"$SCAFFOLD" ok-name --version "1.2" --root "$TMP" --print-path >/dev/null 2>&1; [ $? -eq 2 ] && ok "bad version → exit 2" || bad "bad version not rejected"
"$SCAFFOLD" --version "$V" --root "$TMP" --print-path >/dev/null 2>&1; [ $? -eq 2 ] && ok "missing NAME → exit 2" || bad "missing NAME not rejected"

echo "[8] default version resolves via cut-release (real repo root, no write)"
out=$("$SCAFFOLD" some-change --root "$REPO_ROOT" --print-path 2>/dev/null)
echo "$out" | grep -qE '^platform/host-migrations/[0-9]{4}\.[0-9]{1,2}\.[0-9]+/[0-9]{4}-some-change\.sh$' \
  && ok "default-version path = $out" || bad "default-version path = $out"

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
