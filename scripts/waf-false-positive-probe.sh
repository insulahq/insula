#!/usr/bin/env bash
# waf-false-positive-probe.sh — assert the WAF does not block LEGITIMATE
# platform-API requests. Run against a live cluster after any deploy that
# touches CRS rules, the exclusion ConfigMap, or the ingress reconciler.
#
# WHY THIS EXISTS
# ---------------
# A WAF false positive is invisible from the inside. The request never reaches
# the platform API, so nothing is logged application-side, no error is raised,
# and — until 2026-08-30 — the panel rendered nothing at all. The only signal
# was a tenant reporting that "moving certain files fails without error".
#
# Two rules had already been excluded for exactly this class (9000100 for
# ARGS_NAMES, 9000108 for 930120;ARGS) and a third was still firing. Nobody
# knew, because nothing checks.
#
# Each case below is a request a real operator or tenant makes, carrying a
# value that a CRS dictionary happens to contain. The assertion is narrow and
# robust: the response must NOT be 403-from-the-WAF. A 400/404/409 from the
# application is a PASS — it means the request arrived, which is the only thing
# under test. Auth, validation and business logic are other scripts' problem.
#
# Usage:
#   API_URL=https://admin.<apex> ADMIN_EMAIL=… ADMIN_PASSWORD=… \
#     ./scripts/waf-false-positive-probe.sh
#   # or, on a cluster node with /etc/insula/admin-credentials:
#   ./scripts/waf-false-positive-probe.sh
#
# Exit: 0 all legitimate requests reached the API · 1 at least one was blocked
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

if [ -z "${ADMIN_EMAIL:-}" ] && [ -r /etc/insula/admin-credentials ]; then
  set -a; . /etc/insula/admin-credentials; set +a
fi
API="${API_URL:-${API:-}}"
if [ -z "$API" ]; then
  echo "waf-probe: set API_URL (e.g. https://admin.example.test)" >&2; exit 1
fi
: "${ADMIN_EMAIL:?waf-probe: ADMIN_EMAIL required}"
: "${ADMIN_PASSWORD:?waf-probe: ADMIN_PASSWORD required}"

TOKEN=$(curl -sk -m 30 -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json,os;print(json.dumps({"email":os.environ["ADMIN_EMAIL"],"password":os.environ["ADMIN_PASSWORD"],"panel":"admin"}))')" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("token",""))' 2>/dev/null)
if [ "${#TOKEN}" -lt 50 ]; then
  echo "waf-probe: login failed against $API — cannot distinguish a WAF block from an auth failure" >&2
  exit 1
fi

TENANT="${PROBE_TENANT_ID:-}"
if [ -z "$TENANT" ] && command -v kubectl >/dev/null 2>&1; then
  TENANT=$(kubectl exec -i -n platform system-db-1 -c postgres -- \
    psql -U postgres -d platform -A -t -c \
    "select id from tenants where \"provisioningStatus\"::text='provisioned' limit 1" 2>/dev/null | tr -d '[:space:]')
fi
if [ -z "$TENANT" ]; then
  echo "waf-probe: no tenant id (set PROBE_TENANT_ID) — the tenant-scoped cases cannot run" >&2
  exit 1
fi

pass=0; fail=0

# A 403 whose body is not the platform's JSON envelope is the WAF: the request
# never reached Fastify. A 403 WITH an envelope is the application refusing,
# which is a legitimate answer and not what this probe is about.
probe() { # label  method  path  json
  local label="$1" method="$2" path="$3" body="${4:-}" out code
  out=$(mktemp); trap 'rm -f "$out"' RETURN
  if [ -n "$body" ]; then
    code=$(curl -sk -o "$out" -w '%{http_code}' -m 30 -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body")
  else
    code=$(curl -sk -o "$out" -w '%{http_code}' -m 30 -X "$method" "$API$path" \
      -H "Authorization: Bearer $TOKEN")
  fi
  if [ "$code" = "403" ] && ! grep -q '"error"' "$out" 2>/dev/null; then
    printf '  BLOCKED BY WAF  %s\n' "$label"; fail=$((fail+1))
  else
    printf '  reached API     %-44s (%s)\n' "$label" "$code"; pass=$((pass+1))
  fi
}

echo "── legitimate values that CRS dictionaries happen to contain ──"
# 930130 restricted-files.data. Every one of these was a 403 before 9000111/9000112.
probe "rename .htaccess"      POST "/api/v1/tenants/$TENANT/files/rename" '{"oldPath":"/probe/.htaccess","newPath":"/probe/a"}'
probe "copy .htaccess"        POST "/api/v1/tenants/$TENANT/files/copy"   '{"sourcePath":"/probe/.htaccess","destPath":"/probe/b"}'
probe "delete .htaccess"      POST "/api/v1/tenants/$TENANT/files/delete" '{"path":"/probe/.htaccess"}'
probe "rename wp-config.php"  POST "/api/v1/tenants/$TENANT/files/rename" '{"oldPath":"/probe/wp-config.php","newPath":"/probe/c"}'
probe "rename web.config"     POST "/api/v1/tenants/$TENANT/files/rename" '{"oldPath":"/probe/web.config","newPath":"/probe/d"}'
probe "rename .git/config"    POST "/api/v1/tenants/$TENANT/files/rename" '{"oldPath":"/probe/.git/config","newPath":"/probe/e"}'
probe "sftp home /.git/config" POST "/api/v1/tenants/$TENANT/sftp-users"  '{"username":"","homePath":"/.git/config"}'
probe "database web.config"   POST "/api/v1/tenants/$TENANT/databases"    '{"name":"web.config","engine":"mariadb"}'
probe "domain .htpasswd.*"    POST "/api/v1/tenants/$TENANT/domains"      '{"domain":".htpasswd.example.test"}'
probe "dns record .htaccess"  POST "/api/v1/admin/dns/records"            '{"name":".htaccess","type":"TXT","content":"x"}'

echo "── the operator must always be able to disarm a false positive ──"
# The endpoint that stores a rule exclusion necessarily carries the pattern it
# excludes. Without the ingress carve-out this 403s and the WAF cannot be
# reconfigured through the panel at all.
probe "list WAF exclusions"   GET  "/api/v1/admin/security/waf-rule-exclusions"
probe "create WAF exclusion"  POST "/api/v1/admin/security/waf-rule-exclusions" \
  '{"ruleId":"930130","target":"ARGS","uriPattern":"^/api/v1/tenants/[^/]+/files/","note":"probe — union select 1,2,3 from users where .htaccess"}'

echo "── controls: genuine attacks must STILL be blocked ──"
# If these stop being blocked the exclusions have been widened too far, which
# would be a far worse outcome than the false positives they fix.
ctl() { # label json  → expects a WAF block
  local out code
  out=$(mktemp); trap 'rm -f "$out"' RETURN
  code=$(curl -sk -o "$out" -w '%{http_code}' -m 30 -X POST "$API/api/v1/tenants/$TENANT/files/rename" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2")
  if [ "$code" = "403" ] && ! grep -q '"error"' "$out" 2>/dev/null; then
    printf '  still blocked   %s\n' "$1"; pass=$((pass+1))
  else
    printf '  NOT BLOCKED     %-44s (%s)  ← exclusions are too wide\n' "$1" "$code"; fail=$((fail+1))
  fi
}
ctl "path traversal (930100/930110)" '{"oldPath":"/x/../../../../etc/passwd","newPath":"/x/a"}'

echo
echo "── RESULT: $pass ok, $fail problem(s) ──"
[ "$fail" -eq 0 ] || {
  echo "A legitimate request was blocked, or an attack was not. Check Security →" >&2
  echo "WAF Events, and k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml." >&2
  exit 1
}
exit 0
