#!/usr/bin/env bash
# test-ci-integration-coverage.sh — self-test for ci-integration-coverage.sh so the
# coverage guard itself can't silently break.
set -uo pipefail
cd "$(dirname "$0")/.."
G=scripts/ci-integration-coverage.sh
pass=0; fail=0
check() { if [[ "$1" == "$2" ]]; then echo "  ok: $3"; pass=$((pass+1)); else echo "  FAIL: $3 (got rc=$1 want $2)"; fail=$((fail+1)); fi; }

# 1. the real registry passes
bash "$G" >/dev/null 2>&1; check "$?" 0 "clean registry passes"

# 2. an unregistered integration-*.sh makes it fail (the core guarantee)
TMP=scripts/integration-zzz-selftest.sh
trap 'rm -f "$TMP"' EXIT
printf '#!/usr/bin/env bash\n:\n' > "$TMP"
bash "$G" >/dev/null 2>&1; check "$?" 1 "unregistered script fails the guard"
rm -f "$TMP"; trap - EXIT

# 3. passes again once removed
bash "$G" >/dev/null 2>&1; check "$?" 0 "passes again after the orphan is removed"

echo "test-ci-integration-coverage: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
