#!/usr/bin/env bash
# integration-master-user-rotation.sh
#
# End-to-end verification of the Stalwart webmail master-user rotation
# flow on a real cluster (default: staging1.example.test). Covers the
# domain-scoped lookup, auto-reseed when the principal is missing, and
# the 2026-06-25 decouple: the master now lives on the FIXED sentinel
# Domain `local.host` (mail-domain-INDEPENDENT) — NOT `mail.<apex>`.
#
# REQUIRES the sentinel-aware backend (the local.host decouple). On a
# cluster still running pre-sentinel code, §3 (rotation succeeds) returns
# 409 WEBMAIL_MASTER_DOMAIN_MISMATCH because that code's guard still
# expects `mail.<apex>`. Migrate first: `platform-ops mail rotate-master`.
#
# Usage:
#   HOST=root@staging1.example.test \
#     PLATFORM_APEX=staging.example.test \
#     SSH_KEY=~/hosting-platform.key \
#     scripts/integration-master-user-rotation.sh
#
# Exit code 0 = all checks pass. Each assertion logs `ok:` or `fail:`
# followed by a brief description.
set -euo pipefail

# Node SSH target + platform apex. In a full integration-all run the operator's
# profile exports SSH_HOST (real node) and PLATFORM_DOMAIN (real apex); honor them
# before the redacted public placeholder so the suite isn't left SSHing to the
# unresolvable example.test default (the 2026-07-18 full-run rc=255 failure).
HOST="${HOST:-${SSH_HOST:-root@staging1.example.test}}"
PLATFORM_APEX="${PLATFORM_APEX:-${PLATFORM_DOMAIN:-${PLATFORM_BASE_DOMAIN:-staging.example.test}}}"
# Public admin API base. Env-overridable for non-staging clusters (the old
# `https://staging.${PLATFORM_APEX#staging.}` construction was staging-only).
ADMIN_HOST="${ADMIN_HOST:-https://admin.${PLATFORM_APEX}}"
SSH_KEY="${SSH_KEY:-${HOME}/hosting-platform.key}"

# The master is pinned to the fixed sentinel Domain (decoupled from the
# mail domain, 2026-06-25) — keep in sync with MASTER_SENTINEL_DOMAIN in
# backend/src/modules/mail-admin/stalwart-master-user.ts.
MASTER_SENTINEL_DOMAIN="${MASTER_SENTINEL_DOMAIN:-local.host}"
EXPECTED_DOMAIN="$MASTER_SENTINEL_DOMAIN"
EXPECTED_FQDN="master@${EXPECTED_DOMAIN}"
echo "INFO: expected master domain = $EXPECTED_DOMAIN (fixed sentinel)"

declare -i ok=0 failed=0

s() {
  ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o LogLevel=ERROR "$HOST" "$@"
}

assert_eq() {
  local name="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    echo "ok:    $name"
    (( ok+=1 ))
  else
    echo "fail:  $name"
    echo "       want='$want'"
    echo "       got='$got'"
    (( failed+=1 ))
  fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF -- "$needle"; then
    echo "ok:    $name"
    (( ok+=1 ))
  else
    echo "fail:  $name (no match for '$needle')"
    (( failed+=1 ))
  fi
}

echo "=== §1: mail-secrets shape (post-bootstrap, post-restamp) ==="
master_user_b64=$(s "kubectl -n mail get secret mail-secrets -o jsonpath='{.data.STALWART_MASTER_USER}'" || true)
master_user=$(echo "$master_user_b64" | base64 -d 2>/dev/null || true)
assert_eq "STALWART_MASTER_USER == master@<sentinel>" "$EXPECTED_FQDN" "$master_user"

echo
echo "=== §2: route handler refuses rotation when Secret domain doesn't match ==="
# Simulate Secret tampering by stamping a bogus domain and confirming
# the route returns 409 WEBMAIL_MASTER_DOMAIN_MISMATCH (never proceeds to
# create a principal under the bogus Domain).
admin_pw=$(s "kubectl -n mail get secret stalwart-admin-creds -o jsonpath='{.data.recoveryPassword}'" | base64 -d)
# Capture original FQDN so we can restore.
ORIG_FQDN="$master_user"
TAMPERED_FQDN="master@evil-tenant.example.invalid"
echo "  tampering Secret: $ORIG_FQDN -> $TAMPERED_FQDN"
s "kubectl -n mail patch secret mail-secrets --type=json -p='[{\"op\":\"replace\",\"path\":\"/data/STALWART_MASTER_USER\",\"value\":\"$(echo -n "$TAMPERED_FQDN" | base64)\"}]' >/dev/null"

# Allow cache TTL to expire in case readStalwartMasterUser cached the
# value during a prior request. 5 min TTL would be too long for a test
# run, but a platform-api restart clears the cache instantly.
# Flush the master-user cache by DELETING the platform-api pods — the ReplicaSet
# recreates them from the current template. NEVER `kubectl rollout restart` on a
# Flux-managed cluster: Flux treats the restart annotation as drift and scales the
# new ReplicaSet back to 0 (CLAUDE.md golden rule).
recreate_platform_api() {
  # `rollout status` ALONE is not a real readiness gate here: `delete pod` doesn't
  # bump the Deployment generation, so it can return immediately from STALE status
  # while old (stale-cache) replicas still serve the Service — the rotate POST then
  # lands on a stale/not-ready pod (the rc.32 §2/§3 false-fail on 2 replicas). Wait
  # for the old pods to actually go, then for the new ones to be Ready + endpoints
  # to settle.
  s "kubectl -n platform delete pod -l app=platform-api --wait=true >/dev/null 2>&1 || true"
  sleep 5   # let the ReplicaSet create replacement pods before waiting on Ready
  s "kubectl -n platform rollout status deploy/platform-api --timeout=180s >/dev/null 2>&1 || true"
  s "kubectl -n platform wait --for=condition=Ready pod -l app=platform-api --timeout=180s >/dev/null 2>&1 || true"
  sleep 3   # brief settle for Service endpoints to converge to the fresh pods
}

# Retry the rotate POST: right after a recreate the request can still hit a
# not-yet-ready replica (empty body / gateway HTML). A JSON body (the mismatch
# error OR success) is authoritative and returned immediately; only an empty or
# HTML/gateway body retries, up to 5×.
rotate_master() {
  local token="$1" out="" n=0
  while :; do
    n=$((n+1))
    # MUST send a body: Content-Type: application/json with an EMPTY body makes
    # Fastify reject the request with FST_ERR_CTP_EMPTY_JSON_BODY (400) before the
    # handler runs — a well-formed JSON 400 that contains neither
    # WEBMAIL_MASTER_DOMAIN_MISMATCH nor rotatedAt, so §2/§3 failed with "no match".
    # (Same Fastify gotcha as DELETE-with-Content-Type; the endpoint takes no input
    # so `{}` satisfies the parser. Latent until this suite went default-on.)
    out=$(s "curl -sk -X POST '${ADMIN_HOST}/api/v1/admin/mail/rotate-webmail-master-password' \
      -H 'Authorization: Bearer $token' -H 'Content-Type: application/json' -d '{}'" || true)
    if [[ -n "$out" ]] && ! printf '%s' "$out" | grep -qiE '<html|<center>|502 Bad|503 Service|504 Gateway'; then
      printf '%s' "$out"; return 0
    fi
    (( n >= 5 )) && { printf '%s' "$out"; return 0; }
    sleep 5
  done
}

echo "  recreating platform-api pods to flush master-user cache"
recreate_platform_api

# Acquire an admin JWT (mail-admin routes are Bearer-only — no cookie fallback).
admin_email="${ADMIN_EMAIL:-admin@${PLATFORM_APEX}}"
admin_password="${ADMIN_PASSWORD:-$(s "kubectl -n platform get secret platform-admin-bootstrap -o jsonpath='{.data.password}' 2>/dev/null" | base64 -d 2>/dev/null || true)}"
if [[ -z "$admin_password" ]]; then
  echo "fail:  cannot resolve admin password (set ADMIN_PASSWORD or seed platform-admin-bootstrap)"
  (( failed+=1 ))
else
  # mail-admin routes use `authenticate` (Bearer-only, NO cookie fallback) —
  # capture the JWT from login and send it as a Bearer token.
  login_out=$(s "curl -sk -X POST '${ADMIN_HOST}/api/v1/auth/login' \
    -H 'Content-Type: application/json' \
    -d '{\"email\":\"$admin_email\",\"password\":\"$admin_password\"}'" || true)
  TOKEN=$(printf '%s' "$login_out" | sed -nE 's/.*"token":"([^"]+)".*/\1/p' | head -1)
  login_status=$([ -n "$TOKEN" ] && echo 200 || echo no-token)
  if [[ -z "$TOKEN" ]]; then
    echo "fail:  admin login did not return a token — skipping route-level checks"
    (( failed+=1 ))
  else
    echo "  admin login OK"
    rotate_resp=$(rotate_master "$TOKEN")
    assert_contains "tampered Secret -> rotation rejected with WEBMAIL_MASTER_DOMAIN_MISMATCH" \
      "WEBMAIL_MASTER_DOMAIN_MISMATCH" "$rotate_resp"
  fi
fi

echo
echo "  restoring Secret to original FQDN"
s "kubectl -n mail patch secret mail-secrets --type=json -p='[{\"op\":\"replace\",\"path\":\"/data/STALWART_MASTER_USER\",\"value\":\"$(echo -n "$ORIG_FQDN" | base64)\"}]' >/dev/null"
recreate_platform_api   # Flux-safe restart (never rollout-restart)

echo
echo "=== §3: rotation succeeds with valid Secret ==="
if [[ -n "$admin_password" ]] && [[ "$login_status" == "200" ]]; then
  # Re-login (the JWT is invalidated by the platform-api pod restart above).
  login_out2=$(s "curl -sk -X POST '${ADMIN_HOST}/api/v1/auth/login' \
    -H 'Content-Type: application/json' \
    -d '{\"email\":\"$admin_email\",\"password\":\"$admin_password\"}'" || true)
  TOKEN2=$(printf '%s' "$login_out2" | sed -nE 's/.*"token":"([^"]+)".*/\1/p' | head -1)
  if [[ -n "$TOKEN2" ]]; then
    rotate_ok=$(rotate_master "$TOKEN2")
    assert_contains "valid Secret -> rotation succeeded (response contains rotatedAt)" \
      "rotatedAt" "$rotate_ok"
    # §4 (Stalwart-side master verification) is DEFERRED, not fake-fixed: it uses a
    # hard-coded Stalwart accountId 'd333333' (an x:Account/get on a fixed id is
    # fragile — the id isn't resolved) against the internal stalwart-mgmt:8080. The
    # credential ($admin_pw = stalwart-admin-creds.recoveryPassword, line ~80) is
    # fine. The authoritative platform-side contract is covered by §2 (mismatch
    # reject) + §3 (rotatedAt). Rework §4 to resolve the master principal id (not a
    # hard-coded one) before asserting it, when wiring the suite.
    echo "  §4 Stalwart-side master verification: skipped (advisory; see registry note)"
  fi
fi

echo
echo "=== summary ==="
echo "  ok:    $ok"
echo "  fail:  $failed"
if (( failed > 0 )); then exit 1; fi
exit 0
