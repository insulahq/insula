#!/usr/bin/env bash
# test-waf-audit-redaction.sh — the WAF audit stream must not carry credentials.
#
# THE LEAK THIS GUARDS
#   ModSecurity's SecAuditLogParts includes part B (request headers), so every
#   BLOCKED request wrote the caller's full `Authorization: Bearer <jwt>` and
#   `platform_session` / `platform_refresh` cookies in cleartext to the
#   modsec-crs pod's stdout — node logs, and anything shipping them. A WAF block
#   is exactly the moment an admin's live credentials are most likely captured.
#   (Found 2026-08-03 while debugging a 403.)
#
#   Neither obvious fix works: libmodsecurity 3.0.16 REJECTS
#   `sanitiseRequestHeader` at config-parse time and crash-loops the WAF, and
#   dropping part B breaks WAF Events, which resolves the client-facing hostname
#   from request.headers["X-Forwarded-Host"].
#
#   So the record is written to a file and the audit-redactor sidecar streams it
#   to stdout with those headers masked. This test pins the sidecar's
#   substitution — extracted FROM THE DEPLOYMENT, so editing the manifest
#   without re-checking the semantics fails here.
#
# What must survive redaction (WAF Events depends on all of it):
#   • valid JSON                       • X-Forwarded-Host
#   • messages[].details.ruleId        • the request URI/method
#
# Exit: 0 all pass · 1 a case failed
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$ROOT/k8s/base/modsecurity-crs/deployment.yaml"
pass=0; fail=0
ok()  { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }

[[ -r "$DEPLOY" ]] || { echo "cannot read $DEPLOY" >&2; exit 1; }

# Pull the sed expression out of the shipped sidecar command.
SED_EXPR="$(grep -oE "s/\(\"\(Authorization[^']*" "$DEPLOY" | head -1)"
if [[ -z "$SED_EXPR" ]]; then
  SED_EXPR="$(grep -oE 's/\("\(Authorization[^'"'"']*' "$DEPLOY" | head -1)"
fi
if [[ -z "$SED_EXPR" ]]; then
  echo "FAIL: could not extract the redaction expression from $DEPLOY" >&2
  echo "      (the sidecar command must keep a sed 's/(\"(Authorization|...)\":\")...' form)" >&2
  exit 1
fi
# The YAML carries a doubled backslash for the capture group reference.
SED_EXPR="${SED_EXPR//\\\\1/\\1}"

echo "waf audit redaction:"
echo "  using expression from deployment.yaml"

RECORD='{"transaction":{"client_ip":"192.0.2.50","unique_id":"178579623278.134968","request":{"method":"POST","uri":"/api/v1/admin/dns-servers","headers":{"Host":"modsec-crs.traefik.svc.cluster.local","X-Forwarded-Host":"admin.example.test","Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.SUPERSECRETJWT.sig","Cookie":"platform_session=SESSIONSECRET; platform_refresh=REFRESHSECRET","Content-Type":"application/json"}},"response":{"http_code":403},"messages":[{"message":"RFI Attack","details":{"ruleId":"931100","severity":"2"}},{"message":"Inbound Anomaly Score Exceeded","details":{"ruleId":"949110","severity":"0"}}]}}'

OUT="$(printf '%s\n' "$RECORD" | sed -E "$SED_EXPR")"

# 1. No secret material survives.
if grep -qE 'SUPERSECRETJWT|SESSIONSECRET|REFRESHSECRET' <<<"$OUT"; then
  bad "credentials removed from the stream"
else
  ok "credentials removed from the stream"
fi

# 2. Still valid JSON — a broken record would blind WAF Events entirely.
if printf '%s' "$OUT" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
  ok "record is still valid JSON"
else
  bad "record is still valid JSON"
fi

# 3. Everything the scraper reads must survive.
python3 - "$OUT" <<'PY' && ok "X-Forwarded-Host, rule ids, URI and method preserved" || bad "X-Forwarded-Host, rule ids, URI and method preserved"
import json,sys
t = json.loads(sys.argv[1])['transaction']
h = t['request']['headers']
assert h['X-Forwarded-Host'] == 'admin.example.test', h.get('X-Forwarded-Host')
assert t['request']['uri'] == '/api/v1/admin/dns-servers'
assert t['request']['method'] == 'POST'
ids = [m['details']['ruleId'] for m in t['messages']]
assert ids == ['931100', '949110'], ids
# The headers must still be PRESENT (masked), not deleted — a missing key
# would change the shape the scraper walks.
assert h['Authorization'] == '<redacted>', h['Authorization']
assert h['Cookie'] == '<redacted>', h['Cookie']
PY

# 4. A record with no credentials must pass through untouched.
CLEAN='{"transaction":{"request":{"headers":{"X-Forwarded-Host":"shop.example.test"}}}}'
if [[ "$(printf '%s\n' "$CLEAN" | sed -E "$SED_EXPR")" == "$CLEAN" ]]; then
  ok "credential-free record passes through unchanged"
else
  bad "credential-free record passes through unchanged"
fi

echo
if (( fail > 0 )); then
  printf '\033[31m%d failed\033[0m, %d passed\n' "$fail" "$pass" >&2
  exit 1
fi
printf '\033[32mall %d checks passed\033[0m\n' "$pass"
