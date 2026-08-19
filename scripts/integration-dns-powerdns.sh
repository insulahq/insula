#!/usr/bin/env bash
# integration-dns-powerdns.sh — prove every DNS record type the tenant UI
# offers is actually accepted by a real PowerDNS.
#
# WHY THIS EXISTS
#   The mocked provider tests asserted the request body the adapter SENT.
#   They could not catch the real defect: PowerDNS REJECTED that body with a
#   422 that the sync layer swallowed while the API answered 201 Created.
#   MX, SRV and CAA records had never been written successfully, and every
#   mail record was published to `<apex>.<apex>.`. Only a live server can
#   tell us the difference between "we sent it" and "it exists".
#
# WHAT IT ASSERTS
#   Each type in the tenant panel's dropdown is created using ONLY inputs
#   that panel can produce (type / name / value / ttl, plus priority,
#   weight and port exactly where the form renders them), validated through
#   the real createDnsRecordSchema, then READ BACK from the server.
#
# USAGE
#   ./scripts/integration-dns-powerdns.sh
#   PDNS_API_URL=http://my-pdns:8081 ./scripts/integration-dns-powerdns.sh  # reuse a server
#
# ENV
#   PDNS_API_URL    reuse an existing PowerDNS instead of starting one
#   PDNS_API_KEY    default: probekey
#   PDNS_IMAGE      default: powerdns/pdns-auth-49:latest
#   PDNS_PORT       host port to publish (default: 18081)
#   PDNS_HOST       hostname the test process reaches the container on
#                   (default: 127.0.0.1; set to the docker host when the
#                   daemon is remote, e.g. DinD)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PDNS_API_KEY="${PDNS_API_KEY:-probekey}"
PDNS_IMAGE="${PDNS_IMAGE:-powerdns/pdns-auth-49:latest}"
PDNS_PORT="${PDNS_PORT:-18081}"
PDNS_HOST="${PDNS_HOST:-127.0.0.1}"
CONTAINER_NAME="insula-pdns-integration-$$"

STARTED_CONTAINER=0

cleanup() {
  if [ "${STARTED_CONTAINER}" = "1" ]; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

log()  { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# ── Bring up PowerDNS unless the caller supplied one ──────────────────────
if [ -z "${PDNS_API_URL:-}" ]; then
  command -v docker >/dev/null 2>&1 || fail "docker is required (or set PDNS_API_URL to an existing server)"

  log "starting PowerDNS (${PDNS_IMAGE})"
  docker run -d --name "${CONTAINER_NAME}" \
    -p "${PDNS_PORT}:8081" \
    "${PDNS_IMAGE}" \
    --webserver=yes --webserver-address=0.0.0.0 --webserver-allow-from=0.0.0.0/0 \
    --api=yes --api-key="${PDNS_API_KEY}" \
    --launch=gsqlite3 --gsqlite3-database=/var/lib/powerdns/pdns.sqlite3 \
    >/dev/null || fail "could not start ${PDNS_IMAGE}"
  STARTED_CONTAINER=1

  PDNS_API_URL="http://${PDNS_HOST}:${PDNS_PORT}"

  log "waiting for the API on ${PDNS_API_URL}"
  ready=0
  for _ in $(seq 1 30); do
    if curl -fsS -m 2 -H "X-API-Key: ${PDNS_API_KEY}" \
         "${PDNS_API_URL}/api/v1/servers/localhost" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  [ "${ready}" = "1" ] || {
    docker logs "${CONTAINER_NAME}" 2>&1 | tail -20 >&2
    fail "PowerDNS API never came up at ${PDNS_API_URL}"
  }
fi

log "running the live provider suite against ${PDNS_API_URL}"

VITEST="${REPO_ROOT}/node_modules/.bin/vitest"
[ -x "${VITEST}" ] || VITEST="${REPO_ROOT}/backend/node_modules/.bin/vitest"
[ -x "${VITEST}" ] || fail "vitest not found — run npm install first"

PDNS_API_URL="${PDNS_API_URL}" PDNS_API_KEY="${PDNS_API_KEY}" \
  "${VITEST}" run --reporter=dot \
  "${REPO_ROOT}/backend/src/modules/dns-servers/providers/powerdns.live.integration.test.ts" \
  || fail "live PowerDNS suite failed"

# A skipped suite must not read as a pass: describe.skipIf() silently drops
# every case when PDNS_API_URL is unset, which would make this script green
# while testing nothing at all.
PDNS_API_URL="${PDNS_API_URL}" PDNS_API_KEY="${PDNS_API_KEY}" \
  "${VITEST}" run --reporter=json --outputFile=/dev/stdout \
  "${REPO_ROOT}/backend/src/modules/dns-servers/providers/powerdns.live.integration.test.ts" 2>/dev/null \
  | grep -q '"numPassedTests":[1-9]' \
  || fail "the live suite ran zero tests — it was skipped, not passed"

log "PASS — every tenant-UI record type is accepted and read back by PowerDNS"
