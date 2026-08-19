#!/usr/bin/env bash
# setup-dns-provider.sh — register the run's PowerDNS as a platform DNS provider
# BEFORE the suites run.
#
# The services VM (net-services.sh) already runs a real PowerDNS, but the harness
# only ever talked to it DIRECTLY (seed_apex_dns POSTs to its API) — the platform
# itself had no `dns_servers` row, so `canManageDnsZone()` was false for every
# domain and the platform's entire DNS write path was dead code on this tier.
#
# That is exactly the path that was broken in production: MX, SRV and CAA records
# were rejected by PowerDNS while the API answered 201 Created, and every mail
# record was published to `<apex>.<apex>.`. Nothing on any tier would have caught
# it, because nothing drove the platform's own record API against a real server.
#
# Same shape as setup-backup-targets.sh: the services VM provides the thing, this
# binds it to the cluster. Idempotent — reuses a server/group with our name.
# Non-fatal by default so a DNS-plane hiccup cannot block the whole run; the
# dns-records suite then fails its own precondition and says so.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${ADMIN_HOST:?ADMIN_HOST unset}"
: "${VMTEST_DNS_IP:?VMTEST_DNS_IP unset — net-services did not emit it}"
: "${VMTEST_PDNS_API_KEY:?VMTEST_PDNS_API_KEY unset — net-services did not emit it}"

CURL_OPTS=(-s); [[ "${CURL_INSECURE:-}" == "1" ]] && CURL_OPTS+=(-k)
SERVER_NAME="vmtier-services-powerdns"
GROUP_NAME="vmtier-services-group"
APEX="${VMTEST_APEX:-${APEX:-}}"

# The apex NS set. PowerDNS refuses a zone with no nameservers (a zone whose NS
# records point at names that do not exist is a lame delegation), and the
# provider group is where that set comes from.
NS_HOSTNAMES="${VMTEST_DNS_NS_HOSTNAMES:-ns1.${APEX} ns2.${APEX}}"

# Token: reuse the cached integration token if present, else log in (same path as
# the suites) — see integration-token.sh for why this is shared.
TOKEN="${INTEGRATION_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HERE/../integration-token.sh" ]]; then
  # shellcheck source=/dev/null
  source "$HERE/../integration-token.sh" 2>/dev/null && TOKEN="$(get_admin_token 2>/dev/null || true)"
fi
if [[ -z "$TOKEN" ]]; then
  TOKEN=$(curl "${CURL_OPTS[@]}" -X POST "$ADMIN_HOST/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"${ADMIN_EMAIL:-admin@example.test}\",\"password\":\"${ADMIN_PASSWORD:-}\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("token",""))' 2>/dev/null)
fi
[[ -n "$TOKEN" ]] || { echo "  WARN: dns-provider setup could not obtain an admin token — skipping" >&2; exit 0; }

api() { # api <method> <path> [json-body]
  local m="$1" p="$2" b="${3:-}"
  if [[ -n "$b" ]]; then
    curl "${CURL_OPTS[@]}" -X "$m" "$ADMIN_HOST/api/v1$p" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary "$b"
  else
    curl "${CURL_OPTS[@]}" -X "$m" "$ADMIN_HOST/api/v1$p" -H "Authorization: Bearer $TOKEN"
  fi
}

jqp() { python3 -c "import json,sys;$1" 2>/dev/null; }

# ── 1. provider group (carries the apex NS set) ───────────────────────────────
GROUP_ID=$(api GET /admin/dns-provider-groups | jqp "
d=json.load(sys.stdin).get('data') or []
print(next((g['id'] for g in d if g.get('name')=='${GROUP_NAME}'), ''))")

if [[ -z "$GROUP_ID" ]]; then
  NS_JSON=$(NS="$NS_HOSTNAMES" python3 -c 'import json,os;print(json.dumps(os.environ["NS"].split()))')
  GROUP_ID=$(api POST /admin/dns-provider-groups \
    "{\"name\":\"${GROUP_NAME}\",\"is_default\":true,\"ns_hostnames\":${NS_JSON}}" \
    | jqp "print((json.load(sys.stdin).get('data') or {}).get('id',''))")
fi
[[ -n "$GROUP_ID" ]] || { echo "  WARN: could not create DNS provider group — skipping" >&2; exit 0; }
echo "  dns provider group: ${GROUP_NAME} (${GROUP_ID}), ns=${NS_HOSTNAMES}"

# ── 2. the PowerDNS server itself ─────────────────────────────────────────────
# PowerDNS listens on the services VM: DNS on :53 (dnsmasq forwards), API on :8081.
SERVER_ID=$(api GET /admin/dns-servers | jqp "
d=json.load(sys.stdin).get('data') or []
print(next((s['id'] for s in d if s.get('displayName')=='${SERVER_NAME}' or s.get('display_name')=='${SERVER_NAME}'), ''))")

if [[ -z "$SERVER_ID" ]]; then
  BODY=$(API_URL="http://${VMTEST_DNS_IP}:8081" KEY="${VMTEST_PDNS_API_KEY}" \
         NAME="${SERVER_NAME}" GID="${GROUP_ID}" python3 -c '
import json, os
print(json.dumps({
  "display_name": os.environ["NAME"],
  "provider_type": "powerdns",
  "connection_config": {
    "api_url": os.environ["API_URL"],
    "api_key": os.environ["KEY"],
    "server_id": "localhost",
    "api_version": "v4",
  },
  # Native: this run has a single authoritative server, no AXFR peers.
  "zone_default_kind": "Native",
  "is_default": True,
  "enabled": True,
  "group_id": os.environ["GID"],
  # canManageDnsZone() requires an ENABLED server with role=primary — without
  # this the platform silently skips every record write as "not authoritative".
  "role": "primary",
}))')
  SERVER_ID=$(api POST /admin/dns-servers "$BODY" | jqp "print((json.load(sys.stdin).get('data') or {}).get('id',''))")
fi
[[ -n "$SERVER_ID" ]] || { echo "  WARN: could not register the PowerDNS server — skipping" >&2; exit 0; }
echo "  dns server: ${SERVER_NAME} (${SERVER_ID}) → http://${VMTEST_DNS_IP}:8081"

# ── 3. prove the platform can actually reach it ───────────────────────────────
# A registered-but-unreachable server would let every suite below fail with a
# confusing per-record error instead of one clear precondition failure.
TEST=$(api POST "/admin/dns-servers/${SERVER_ID}/test" | jqp "
d=json.load(sys.stdin).get('data') or {}
print(d.get('status','?'), d.get('version') or d.get('message') or '')")
echo "  connection test: ${TEST}"
case "$TEST" in
  ok*) ;;
  *) echo "  WARN: platform cannot reach the run's PowerDNS (${TEST}) — dns suites will fail their precondition" >&2 ;;
esac
