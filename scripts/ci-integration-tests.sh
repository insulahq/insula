#!/usr/bin/env bash
# ci-integration-tests.sh — run the backend vitest integration suites against a
# real Postgres and fail on any SILENT SKIP.
#
# Background. These suites existed for a long time without ever running in CI.
# `ci-backend.yml` provisions a postgres service, but the only command using it
# was `test:coverage`, whose config EXCLUDES `**/*.integration.test.ts` — so the
# database was started and never connected to. In that gap `GET /admin/mail/stats`
# shipped a query comparing an enum column to a label the enum has never had, and
# answered 400 for its entire life.
#
# Why the skip check matters as much as the run. Every suite guards on
# `isDbAvailable()` and falls back to `describe.skip`, and vitest EXITS 0 when
# every test is skipped. A broken DATABASE_URL would therefore report a green
# check that executed nothing — the same false confidence that hid the bug. So
# this script demands zero skipped tests rather than trusting the exit code.
#
# Two suites are excluded because they need systems this job does not have:
#   - powerdns.live — needs a live PowerDNS. Already covered by the
#     `dns-powerdns-live` job, which starts the container and runs this exact
#     file via scripts/integration-dns-powerdns.sh.
#   - tenant-lifecycle — opt-in behind RUN_LIFECYCLE_INTEGRATION=1 and needs a
#     real cluster (KUBECONFIG).
# They are named here so the exclusion is a visible decision, not a silent gap.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}/backend"

VITEST="${REPO_ROOT}/node_modules/.bin/vitest"
[ -x "${VITEST}" ] || VITEST="${REPO_ROOT}/backend/node_modules/.bin/vitest"
[ -x "${VITEST}" ] || { echo "vitest not found — run npm ci first" >&2; exit 1; }

REPORT="$(mktemp -t integration-report.XXXXXX.json)"
trap 'rm -f "${REPORT}"' EXIT

echo "── backend integration suites ────────────────────────────────────"
echo "DATABASE_URL host: $(printf '%s' "${DATABASE_URL:-unset}" | sed -E 's|^[^@]*@||; s|/.*$||')"

set +e
"${VITEST}" run \
  --config vitest.config.integration.ts \
  --exclude '**/powerdns.live.integration.test.ts' \
  --exclude '**/tenant-lifecycle/lifecycle.integration.test.ts' \
  --reporter=default --reporter=json --outputFile="${REPORT}"
VITEST_RC=$?
set -e

python3 - "${REPORT}" "${VITEST_RC}" <<'PY'
import json, sys

report_path, vitest_rc = sys.argv[1], int(sys.argv[2])
try:
    with open(report_path) as fh:
        data = json.load(fh)
except Exception as exc:                      # noqa: BLE001
    print(f"FAIL: could not read the vitest JSON report ({exc}).")
    print("      A missing report means the run died before writing results —")
    print("      treat it as a failure, never as 'nothing to report'.")
    sys.exit(1)

files = data.get("testResults", [])
if not files:
    print("FAIL: the report lists no test files. Expected the integration suites.")
    sys.exit(1)

passed = failed = skipped = 0
bad = []
for f in files:
    name = f["name"].split("/backend/src/")[-1]
    p = s = x = 0
    for a in f.get("assertionResults", []):
        st = a["status"]
        if st == "passed":
            p += 1
        elif st == "failed":
            x += 1
        else:
            s += 1
    passed, failed, skipped = passed + p, failed + x, skipped + s
    if x or s or p == 0:
        bad.append((name, p, x, s))

print(f"\n{len(files)} files — {passed} passed, {failed} failed, {skipped} skipped")

if bad:
    print("\nSuites that did not run clean:")
    for name, p, x, s in bad:
        why = []
        if x:
            why.append(f"{x} failed")
        if s:
            why.append(f"{s} SKIPPED")
        if p == 0:
            why.append("executed nothing")
        print(f"  {name}: {', '.join(why)}")

if skipped:
    print("\nFAIL: a suite skipped itself. These tests guard on isDbAvailable()")
    print("      and vitest exits 0 when everything is skipped, so a skip here")
    print("      means the check would have passed WITHOUT running. Fix the")
    print("      database connection (or exclude the suite explicitly, with a")
    print("      reason) rather than letting it pass quietly.")
    sys.exit(1)

if failed or vitest_rc != 0:
    print(f"\nFAIL: {failed} failing test(s); vitest exited {vitest_rc}.")
    sys.exit(1)

print("\nOK: every integration suite ran against a real Postgres.")
PY
