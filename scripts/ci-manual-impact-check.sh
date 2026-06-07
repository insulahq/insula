#!/bin/bash
# ci-manual-impact-check.sh — keep the user manual (documentation/) in sync
# with user-visible changes.
#
# Rule: a PR that touches user-visible surfaces must EITHER also touch
# documentation/docs/** OR explicitly waive with a "Manual-Impact: none"
# trailer in any commit message of the PR (use when the change is genuinely
# invisible to operators/admins/tenants).
#
# User-visible surfaces (heuristic, tune as needed):
#   - frontend/*/src/pages/**           panel pages
#   - packages/api-contracts/src/**     API request/response shapes
#   - backend/src/modules/*/routes*.ts  API endpoints
#   - scripts/bootstrap.sh              installer flags/behavior
#
# MODE: report-only until DOCS_MANUAL_IMPACT_ENFORCE=1 is set in the workflow
# (planned ~2 weeks after introduction — see docs/roadmap/USER_MANUAL_WEBSITE.md).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BASE_REF="${GITHUB_BASE_REF:-main}"
git fetch origin "$BASE_REF" --depth=200 >/dev/null 2>&1 || true
MERGE_BASE=$(git merge-base "origin/$BASE_REF" HEAD 2>/dev/null || echo "")
[ -z "$MERGE_BASE" ] && { echo "manual-impact: cannot determine merge base — skipping"; exit 0; }

CHANGED=$(git diff --name-only "$MERGE_BASE"..HEAD)

impacted=$(echo "$CHANGED" | grep -E \
  '^frontend/[^/]+/src/pages/|^packages/api-contracts/src/|^backend/src/modules/.+/routes[^/]*\.ts$|^scripts/bootstrap\.sh$' \
  || true)

if [ -z "$impacted" ]; then
  echo "manual-impact: no user-visible surfaces touched — OK"
  exit 0
fi

if echo "$CHANGED" | grep -q '^documentation/docs/'; then
  echo "manual-impact: user-visible change + manual updated — OK"
  exit 0
fi

if git log "$MERGE_BASE"..HEAD --format=%B | git interpret-trailers --parse \
     | grep -qiE '^Manual-Impact:[[:space:]]*none'; then
  echo "manual-impact: waived via 'Manual-Impact: none' trailer — OK"
  exit 0
fi

echo "manual-impact: user-visible surfaces changed without a manual update:"
echo "$impacted" | sed 's/^/  - /'
echo ""
echo "Either update the relevant page under documentation/docs/, or add a"
echo "'Manual-Impact: none' trailer to a commit message if nothing user-visible changed."

if [ "${DOCS_MANUAL_IMPACT_ENFORCE:-0}" = "1" ]; then
  exit 1
fi
echo "(report-only mode — not failing the build)"
exit 0
