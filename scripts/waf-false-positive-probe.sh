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
  # NOTE: deliberately no `trap ... RETURN`. A RETURN trap set inside a
  # function is GLOBAL in bash (it is not scoped to the function unless
  # `functrace` is on), so it survives and re-fires on the return of any
  # later function — under `set -u` that aborted the run with
  # "out: unbound variable" the moment a wrapper like envprobe() was added.
  out=$(mktemp)
  # One retry on a hard curl failure (000). A transient reset would otherwise
  # fail the suite and read as a WAF regression; a genuinely dead endpoint
  # fails twice and is still reported.
  for _attempt in 1 2; do
    if [ -n "$body" ]; then
      code=$(curl -sk -o "$out" -w '%{http_code}' -m 30 -X "$method" "$API$path" \
        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body")
    else
      code=$(curl -sk -o "$out" -w '%{http_code}' -m 30 -X "$method" "$API$path" \
        -H "Authorization: Bearer $TOKEN")
    fi
    [ "$code" = "000" ] || break
    sleep 2
  done
  if [ "$code" = "403" ] && ! grep -q '"error"' "$out" 2>/dev/null; then
    printf '  BLOCKED BY WAF  %s\n' "$label"; fail=$((fail+1))
  elif [ "$code" = "000" ]; then
    # curl never got a response (timeout / connection reset). This is NOT
    # evidence the request reached the API — counting it as a pass is how a
    # broken endpoint reads as green.
    printf '  NO RESPONSE     %-44s (curl failed)\n' "$label"; fail=$((fail+1))
  else
    printf '  reached API     %-44s (%s)\n' "$label" "$code"; pass=$((pass+1))
  fi
  rm -f "$out"
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

echo "── the platform's OWN catalog defaults must deploy ──"
# Reported 2026-08-31: "WHY IS A STANDARD DEPLOY OF A PHP APPLICATION
# TRIGGERING THE WAF?" — because the Official Catalog's apache-php entry ships
# PHP_ERROR_LOG=/dev/stderr by default, and 930120 matches /dev/std* against
# lfi-os-files.data. Every default PHP deploy 403'd at the API. Measured on
# production that day: /dev/stderr → 403, /dev/stdout → 403, and all 33 catalog
# default values → 403. The platform blocked its own defaults, which no probe
# of hand-written payloads would ever have found.
#
# These send the catalog's real default env values through the real deploy
# endpoint. The assertion stays "the request reached the API".
envprobe() { # label  envJson
  probe "$1" POST "/api/v1/tenants/$TENANT/deployments" \
    "{\"name\":\"waf-probe-nonexistent\",\"catalogEntryId\":\"00000000-0000-0000-0000-000000000000\",\"env\":$2}"
}
envprobe "PHP_ERROR_LOG=/dev/stderr"   '{"PHP_ERROR_LOG":"/dev/stderr"}'
envprobe "PHP_ERROR_LOG=/dev/stdout"   '{"PHP_ERROR_LOG":"/dev/stdout"}'
envprobe "log path /var/log/php.log"   '{"PHP_ERROR_LOG":"/var/log/php.log"}'
envprobe "DOCUMENT_ROOT=/var/www/html" '{"DOCUMENT_ROOT":"/var/www/html"}'
envprobe "entrypoint /bin/sh -c"       '{"CONTAINER_ENTRYPOINT":"/bin/sh -c exec php-fpm"}'
envprobe "docker-php-entrypoint"       '{"CONTAINER_ENTRYPOINT":"docker-php-entrypoint apache2-foreground"}'
envprobe "PID-1 idiom (&& exec)"       '{"CONTAINER_COMMAND":"php migrate --force && exec php-fpm"}'
envprobe "cron schedule + command"     '{"CRON_COMMAND":"/usr/local/bin/php /var/www/html/cron.php"}'

echo "── app terminal + cron commands must NEVER be blocked ──"
# Operator requirement 2026-08-31: "app terminal commands as well as cron jobs
# will never be blocked by WAF". A cron command and a terminal command ARE
# shell code, so every 932xxx (RCE) match on them is a false positive by
# construction. Three real gaps this covers, all measured that day:
#   · /admin/cron-jobs and /admin/cron-jobs/bulk had NO exclusion at all —
#     only /tenants/<id>/cron-jobs was scoped, so admin-created cron jobs
#     were blocked outright.
#   · the tenant cron exclusion carried 932235 but not 932160, so a command
#     containing /dev/stderr or /bin/sh blocked while `&& exec` passed.
#   · …/deployments/<id>/terminal fell outside the old URI regex, which
#     stopped at one path segment after /deployments.
CMD_SHELL='/bin/sh -c exec php-fpm'
CMD_CRON='php /var/www/html/artisan schedule:run'
for target in "tenant cron:/api/v1/tenants/$TENANT/cron-jobs" \
              "admin cron:/api/v1/admin/cron-jobs" \
              "admin cron bulk:/api/v1/admin/cron-jobs/bulk"; do
  probe "${target%%:*} — shell command" POST "${target#*:}" \
    "$(CMD="$CMD_SHELL" python3 -c 'import json,os;print(json.dumps({"command":os.environ["CMD"],"schedule":"* * * * *","name":"waf-probe"}))')"
  probe "${target%%:*} — artisan path"  POST "${target#*:}" \
    "$(CMD="$CMD_CRON" python3 -c 'import json,os;print(json.dumps({"command":os.environ["CMD"],"schedule":"* * * * *","name":"waf-probe"}))')"
done
# The app terminal is a WebSocket upgrade; modsec inspects the upgrade
# request, so a command in the query string must not 403 the handshake.
probe "app terminal upgrade" GET \
  "/api/v1/tenants/$TENANT/deployments/00000000-0000-0000-0000-000000000000/terminal?cmd=%2Fbin%2Fsh%20-c%20exec%20php-fpm"

echo "── an exclusion must actually UNBLOCK (create → verify → delete) ──"
# THE test this suite was missing. Until 2026-08-31 the panel's default and
# recommended scope was `args_names_only`, which removes the ARGS_NAMES target
# only. For any rule matching argument VALUES that removes nothing — so an
# operator could whitelist a rule, see the row saved, watch the ConfigMap
# reconcile, confirm the directive inside the running modsec container, and
# still be blocked. Everything reported success except the actual behaviour.
#
# Asserting the row exists is exactly the mistake that hid it. This asserts the
# REQUEST changes: blocked → excluded → allowed → un-excluded → blocked again.
# Set WAF_PROBE_SKIP_ROUNDTRIP=1 to skip (it briefly narrows one rule on the
# admin host; the trap removes it even if the script dies).
EXCL_ID=""
cleanup_exclusion() {
  [ -n "$EXCL_ID" ] || return 0
  curl -sk -o /dev/null -m 30 -X DELETE \
    "$API/api/v1/admin/security/waf-rule-exclusions/$EXCL_ID" \
    -H "Authorization: Bearer $TOKEN" \
    || echo "waf-probe: WARNING could not delete exclusion $EXCL_ID — remove it in Security → WAF" >&2
  EXCL_ID=""
}
trap cleanup_exclusion EXIT INT TERM

waf_blocks() { # json → 0 when the WAF blocks it
  local out code
  out=$(mktemp)
  code=$(curl -sk -o "$out" -w '%{http_code}' -m 30 -X POST "$API/api/v1/tenants/$TENANT/files/rename" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1")
  local blocked=1
  if [ "$code" = "403" ] && ! grep -q '"error"' "$out" 2>/dev/null; then blocked=0; fi
  rm -f "$out"
  return "$blocked"
}

if [ -n "${WAF_PROBE_SKIP_ROUNDTRIP:-}" ]; then
  echo "  skipped         WAF_PROBE_SKIP_ROUNDTRIP is set"
else
  # 930100 path traversal — reliably blocked, and the control case above
  # already proves it. Scoped to this host only, for the length of this test.
  ROUNDTRIP_SCOPE="${WAF_PROBE_ROUNDTRIP_SCOPE:-args}"
  TRAVERSAL='{"oldPath":"/x/../../../../etc/passwd","newPath":"/x/a"}'
  API_HOST="$(printf '%s' "$API" | sed -E 's#^https?://##; s#/.*##')"
  HOST_RX="^$(printf '%s' "$API_HOST" | sed 's/\./\\./g')$"

  if ! waf_blocks "$TRAVERSAL"; then
    echo "  INCONCLUSIVE    baseline request is not blocked — cannot test unblocking"; fail=$((fail+1))
  else
    printf '  baseline        blocked as expected\n'
    CREATE_OUT=$(mktemp)
    # Build with json.dumps — HOST_RX contains regex backslashes (\.) and a
    # hand-interpolated "\." is an INVALID JSON escape, which Fastify rejects
    # as FST_ERR_CTP_INVALID_JSON_BODY before the request is ever evaluated.
    CREATE_BODY=$(HOST_RX="$HOST_RX" SCOPE="$ROUNDTRIP_SCOPE" python3 -c \
      'import json,os;print(json.dumps({"ruleId":"930100","hostnameRegex":os.environ["HOST_RX"],"scope":os.environ["SCOPE"],"reason":"waf-probe round-trip; auto-deleted"}))')
    curl -sk -o "$CREATE_OUT" -m 30 -X POST "$API/api/v1/admin/security/waf-rule-exclusions" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "$CREATE_BODY"
    EXCL_ID=$(python3 -c 'import sys,json;print(json.load(sys.stdin).get("data",{}).get("id",""))' <"$CREATE_OUT" 2>/dev/null)

    if [ -z "$EXCL_ID" ]; then
      # Distinguish "this build predates the scope" from a genuine failure —
      # otherwise a stale deployment reads as a WAF regression.
      if grep -qi 'invalid_enum_value\|scope' "$CREATE_OUT" 2>/dev/null; then
        echo "  INCONCLUSIVE    the API rejected scope='$ROUNDTRIP_SCOPE' — deployed backend predates it"
        echo "                  re-run after this branch is deployed, or set WAF_PROBE_ROUNDTRIP_SCOPE=full_disable"
      else
        echo "  FAILED          could not create the exclusion:"
        sed 's/^/                  /' <"$CREATE_OUT" | head -3
        fail=$((fail+1))
      fi
      rm -f "$CREATE_OUT"
    else
      rm -f "$CREATE_OUT"
      # The reconciler bumps a hash annotation and modsec-crs rolls. Poll
      # rather than sleep a fixed amount: a fixed wait either flakes or
      # wastes time, and a poll that never succeeds is itself the finding.
      unblocked=1
      for _ in $(seq 1 30); do
        if ! waf_blocks "$TRAVERSAL"; then unblocked=0; break; fi
        sleep 2
      done
      if [ "$unblocked" -eq 0 ]; then
        printf '  UNBLOCKED       exclusion 930100 scope=%s took effect\n' "$ROUNDTRIP_SCOPE"; pass=$((pass+1))
      else
        printf '  STILL BLOCKED   exclusion saved but never took effect  ← the 2026-08-31 bug\n'; fail=$((fail+1))
      fi

      cleanup_exclusion
      reblocked=1
      for _ in $(seq 1 30); do
        if waf_blocks "$TRAVERSAL"; then reblocked=0; break; fi
        sleep 2
      done
      if [ "$reblocked" -eq 0 ]; then
        printf '  re-blocked      protection restored after delete\n'; pass=$((pass+1))
      else
        printf '  NOT RE-BLOCKED  deleting the exclusion did not restore the rule  ← worse than the bug\n'; fail=$((fail+1))
      fi
    fi
  fi
fi

echo "── controls: genuine attacks must STILL be blocked ──"
# If these stop being blocked the exclusions have been widened too far, which
# would be a far worse outcome than the false positives they fix.
ctl() { # label json  → expects a WAF block
  local out code
  out=$(mktemp)   # no RETURN trap — see the note in probe()
  code=$(curl -sk -o "$out" -w '%{http_code}' -m 30 -X POST "$API/api/v1/tenants/$TENANT/files/rename" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2")
  if [ "$code" = "403" ] && ! grep -q '"error"' "$out" 2>/dev/null; then
    printf '  still blocked   %s\n' "$1"; pass=$((pass+1))
  else
    printf '  NOT BLOCKED     %-44s (%s)  ← exclusions are too wide\n' "$1" "$code"; fail=$((fail+1))
  fi
  rm -f "$out"
}
ctl "path traversal (930100/930110)" '{"oldPath":"/x/../../../../etc/passwd","newPath":"/x/a"}'
ctl "shell code on a NON-exempt path" '{"oldPath":"/a","newPath":"/bin/sh -c exec sh"}'

# The 932xxx carve-out is scoped to the command-carrying endpoints. Injection
# families must still fire on those same endpoints, or the exclusion has been
# widened from "RCE rules on command fields" to "no WAF here at all".
ctl2() { # label json  → expects a WAF block on /deployments
  local out code
  out=$(mktemp)
  code=$(curl -sk -o "$out" -w '%{http_code}' -m 30 -X POST "$API/api/v1/tenants/$TENANT/deployments" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$2")
  if [ "$code" = "403" ] && ! grep -q '"error"' "$out" 2>/dev/null; then
    printf '  still blocked   %s\n' "$1"; pass=$((pass+1))
  else
    printf '  NOT BLOCKED     %-44s (%s)  ← exclusions are too wide\n' "$1" "$code"; fail=$((fail+1))
  fi
  rm -f "$out"
}
ctl2 "SQLi on /deployments (942)"     '{"env":{"A":"1'"'"' UNION SELECT username,password FROM users-- "}}'
ctl2 "traversal on /deployments (930)" '{"env":{"A":"/x/../../../../etc/passwd"}}'

echo
echo "── RESULT: $pass ok, $fail problem(s) ──"
[ "$fail" -eq 0 ] || {
  echo "A legitimate request was blocked, or an attack was not. Check Security →" >&2
  echo "WAF Events, and k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml." >&2
  exit 1
}
exit 0
