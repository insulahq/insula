#!/usr/bin/env bash
# integration-waf-api-scope.sh — assert ADR-060's WAF scope on a live cluster.
#
# Drives the real ingress with modsec-crs in the request path. Every probe is
# UNAUTHENTICATED: the WAF answers before auth, so 401 means "the WAF passed
# it" and 403 means "the WAF blocked it", and nothing can mutate state. That
# also makes this safe to run against production.
#
# Run BEFORE and AFTER the rule change and compare — the point is not that
# everything passes, it is that the RIGHT things changed and the rest did not.
#
# Usage:
#   ADMIN_HOST=admin.example.test TENANT_HOST=tenant.example.test \
#     scripts/integration-waf-api-scope.sh [--expect-before|--expect-after]
set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:?ADMIN_HOST required}"
TENANT_HOST="${TENANT_HOST:-}"

# Accept BOTH conventions for these variables.
#
# This script builds `https://$ADMIN_HOST…`, i.e. it wants a bare hostname. The
# rest of the harness — and scripts/integration.env — sets ADMIN_HOST to a full
# URL (`https://admin.<apex>`). Run through integration-all.sh this produced
# `https://https://admin.<apex>/…`, so every probe came back HTTP 000 and the
# whole suite reported red without a single request leaving the machine:
#
#     FAIL  GET /api/v1/.env (930130)   HTTP 000 (wanted ^403$)
#
# 000 is "no connection", never a WAF verdict — a suite that reports it for
# every row is not testing anything. Normalising here keeps both the standalone
# usage in the header comment and the aggregate runner working.
strip_scheme() { local v="${1#http://}"; v="${v#https://}"; printf '%s' "${v%%/*}"; }
ADMIN_HOST="$(strip_scheme "$ADMIN_HOST")"
[ -n "$TENANT_HOST" ] && TENANT_HOST="$(strip_scheme "$TENANT_HOST")"

# A WAF suite cannot observe a block while this runner is CrowdSec-allowlisted:
# the allowlist suppresses WAF enforcement, so every block reads as a
# pass-through (401 instead of 403). Standalone copy of
# lib/integration-env.sh:skip_if_runner_allowlisted — this script deliberately
# does not source that library.
if [ "${INTEGRATION_RUNNER_ALLOWLISTED:-0}" = "1" ]; then
  echo "SKIP: waf-api-scope cannot run while this runner is CrowdSec-allowlisted." >&2
  echo "      Re-run with INTEGRATION_SELF_BAN_GUARD=0 to exercise the WAF." >&2
  exit "${INTEGRATION_SKIP_RC:-77}"
fi
MODE="${1:---report}"
NIL=00000000-0000-0000-0000-000000000000

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT   # /tmp leftovers pin node RAM

pass=0; fail=0
declare -a SUMMARY

probe() { # name expected_regex method url [curl-args...]
  local name="$1" want="$2" method="$3" url="$4"; shift 4
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X "$method" "$url" "$@" 2>/dev/null)
  SUMMARY+=("$(printf '%-46s %s' "$name" "$code")")
  if [[ "$code" =~ $want ]]; then
    printf '  PASS  %-44s HTTP %s\n' "$name" "$code"; pass=$((pass+1))
  else
    printf '  FAIL  %-44s HTTP %s (wanted %s)\n' "$name" "$code" "$want"; fail=$((fail+1))
  fi
}

# ── payloads ──────────────────────────────────────────────────────────────
python3 - "$TMP" <<'PY'
import json, sys
d = sys.argv[1]
dump = "\n".join(
    [f"DROP TABLE IF EXISTS `t{i}`;"
     f"CREATE TABLE `t{i}` (`id` int(11) NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;"
     f"INSERT INTO `t{i}` VALUES (1),(2);" for i in range(30)])
open(f"{d}/sql.json", "w").write(json.dumps({"database": "probe", "sql": dump}))
open(f"{d}/dump.sql", "w").write(dump)
PY

API="/api/v1/tenants/$NIL/deployments/$NIL/import"
JSON=(-H 'Content-Type: application/json')

# The one expectation that CHANGES. Loose in --report mode so the script is
# usable for a baseline; strict in the two directed modes so an AFTER run that
# silently still blocks is a FAILURE, not a shrug.
case "$MODE" in
  --expect-before) SQL_WANT='^403$' ;;   # the bug: body blocked
  --expect-after)  SQL_WANT='^401$' ;;   # fixed: WAF passes, auth rejects
  *)               SQL_WANT='^(401|403)$' ;;
esac

echo "=== A. Body payloads on the platform API (mode: $MODE) ==="
probe "SQL dump in a JSON body"        "$SQL_WANT" POST "https://$ADMIN_HOST$API" "${JSON[@]}" --data-binary @"$TMP/sql.json"
probe "octet-stream upload"            '^401$'       POST "https://$ADMIN_HOST/api/v1/tenants/$NIL/files/upload-raw?path=.p.sql" \
      -H 'Content-Type: application/octet-stream' --data-binary @"$TMP/dump.sql"

echo
echo "=== B. URL / method / header rules — MUST still block ==="
probe "GET /api/v1/.env (930130)"      '^403$' GET  "https://$ADMIN_HOST/api/v1/.env"
probe "path traversal in a query arg"  '^403$' GET  "https://$ADMIN_HOST/api/v1/tenants/$NIL/files/read?path=../../../../etc/passwd"
probe "SQLi in a QUERY STRING arg"     '^403$' GET  "https://$ADMIN_HOST/api/v1/tenants?search=1%27%20OR%201%3D1--%20"
probe "restricted extension in path"   '^403$' GET  "https://$ADMIN_HOST/api/v1/config.bak"

echo
echo "=== C. Non-API paths on the panel host — unchanged ==="
probe "/.env on the panel host"        '^403$' GET  "https://$ADMIN_HOST/.env"
probe "/.git/config on the panel host" '^403$' GET  "https://$ADMIN_HOST/.git/config"

if [ -n "$TENANT_HOST" ]; then
  echo
  echo "=== D. Tenant host keeps FULL coverage (scoping guard) ==="
  probe "tenant host /.env"            '^403$' GET  "https://$TENANT_HOST/.env"
  probe "tenant host /api/v1/.env"     '^403$' GET  "https://$TENANT_HOST/api/v1/.env"
fi

echo
echo "==============================================="
printf '%s\n' "${SUMMARY[@]}"
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ] || exit 1
