#!/usr/bin/env bash
# integration-waf-deploy-surfaces.sh — asserts the WAF edge lets every
# legitimate deploy-time payload REACH platform-api, and still blocks
# attack payloads. Written 2026-08-26 after CRS 930120 silently blocked
# every apache-php / nginx-php catalog deploy in production (the
# `var/www` entry of lfi-os-files.data matched the docroot parameter
# VALUE `/var/www/html`), plus custom-deployment env values / mount
# paths / compose documents / cron commands, and 932235 blocked the
# canonical `… && exec …` container entrypoint idiom. Guards the
# 9000108-9000110 exclusions in
# k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml.
#
# DELIBERATELY UNAUTHENTICATED. The WAF is the layer under test and it
# runs before auth, so the status code is a clean edge discriminator:
#   401 (platform-api JSON envelope) -> request PASSED the WAF
#   403 (bare modsec/nginx page)     -> request BLOCKED at the edge
# Nothing is ever created; feature function is covered by the real-auth
# suites. This is NOT a bypass of the layer under test — it IS the
# layer under test (a token would add nothing: modsec never sees auth
# state).
#
# Env:
#   ADMIN_HOST    — defaults to https://admin.$(resolve_platform_apex)
#   CURL_INSECURE — set 1 to ignore TLS errors

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.$(resolve_platform_apex)}"
TEN="00000000-0000-0000-0000-000000000000"
CURL_OPTS=(-s --max-time 30)
[[ "${CURL_INSECURE:-0}" == "1" ]] && CURL_OPTS+=(-k)

pass=0 fail=0

# check <expected> <label> <method> <path> <json-body>
check() {
  local want="$1" label="$2" method="$3" path="$4" body="$5" code
  code=$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' -X "$method" \
    "${ADMIN_HOST}${path}" -H 'Content-Type: application/json' -d "$body")
  if [[ "$code" == "$want" ]]; then
    echo "  ok   $label ($code)"; pass=$((pass+1))
  else
    echo "  FAIL $label — want $want got $code"; fail=$((fail+1))
  fi
}

echo "== legitimate deploy payloads must pass the WAF (401 = reached API) =="
check 401 "catalog deploy: apache-php docroot default" POST \
  "/api/v1/tenants/$TEN/deployments" \
  '{"catalog_entry_id":"11111111-1111-1111-1111-111111111111","name":"probe","configuration":{"APACHE_DOCUMENT_ROOT":"/var/www/html","PHP_MEMORY_LIMIT":"256M"}}'
check 401 "catalog deploy edit: Laravel public docroot" PATCH \
  "/api/v1/tenants/$TEN/deployments/22222222-2222-2222-2222-222222222222" \
  '{"configuration":{"APACHE_DOCUMENT_ROOT":"/var/www/html/public"}}'
check 401 "custom: env value with dictionary filename" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  '{"mode":"simple","name":"probe","image":"ghcr.io/acme/app:1","env":[{"name":"CONFIG_FILE","value":"/etc/app/config.yaml"}]}'
check 401 "custom: volume mount at /var/lib/mysql" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  '{"mode":"simple","name":"probe","image":"mysql:8","volumes":[{"kind":"volume","name":"data","containerPath":"/var/lib/mysql"}]}'
check 401 "custom: '&& exec' entrypoint idiom" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  '{"mode":"simple","name":"probe","image":"php:8.3-cli","command":["sh","-c","php artisan migrate --force && exec php-fpm"]}'
check 401 "compose: canonical wordpress+mysql document" POST \
  "/api/v1/tenants/$TEN/custom-deployments/validate" \
  "{\"mode\":\"compose\",\"compose_yaml\":\"services:\\n  db:\\n    image: mysql:8\\n    volumes:\\n      - db_data:/var/lib/mysql\\n  wp:\\n    image: wordpress\\n    volumes:\\n      - wp:/var/www/html\\n\"}"
check 401 "cron: textbook Laravel scheduler command" POST \
  "/api/v1/tenants/$TEN/cron-jobs" \
  '{"name":"probe","schedule":"*/5 * * * *","type":"deployment","deployment_id":"1","command":"php /var/www/html/artisan schedule:run"}'

echo "== attack payloads must stay blocked at the edge (403) =="
check 403 "traversal in deployments query arg" POST \
  "/api/v1/tenants/$TEN/deployments?redirect=../../etc/passwd" \
  '{"catalog_entry_id":"11111111-1111-1111-1111-111111111111","name":"probe","configuration":{"FOO":"bar"}}'
check 403 "traversal in storage_path" POST \
  "/api/v1/tenants/$TEN/deployments" \
  '{"catalog_entry_id":"11111111-1111-1111-1111-111111111111","name":"probe","storage_path":"../../etc/passwd"}'
check 403 "SQLi in custom image field" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  "{\"mode\":\"simple\",\"name\":\"probe\",\"image\":\"x' UNION SELECT password FROM users--\"}"
check 403 "traversal in webcron url" POST \
  "/api/v1/tenants/$TEN/cron-jobs" \
  '{"name":"probe","schedule":"* * * * *","type":"webcron","url":"https://x.example/../../etc/passwd"}'
check 403 "930120 on a non-excluded endpoint" POST \
  "/api/v1/tenants/$TEN/sftp-users" \
  '{"username":"probe","home_path":"/var/www/html"}'

echo
echo "waf-deploy-surfaces: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
