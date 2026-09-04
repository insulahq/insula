#!/usr/bin/env bash
# integration-waf-deploy-surfaces.sh — asserts the WAF edge lets every
# legitimate deploy-time payload REACH platform-api, and still blocks
# attack payloads. Written 2026-08-26 after CRS 930120 silently blocked
# every apache-php / nginx-php catalog deploy in production (the
# `var/www` entry of lfi-os-files.data matched the docroot parameter
# VALUE `/var/www/html`), plus custom-deployment env values / mount
# paths / compose documents / cron commands, and 932235 blocked the
# canonical `… && exec …` container entrypoint idiom. Guards the
# 9000108 exclusion in
# k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml.
#
# 2026-08-31: 9000109 (custom-deployments) and 9000110 (cron-jobs) were
# folded into 9000108. They had carried three different subsets of the
# 932xxx family across three sibling endpoints, so a value allowed on
# one endpoint was blocked on the next; 9000108 now covers all of them
# — plus /admin/cron-jobs, which had no exclusion at all — with the
# whole family. See `make waf-probe` for the behavioural assertion.
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

# check <expected> <label> <method> <path> <json-body> [extra curl args…]
check() {
  local want="$1" label="$2" method="$3" path="$4" body="$5" code
  shift 5
  code=$(curl "${CURL_OPTS[@]}" -o /dev/null -w '%{http_code}' -X "$method" \
    "${ADMIN_HOST}${path}" -H 'Content-Type: application/json' -d "$body" "$@")
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

# ── 934xxx "Application Attack Generic" (added 2026-09-04) ────────────────
# 934190 ('SSRF: scheme-less localhost or internal hostname', @pmFromFile
# ssrf-no-scheme.data) blocked POST …/custom-deployments/validate on
# production. The payload was `http://localhost/health` — the healthcheck in
# the platform's OWN default compose template, shipped pre-filled in the
# compose editor. The editor's untouched default stack could not be validated
# or created. The first case below is that exact document, verbatim; if it
# ever fails again the editor is broken for every tenant.
#
# The rest cover the family, not the one id that happened to fire — 932xxx
# was fixed one id at a time for days before it was taken as a set, and
# 934xxx matches Node/Ruby/Perl injection, SSTI, prototype pollution, ORM
# operators and SSRF, all of which are ordinary container-spec text.
echo "== 934xxx: container specs legitimately contain URLs, hosts and templates =="
check 401 "compose: SHIPPED default template (localhost healthcheck)" POST \
  "/api/v1/tenants/$TEN/custom-deployments/validate" \
  "{\"mode\":\"compose\",\"name\":\"probe\",\"compose_yaml\":\"services:\\n  web:\\n    image: traefik/whoami:latest\\n    healthcheck:\\n      test: [\\\"CMD-SHELL\\\", \\\"wget -qO- http://localhost/health\\\"]\\n  cache:\\n    image: redis:7-alpine\\n\"}"
check 401 "compose: SHIPPED default template (create path)" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  "{\"mode\":\"compose\",\"name\":\"probe\",\"compose_yaml\":\"services:\\n  web:\\n    image: traefik/whoami:latest\\n    healthcheck:\\n      test: [\\\"CMD-SHELL\\\", \\\"wget -qO- http://localhost/health\\\"]\\n\"}"
check 401 "custom: env value pointing at localhost" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  '{"mode":"simple","name":"probe","image":"nginx:1.27","env":[{"name":"API_URL","value":"http://localhost:8080"}]}'
check 401 "custom: env value with an in-cluster service host" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  '{"mode":"simple","name":"probe","image":"nginx:1.27","env":[{"name":"OTEL","value":"http://collector.observability.svc.cluster.local:4317"}]}'
# `{{ … }}` is the 934180/934200 SSTI shape and passes now. NOT covered here:
# `${VAR}` in an env value, which is blocked by 933135 (PHP-injection family,
# "Matched Data: ${DB_HOST} found within ARGS:json.env.array_0.value" —
# measured on DEV and production 2026-09-04). That is the same category error
# as 932/934 on these endpoints (platform-api is Node; nothing evaluates the
# value as PHP), but 933 is a family the 9000108 comment deliberately keeps,
# so widening to it is a separate, explicit decision — not a silent rider on
# this change. Do not "fix" this by adding ${VAR} to the case below and
# excluding 933 without measuring the whole family first.
check 401 "custom: SSTI-shaped config template in an env value" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  '{"mode":"simple","name":"probe","image":"nginx:1.27","env":[{"name":"TPL","value":"{{ .Env.PORT }}/config"}]}'
check 401 "custom: JSON env value containing __proto__" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  '{"mode":"simple","name":"probe","image":"nginx:1.27","env":[{"name":"CFG","value":"{\"__proto__\":{\"a\":1}}"}]}'
check 401 "custom: node entrypoint with require()" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  '{"mode":"simple","name":"probe","image":"node:22-alpine","command":["node","-e","require(\"http\").createServer().listen(3000)"]}'
check 401 "custom: Mongo URI with an ORM-operator-shaped query" POST \
  "/api/v1/tenants/$TEN/custom-deployments" \
  '{"mode":"simple","name":"probe","image":"nginx:1.27","env":[{"name":"MONGO","value":"mongodb://db:27017/app?readPreference=$nearest"}]}'
check 401 "cron: command curling a sibling service" POST \
  "/api/v1/tenants/$TEN/cron-jobs" \
  '{"name":"probe","schedule":"*/5 * * * *","type":"deployment","deployment_id":"1","command":"curl -fsS http://localhost/health"}'
check 401 "catalog deploy: configuration value pointing at localhost" POST \
  "/api/v1/tenants/$TEN/deployments" \
  '{"catalog_entry_id":"11111111-1111-1111-1111-111111111111","name":"probe","configuration":{"REDIS_URL":"redis://localhost:6379"}}'

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
# Was: the same body with `home_path` in ARGS, asserting 403. That went STALE
# when 9000112 shipped — it removes `930120;ARGS` across the whole of
# `^/api/v1/` on the platform hosts, so an OS-file path in any ARG reaches the
# API by design now. The assertion had been red on DEV and production alike
# (measured 2026-09-04) and was testing a posture the platform deliberately
# left behind. What 9000112 explicitly does NOT drop is 930120 on cookies —
# "REQUEST_URI, headers and cookies are still scanned by 930120 here; only
# ARGS are dropped" — so that is the live control.
check 403 "930120 still scans cookies (9000112 drops ARGS only)" POST \
  "/api/v1/tenants/$TEN/sftp-users" \
  '{"username":"probe"}' -H 'Cookie: probe=/var/www/html'
# The 934xxx removal is scoped to the four deploy endpoint groups. If this
# ever returns 401 the exclusion has leaked host-wide and every tenant-facing
# endpoint lost the family.
check 403 "934190 on a non-excluded endpoint" POST \
  "/api/v1/tenants/$TEN/sftp-users" \
  '{"username":"probe","home_path":"http://localhost/x"}'

echo
echo "waf-deploy-surfaces: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
