#!/usr/bin/env bash
# ci-waf-admin-carveout-check.sh — the WAF-management API must not sit behind
# the WAF, and the carve-out must be visible to the drift comparison.
#
# WHY: a rule exclusion describes an attack pattern — that is its purpose.
# Submitting one puts attack-shaped text in the request body, the WAF matches
# it, and the operator cannot disarm a false positive. The safety valve ends up
# behind the thing it disarms. Hit in production 2026-08-30: a tenant could not
# rename `.htaccess` (CRS 930120), and the whitelist request was itself blocked
# by a message telling the operator to go and whitelist it.
#
# A CRS exclusion cannot fix this in general — an exclusion for an SQLi rule
# contains SQLi-shaped text and trips 942xxx instead. Only removing WAF
# inspection from the endpoint works for every rule.
#
# Exit: 0 clean · 1 the carve-out is missing or untracked
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="backend/src/modules/system-settings/ingress-reconciler.ts"
fail=0
cd "$ROOT" || exit 1

# 1. The carve-out route must exist and strip the WAF middleware.
grep -q "WAF_ADMIN_PATH_REGEXP" "$F" || {
  echo "ci-waf-admin-carveout: no WAF_ADMIN_PATH_REGEXP in $F" >&2; fail=1; }
grep -q "wafAdminMiddlewares" "$F" || {
  echo "ci-waf-admin-carveout: no middleware filter for the WAF-admin route" >&2; fail=1; }
grep -q "wafAdminMiddlewares = panelMiddlewares.filter(m => m.name !== PLATFORM_WAF_MIDDLEWARE_NAME)" "$F" || {
  echo "ci-waf-admin-carveout: the WAF-admin route does not strip the WAF middleware" >&2; fail=1; }

# 2. It must be tracked by the drift comparison. A carve-out shares its host
#    and backend with the panel route, so it collapses into the same entry and
#    is INVISIBLE to a host/service comparison. #300 shipped a correct
#    carve-out that was never applied for exactly this reason.
grep -q "wafAdminCarveOut" "$F" || {
  echo "ci-waf-admin-carveout: carve-out is not tracked in the drift comparison —" >&2
  echo "  it will look in-sync forever and never be applied (see #300)" >&2; fail=1; }
# The comparison itself must require it, not merely record it.
awk '/return \(/,/\);/' "$F" | grep -q "r.wafAdminCarveOut" || {
  echo "ci-waf-admin-carveout: wafAdminCarveOut is recorded but not compared" >&2; fail=1; }

[ "$fail" -eq 0 ] && echo "ci-waf-admin-carveout: ok"
exit "$fail"
