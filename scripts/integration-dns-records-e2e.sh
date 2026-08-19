#!/usr/bin/env bash
# integration-dns-records-e2e.sh — the tenant DNS-record flow, end to end.
#
# WHY THIS EXISTS
#   The reported bug: "Adding CNAME, MX and others succeeds in tenant panel, but
#   does not create the records in PowerDNS target." Nothing caught it, because
#   nothing drove the PLATFORM'S record API against a REAL authoritative server:
#     * the provider unit tests asserted the request body we SENT — they cannot
#       see PowerDNS reject it;
#     * the VM tier ran a real PowerDNS but only ever talked to it directly, and
#       never registered it with the platform, so `canManageDnsZone()` was false
#       and every record write was silently skipped.
#   MX, SRV and CAA were rejected for years while the API answered 201 Created,
#   and every mail record was published to `<apex>.<apex>.`
#
# WHAT IT ASSERTS (each record is READ BACK from the DNS server, then RESOLVED)
#   1. every record type the tenant UI offers is created via the platform API,
#      using only inputs that UI can produce;
#   2. each one exists in PowerDNS with the correct name and wire format;
#   3. each one actually RESOLVES (dig) — the user-visible outcome;
#   4. Sync Records reports the zone fully in_sync (no permanent conflicts);
#   5. a record the server rejects FAILS the API call instead of being persisted;
#   6. ACME issuance is withheld until the domain is verified.
#
# PRECONDITION: a DNS provider group with an enabled primary server, i.e.
# vm-integration-tests/setup-dns-provider.sh has run. Without it this suite
# fails loudly rather than skipping — a silent skip is how this went unnoticed.
#
# ENV
#   ADMIN_HOST, ADMIN_EMAIL, ADMIN_PASSWORD  (as every suite)
#   VMTEST_DNS_IP        the run's PowerDNS (for dig + direct API readback)
#   VMTEST_PDNS_API_KEY  its API key
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${ADMIN_HOST:?ADMIN_HOST unset}"
CURL_OPTS=(-s --max-time 30); [[ "${CURL_INSECURE:-}" == "1" ]] && CURL_OPTS+=(-k)

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ok:   $*"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $*" >&2; }
info() { echo "  ..    $*"; }

# ── auth ──────────────────────────────────────────────────────────────────────
TOKEN="${INTEGRATION_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HERE/integration-token.sh" ]]; then
  # shellcheck source=/dev/null
  source "$HERE/integration-token.sh" 2>/dev/null && TOKEN="$(get_admin_token 2>/dev/null || true)"
fi
[[ -n "$TOKEN" ]] || { echo "dns-records-e2e: could not obtain an admin token" >&2; exit 1; }

api() { # api <method> <path> [body] ; echoes "<body>\n<code>"
  local m="$1" p="$2" b="${3:-}"
  if [[ -n "$b" ]]; then
    curl "${CURL_OPTS[@]}" -w $'\n%{http_code}' -X "$m" "$ADMIN_HOST/api/v1$p" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary "$b"
  else
    curl "${CURL_OPTS[@]}" -w $'\n%{http_code}' -X "$m" "$ADMIN_HOST/api/v1$p" -H "Authorization: Bearer $TOKEN"
  fi
}
body_of() { printf '%s' "$1" | sed '$d'; }
code_of() { printf '%s' "$1" | tail -1; }
jqp() { python3 -c "import json,sys;$1" 2>/dev/null; }

# ── precondition: the platform must have an authoritative PowerDNS ────────────
R=$(api GET /admin/dns-servers)
PDNS_OK=$(body_of "$R" | jqp "
d=json.load(sys.stdin).get('data') or []
print('yes' if any((s.get('providerType') or s.get('provider_type'))=='powerdns'
      and (s.get('enabled') in (1,True)) and s.get('role')=='primary' for s in d) else 'no')")
if [[ "$PDNS_OK" != "yes" ]]; then
  echo "dns-records-e2e: PRECONDITION FAILED — no enabled primary PowerDNS registered." >&2
  echo "  run scripts/vm-integration-tests/setup-dns-provider.sh first." >&2
  exit 1
fi
GROUP_ID=$(api GET /admin/dns-provider-groups | body_of - 2>/dev/null | jqp "
d=json.load(sys.stdin).get('data') or []
print((d[0] or {}).get('id','') if d else '')") || true
[[ -n "${GROUP_ID:-}" ]] || GROUP_ID=$(body_of "$(api GET /admin/dns-provider-groups)" | jqp "
d=json.load(sys.stdin).get('data') or []
print(d[0]['id'] if d else '')")

PDNS_IP="${VMTEST_DNS_IP:-}"
PDNS_KEY="${VMTEST_PDNS_API_KEY:-}"

# ── fixture: a tenant + a PRIMARY-mode domain ─────────────────────────────────
SUFFIX="$(date +%s | tail -c 6)$RANDOM"
TENANT_NAME="dnse2e-${SUFFIX}"
# The zone lives UNDER the run's apex so the tier's resolver actually delegates
# to PowerDNS: net-services' dnsmasq forwards only `/<apex>/` to it (everything
# else goes upstream), so an arbitrary `.test` zone would exist in PowerDNS and
# still not resolve — which says nothing about the platform. A leaf name nothing
# else uses, torn down at exit.
ZONE="dnse2e${SUFFIX}.${VMTEST_APEX:-test}"
TENANT_ID=""; DOMAIN_ID=""

cleanup() {
  [[ -n "$DOMAIN_ID" && -n "$TENANT_ID" ]] && api DELETE "/tenants/${TENANT_ID}/domains/${DOMAIN_ID}" >/dev/null 2>&1
  [[ -n "$TENANT_ID" ]] && api DELETE "/tenants/${TENANT_ID}" >/dev/null 2>&1
  # The zone itself lives in the throw-away run's PowerDNS; drop it anyway so a
  # re-run against a retained cluster starts clean.
  [[ -n "$PDNS_IP" && -n "$PDNS_KEY" ]] && curl -s --max-time 10 -X DELETE \
      -H "X-API-Key: ${PDNS_KEY}" "http://${PDNS_IP}:8081/api/v1/servers/localhost/zones/${ZONE}." >/dev/null 2>&1
  return 0
}
trap cleanup EXIT INT TERM

PLAN_ID=$(body_of "$(api GET '/plans?limit=20')" | jqp "d=json.load(sys.stdin).get('data') or [];print(d[0]['id'] if d else '')")
REGION_ID=$(body_of "$(api GET '/regions?limit=20')" | jqp "d=json.load(sys.stdin).get('data') or [];print(d[0]['id'] if d else '')")
[[ -n "$PLAN_ID" && -n "$REGION_ID" ]] || { echo "dns-records-e2e: no plan/region to attach a tenant to" >&2; exit 1; }

R=$(api POST /tenants "{\"name\":\"${TENANT_NAME}\",\"primary_email\":\"${TENANT_NAME}@example.test\",\"plan_id\":\"${PLAN_ID}\",\"region_id\":\"${REGION_ID}\"}")
TENANT_ID=$(body_of "$R" | jqp "print((json.load(sys.stdin).get('data') or {}).get('id',''))")
[[ -n "$TENANT_ID" ]] || { echo "dns-records-e2e: tenant create failed: $(body_of "$R" | head -c 300)" >&2; exit 1; }
info "tenant ${TENANT_NAME} (${TENANT_ID})"

# Tenants are created pending+unprovisioned; domain routes reject with
# TENANT_NOT_ACTIVE until provisioning completes.
info "provisioning tenant (namespace + storage)…"
api POST "/admin/tenants/${TENANT_ID}/provision" "{}" >/dev/null 2>&1 || true
ACTIVE=""
for _ in $(seq 1 60); do
  ST=$(body_of "$(api GET "/tenants/${TENANT_ID}")" | jqp "print((json.load(sys.stdin).get('data') or {}).get('status',''))")
  [[ "$ST" == "active" ]] && { ACTIVE=1; break; }
  sleep 5
done
[[ -n "$ACTIVE" ]] || { echo "dns-records-e2e: tenant did not reach active in 300s (last status: ${ST:-?})" >&2; exit 1; }
info "tenant active"

R=$(api POST "/tenants/${TENANT_ID}/domains" \
    "{\"domain_name\":\"${ZONE}\",\"dns_mode\":\"primary\"$( [[ -n "$GROUP_ID" ]] && printf ',"dns_group_id":"%s"' "$GROUP_ID" )}")
DOMAIN_ID=$(body_of "$R" | jqp "print((json.load(sys.stdin).get('data') or {}).get('id',''))")
[[ -n "$DOMAIN_ID" ]] || { echo "dns-records-e2e: domain create failed: $(body_of "$R" | head -c 300)" >&2; exit 1; }
info "domain ${ZONE} (${DOMAIN_ID}) in primary mode"

# ── 6. ACME gate: an UNVERIFIED domain must not have a Certificate ────────────
# Checked FIRST, before anything verifies the domain. Doomed orders burn the
# account-wide Let's Encrypt limits every domain on the platform shares.
DSTATUS=$(body_of "$(api GET "/tenants/${TENANT_ID}/domains/${DOMAIN_ID}")" | jqp "print((json.load(sys.stdin).get('data') or {}).get('status',''))")
if [[ "$DSTATUS" == "verified" || "$DSTATUS" == "active" ]]; then
  info "domain already ${DSTATUS} — ACME-gate assertion not applicable"
else
  CERTS=$(body_of "$(api GET "/tenants/${TENANT_ID}/domains/${DOMAIN_ID}/certificates")" 2>/dev/null | head -c 400)
  if grep -qiE '"(issuing|issued|failed)"' <<<"${CERTS:-}"; then
    fail "ACME gate: an order was started for a '${DSTATUS}' domain"
  else
    pass "ACME gate: no certificate ordered while the domain is '${DSTATUS}'"
  fi
fi

# ── 1-3. every record type the tenant UI offers ───────────────────────────────
# name | type | value | extra-json | expected wire content | dig type
RECORDS=(
  "www|A|203.0.113.10||203.0.113.10|A"
  "www6|AAAA|2001:db8::1||2001:db8::1|AAAA"
  "blog|CNAME|ingress.${ZONE}||ingress.${ZONE}.|CNAME"
  "@|MX|mail.${ZONE}|\"priority\":10|10 mail.${ZONE}.|MX"
  "@|TXT|v=spf1 mx ~all||\"v=spf1 mx ~all\"|TXT"
  "_sip._tcp|SRV|sip.${ZONE}|\"priority\":10,\"weight\":5,\"port\":5060|10 5 5060 sip.${ZONE}.|SRV"
  "@|CAA|0 issue \\\"letsencrypt.org\\\"||0 issue \"letsencrypt.org\"|CAA"
  # dig type "-" = do not probe resolution. An NS record BELOW the apex is a
  # DELEGATION: the server answers with a referral (authority section), not an
  # answer section, so `dig +short` correctly prints nothing when the delegated
  # nameserver is unreachable — which it is, by design. Creation + readback
  # still assert the record itself.
  "sub|NS|ns1.other.test||ns1.other.test.|-"
)

for spec in "${RECORDS[@]}"; do
  IFS='|' read -r rname rtype rvalue rextra rexpect rdig <<<"$spec"
  body="{\"record_type\":\"${rtype}\",\"record_value\":\"${rvalue}\",\"ttl\":3600"
  [[ "$rname" != "@" ]] && body="${body},\"record_name\":\"${rname}\""
  [[ -n "$rextra" ]] && body="${body},${rextra}"
  body="${body}}"

  R=$(api POST "/tenants/${TENANT_ID}/domains/${DOMAIN_ID}/dns-records" "$body")
  code=$(code_of "$R")
  if [[ "$code" != "201" ]]; then
    fail "${rtype} ${rname}: API returned ${code} — $(body_of "$R" | head -c 200)"
    continue
  fi

  # (2) read it back FROM THE DNS SERVER — the only proof that matters.
  if [[ -n "$PDNS_IP" && -n "$PDNS_KEY" ]]; then
    fqdn="${ZONE}."; [[ "$rname" != "@" ]] && fqdn="${rname}.${ZONE}."
    got=$(curl -s --max-time 15 -H "X-API-Key: ${PDNS_KEY}" \
          "http://${PDNS_IP}:8081/api/v1/servers/localhost/zones/${ZONE}." \
          | NAME="$fqdn" TYPE="$rtype" jqp "
import os
z=json.load(sys.stdin)
out=[r['content'] for s in z.get('rrsets',[])
     if s['name']==os.environ['NAME'] and s['type']==os.environ['TYPE']
     for r in s.get('records',[])]
print('|'.join(out))")
    if [[ "$got" == *"$rexpect"* ]]; then
      pass "${rtype} ${rname} → ${rexpect}"
    else
      fail "${rtype} ${rname}: API said 201 but PowerDNS holds '${got:-<nothing>}' (want '${rexpect}')"
      continue
    fi

    # no record may land at <apex>.<apex>. — the mail-record regression
    dbl=$(curl -s --max-time 15 -H "X-API-Key: ${PDNS_KEY}" \
          "http://${PDNS_IP}:8081/api/v1/servers/localhost/zones/${ZONE}." \
          | ZONE="$ZONE" jqp "
import os
z=json.load(sys.stdin); Z=os.environ['ZONE']
print(sum(1 for s in z.get('rrsets',[]) if f'{Z}.{Z}' in s['name']))")
    [[ "${dbl:-0}" == "0" ]] || fail "records landed at a doubled name (<apex>.<apex>.)"
  fi

  # (3) and it must actually RESOLVE.
  if [[ "$rdig" != "-" && -n "$PDNS_IP" ]] && command -v dig >/dev/null 2>&1; then
    qname="${ZONE}"; [[ "$rname" != "@" ]] && qname="${rname}.${ZONE}"
    # @PDNS_IP is the services VM's dnsmasq (:53), which forwards /<apex>/ to
    # PowerDNS on 127.0.0.1#5300 — the same path a delegated resolver takes.
    ans=$(dig +short +time=3 +tries=2 "@${PDNS_IP}" "$rdig" "$qname" 2>/dev/null | tr '\n' ' ')
    [[ -n "${ans// /}" ]] && pass "${rtype} ${qname} resolves (${ans%% })" \
                          || fail "${rtype} ${qname} does not resolve"
  fi
done

# ── 5. a record the server would reject must NOT be persisted ─────────────────
# MX with no priority is the exact shape the panel used to send.
R=$(api POST "/tenants/${TENANT_ID}/domains/${DOMAIN_ID}/dns-records" \
    "{\"record_type\":\"MX\",\"record_name\":\"nope\",\"record_value\":\"mail.${ZONE}\",\"ttl\":3600}")
code=$(code_of "$R")
if [[ "$code" == "201" ]]; then
  fail "an MX with no priority was accepted (${code}) — the API is lying again"
else
  pass "MX without a priority is refused (HTTP ${code}), not silently persisted"
  LEFT=$(body_of "$(api GET "/tenants/${TENANT_ID}/domains/${DOMAIN_ID}/dns-records")" \
         | jqp "d=json.load(sys.stdin).get('data') or [];print(sum(1 for r in d if r.get('recordName')=='nope'))")
  [[ "${LEFT:-0}" == "0" ]] && pass "and no local row was left behind" \
                            || fail "a local row survived a rejected write"
fi

# ── 4. Sync Records must report the zone in sync ──────────────────────────────
DIFF=$(body_of "$(api GET "/tenants/${TENANT_ID}/domains/${DOMAIN_ID}/dns-records/diff")")
SUMMARY=$(printf '%s' "$DIFF" | jqp "
d=json.load(sys.stdin).get('data') or []
from collections import Counter
c=Counter(e['status'] for e in d)
print(' '.join(f'{k}={v}' for k,v in sorted(c.items())) or 'empty')
")
BAD=$(printf '%s' "$DIFF" | jqp "
d=json.load(sys.stdin).get('data') or []
print(sum(1 for e in d if e['status'] in ('conflict','local_only','remote_only')))")
if [[ "${BAD:-1}" == "0" ]]; then
  pass "Sync Records: zone fully in sync (${SUMMARY})"
else
  fail "Sync Records still reports differences: ${SUMMARY}"
  printf '%s' "$DIFF" | jqp "
d=json.load(sys.stdin).get('data') or []
[print('        ', e['status'], e['type'], e['name'], '| local:', (e.get('local') or {}).get('value'), '| remote:', (e.get('remote') or {}).get('value'))
 for e in d if e['status']!='in_sync']" | head -12
fi

echo
echo "integration-dns-records-e2e: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
