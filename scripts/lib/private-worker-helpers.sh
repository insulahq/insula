#!/usr/bin/env bash
# Shared helpers for the private-worker E2E harnesses.
#
# Sourced by:
#   scripts/integration-private-worker.sh   (full staging E2E)
#   scripts/local-private-worker-sample.sh  (Unraid+DinD dev iteration)
#
# Conventions match scripts/integration-staging.sh:
#   - log/ok/fail color helpers + PASSED/FAILED counters
#   - api()           POSTs/GETs against $ADMIN_HOST/api/v1 with bearer $TOKEN
#   - wait_for()      polls a command for an expected pattern with timeout
#   - ssh_cp()        runs kubectl on the cluster via SSH (or in-place when
#                     the harness runs on the control host itself)
#
# This file is intentionally side-effect free at source-time: it only
# defines functions and ANSI color constants. Counters (PASSED/FAILED)
# are initialised in the caller so each scenario filter starts fresh.

# ─── ANSI / pretty printing ───────────────────────────────────────────

if [[ -z "${PW_HELPERS_COLORS_INIT:-}" ]]; then
  PW_CYAN='\033[36m'
  PW_GREEN='\033[32m'
  PW_RED='\033[31m'
  PW_YELLOW='\033[33m'
  PW_RESET='\033[0m'
  PW_HELPERS_COLORS_INIT=1
fi

log()  { printf '%b[%s]%b %s\n' "$PW_CYAN" "$(date +%H:%M:%S)" "$PW_RESET" "$*"; }
ok()   { printf '  %b✓%b %s\n' "$PW_GREEN" "$PW_RESET" "$*"; PASSED=$((PASSED+1)); }
fail() { printf '  %b✗%b %s\n' "$PW_RED" "$PW_RESET" "$*"; FAILURES+=("$*"); FAILED=$((FAILED+1)); }
warn() { printf '  %b!%b %s\n' "$PW_YELLOW" "$PW_RESET" "$*"; }

# ─── HTTP / API ───────────────────────────────────────────────────────

# login_token <admin_host> <email> <password>  → prints JWT on stdout
login_token() {
  local host="$1" email="$2" password="$3"
  curl -sk --max-time 30 -X POST "$host/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" \
    | jq -r '.data.token // empty'
}

# api <METHOD> <PATH> [BODY]
# Requires globals: ADMIN_HOST, TOKEN.
# --retry absorbs transient errors after platform-api pod replacements.
api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -z "$body" ]]; then
    curl -sk --max-time 60 --retry 2 --retry-all-errors --retry-delay 2 \
      -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN"
  else
    curl -sk --max-time 60 --retry 2 --retry-all-errors --retry-delay 2 \
      -X "$method" "$ADMIN_HOST/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body"
  fi
}

# ─── SSH / kubectl probe ──────────────────────────────────────────────

# ssh_cp <command...>
# Runs the command on the cluster control host. When the harness runs on
# the control host itself (kubectl on PATH and SSH key absent), executes
# the command locally instead. Mirrors integration-staging.sh.
#
# Requires globals: SSH_KEY, SSH_OPTS, CONTROL_HOST.
ssh_cp() {
  if [[ ! -r "$SSH_KEY" ]] && command -v kubectl >/dev/null 2>&1; then
    bash -c "$*"
    return
  fi
  # shellcheck disable=SC2086
  ssh -i "$SSH_KEY" $SSH_OPTS "root@$CONTROL_HOST" "$@"
}

# ─── polling helpers ──────────────────────────────────────────────────

# wait_for <timeout_seconds> <description> <expected_regex> <command> [fail_regex]
# Re-runs <command> every 4s until its stdout matches <expected_regex>.
# Calls ok() on success / fail() on timeout. Returns 0/1 accordingly.
# Optional [fail_regex]: if the command's stdout matches it, ABORT the wait
# IMMEDIATELY as a terminal failure (return 2) instead of burning the whole
# timeout — e.g. 'CrashLoopBackOff|Error|ReplicaFailure' so a pod that has
# clearly died fails the test at second 4, not second 300. Backward
# compatible: omit it and behaviour is unchanged.
wait_for() {
  local timeout="$1" desc="$2" expect="$3" cmd="$4" fail_rx="${5:-}"
  local i=0 out
  while (( i < timeout )); do
    out=$(eval "$cmd" 2>/dev/null)
    if grep -qE "$expect" <<<"$out"; then
      ok "$desc (after ${i}s)"
      return 0
    fi
    if [[ -n "$fail_rx" ]] && grep -qE "$fail_rx" <<<"$out"; then
      fail "$desc — TERMINAL failure after ${i}s (matched /$fail_rx/)"
      return 2
    fi
    sleep 4
    i=$((i + 4))
  done
  fail "$desc — timeout after ${timeout}s waiting for /$expect/"
  return 1
}

# wait_for_http <timeout_seconds> <url> <expected_status> [fail_status_regex]
# Polls curl every 5s until the HTTP status matches. Honours -k for
# self-signed certs during cert issuance windows. Optional [fail_status_regex]
# aborts early on a terminal status (e.g. '^4' to bail on any 4xx).
wait_for_http() {
  local timeout="$1" url="$2" expected="$3" fail_rx="${4:-}"
  local i=0
  local code
  while (( i < timeout )); do
    code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$url" 2>/dev/null || echo "000")
    if [[ "$code" == "$expected" ]]; then
      ok "GET $url returned HTTP $code (after ${i}s)"
      return 0
    fi
    if [[ -n "$fail_rx" && "$code" =~ $fail_rx ]]; then
      fail "GET $url returned HTTP $code (terminal, after ${i}s)"
      return 2
    fi
    sleep 5
    i=$((i + 5))
  done
  fail "GET $url did not reach HTTP $expected within ${timeout}s (last=$code)"
  return 1
}

# ─── docker fixtures ──────────────────────────────────────────────────

# pw_docker_cleanup
# Best-effort teardown of any local docker fixtures created by the harness.
# Safe to call multiple times (idempotent, swallows missing-resource errors).
pw_docker_cleanup() {
  local agent_name="${1:-pw-e2e-agent}"
  local echo_name="${2:-pw-e2e-echo}"
  local network_name="${3:-pw-e2e-net}"

  docker rm -f "$agent_name" >/dev/null 2>&1 || true
  docker rm -f "$echo_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}

# pw_render_marker  → echoes a unique marker string for round-trip assertions
pw_render_marker() {
  printf 'private-worker-e2e-marker-%s' "$(date +%s)"
}
