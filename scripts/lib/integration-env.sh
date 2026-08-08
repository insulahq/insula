#!/usr/bin/env bash
# integration-env.sh — config profile + precondition helpers for the
# integration harnesses.
#
# WHY: the harnesses target a live cluster and some exercise external,
# confidential targets (off-site S3/backup endpoints, SMTP relays,
# third-party API tokens). None of that can live in a PUBLIC repo, and
# the suite must not bake one operator's infra (node IPs, apex domain)
# into committed defaults.
#
# This lib gives three things:
#   1. load_integration_env  — source a gitignored profile (scripts/integration.env
#                              or $INTEGRATION_ENV) BEFORE the script's
#                              `${VAR:-default}` lines, so the operator's real
#                              values win without ever touching git.
#   2. require_env           — hard-fail (exit 2) FAST when a mandatory var is
#                              unset, with a clear "set X (see integration.env.example)"
#                              message — instead of failing cryptically deep in a run.
#   3. require_or_skip       — when an OPTIONAL external target isn't configured,
#                              SKIP the suite (exit 77) instead of hard-failing or,
#                              worse, running against a placeholder. A public clone
#                              then runs everything that needs only the cluster and
#                              cleanly skips what needs the operator's private targets.
#
# Usage (put this near the TOP of a harness, before any `${VAR:-...}` defaults):
#
#   source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
#   load_integration_env
#   require_env ADMIN_PASSWORD                       # mandatory
#   require_or_skip "off-site backup round-trip" \   # optional/external
#       BACKUP_S3_ENDPOINT BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
#
# All functions are safe to call when the lib is sourced by the master
# runner (integration-all.sh) OR by a standalone sub-script.

# Exit code for "intentionally skipped" (autoconf convention, matched by
# integration-all.sh's classify_rc).
: "${INTEGRATION_SKIP_RC:=77}"

# load_integration_env — source the operator's gitignored profile if present.
# Search order (FIRST HIT WINS — later candidates are NOT consulted):
#   1. $INTEGRATION_ENV               (explicit override)
#   2. scripts/integration.env        (repo-local, gitignored)
#   3. ~/.config/insula/integration.env
# PRECEDENCE (read carefully): the chosen profile is sourced under `set -a`, so its
# assignments EXPORT and — for plain `VAR=value` lines — OVERRIDE whatever is already
# in the environment. That is deliberate: the operator's profile is meant to win over a
# harness's `${VAR:-default}`. But it also means a caller that has ALREADY exported the
# correct targets (e.g. the VM tier pointing at an ephemeral cluster) CANNOT rely on its
# exports surviving a repo-local integration.env full of plain assignments — that file
# would clobber them. Such a caller MUST set $INTEGRATION_ENV to its own profile so
# candidate #1 wins and #2/#3 are never reached (see scripts/vm-integration-tests/run.sh).
# ─── Platform apex resolution ────────────────────────────────────────────
#
# THE ONE PLACE the fallback test apex is written down. Everything else must
# derive from resolve_platform_apex / $PLATFORM_APEX.
#
# Why this exists: harnesses used to spell the fallback inline, e.g.
#   local mail_domain_apex="${MAIL_DOMAIN_APEX:-staging.example.test}"
# Some sites derived from the configured apex first and some did not — three
# such lines sat in ONE file next to two that were correct. The result is a
# suite that can only pass on the apex whose name happens to be baked in: on
# 2026-08-04 a run against a freshly bootstrapped cluster failed with
#   "banner 'mail.<cluster apex>' DOES NOT MATCH expected 'mail.staging.example.test'"
# even though mail was healthy. Each previous round fixed the line that failed
# that day rather than the class, so it kept coming back.
#
# Accepts every name the harnesses have historically used, most specific
# first, so an operator profile setting ANY of them works.
resolve_platform_apex() {
  printf '%s' "${MAIL_DOMAIN_APEX:-${PLATFORM_DOMAIN:-${PLATFORM_BASE_DOMAIN:-${HTTPS_TEST_DOMAIN_BASE:-${TENANT_BASE:-staging.example.test}}}}}"
}

# Exported by load_integration_env so a harness can use "$PLATFORM_APEX"
# directly. Call resolve_platform_apex yourself if you need it re-evaluated
# after mutating one of the inputs.
load_integration_env() {
  local script_dir candidate
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # scripts/
  for candidate in \
    "${INTEGRATION_ENV:-}" \
    "$script_dir/integration.env" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/insula/integration.env"; do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    # The profile provides DEFAULTS — it must never override what the CALLER
    # explicitly set.
    #
    # `set -a; source` is plain assignment, so a profile pinning
    # ADMIN_HOST/ADMIN_EMAIL silently replaced an explicitly exported target.
    # Running any suite with ADMIN_HOST=<dev cluster> therefore retargeted it at
    # whatever ~/.config/insula/integration.env names — with no warning. Hit
    # 2026-08-08: a suite launched against the DEV cluster logged in as
    # admin@staging.<apex> and began creating tenants on STAGING. Its cleanup
    # trap removed them, but pointing a test harness at a production-adjacent
    # cluster must not be one forgotten variable away.
    #
    # Snapshot the caller's exported environment, source the profile (so it can
    # still supply everything the caller omitted), then re-apply the snapshot so
    # explicit values win.
    # NB: rewrite `declare -x` to `export`. `declare` inside a function is
    # function-LOCAL in bash, so eval-ing export -p's own output here would
    # restore the values into this function's scope and leave the caller still
    # holding the profile's — which is exactly the bug this guards against.
    local _caller_env
    _caller_env="$(export -p 2>/dev/null | sed 's/^declare -x /export /' || true)"
    # Record which target-defining vars the CALLER already had, so a config
    # assembled from two sources is visible rather than silent. Caller-wins fixes
    # precedence; it cannot stop a PARTIAL caller set from being completed by the
    # profile into a config that names two different clusters.
    local _v _from_caller="" _from_profile=""
    for _v in ADMIN_HOST PLATFORM_API_URL ADMIN_EMAIL SSH_HOST KUBECTL \
              PLATFORM_DOMAIN MAIL_DOMAIN_APEX RESOLVE_IP HTTPS_TEST_DOMAIN_BASE; do
      [[ -n "${!_v:-}" ]] && _from_caller+=" $_v"
    done
    # shellcheck disable=SC1090
    set -a; source "$candidate"; set +a
    eval "$_caller_env" 2>/dev/null || true
    for _v in ADMIN_HOST PLATFORM_API_URL ADMIN_EMAIL SSH_HOST KUBECTL \
              PLATFORM_DOMAIN MAIL_DOMAIN_APEX RESOLVE_IP HTTPS_TEST_DOMAIN_BASE; do
      [[ -n "${!_v:-}" && " $_from_caller " != *" $_v "* ]] && _from_profile+=" $_v"
    done
    if [[ -n "$_from_caller" && -n "$_from_profile" ]]; then
      echo "integration-env: MIXED target config — caller set:${_from_caller}" >&2
      echo "integration-env:                       $candidate supplied:${_from_profile}" >&2
      echo "integration-env: assert_single_target will verify these name ONE cluster." >&2
    fi
    PLATFORM_APEX="$(resolve_platform_apex)"; export PLATFORM_APEX
    [[ -n "${INTEGRATION_ENV_VERBOSE:-}" ]] && echo "integration-env: loaded $candidate" >&2
    return 0
  done
  PLATFORM_APEX="$(resolve_platform_apex)"; export PLATFORM_APEX
  return 0  # no profile is fine — env vars / CI secrets may supply everything
}

# ─── Target identity guard ───────────────────────────────────────────────────
#
# WHY THIS EXISTS, AND WHY THE PRECEDENCE FIX ABOVE IS NOT ENOUGH.
#
# A harness gets its target from several INDEPENDENT variables: ADMIN_HOST /
# PLATFORM_API_URL decide who receives the HTTP calls, SSH_HOST / KUBECTL decide
# whose cluster gets kubectl'd, RESOLVE_IP / HTTPS_TEST_DOMAIN_BASE decide who
# gets probed. Nothing ties them together.
#
# The operator profile defines SOME of them. A caller exports SOME of them. Any
# precedence rule — profile-wins or caller-wins — still merges two partial sets
# into one config that names TWO DIFFERENT CLUSTERS. Observed 2026-08-08: a run
# sent its API traffic and kubectl to one cluster while mail/DNS probes went to
# another, and the only visible symptom was a pile of "cert does not cover …"
# assertions that read like a TLS bug. Worse, that run's destructive suites
# (a CNPG delete+recreate of the platform DB) executed against the wrong cluster.
#
# So do not try to police the variables. Ask the TARGET who it is, from BOTH
# sides, and refuse to continue if the answers disagree.
#
# The fingerprint is the SYSTEM tenant's UUID: exactly one row per cluster
# (tenants.is_system, partial unique index — ADR-040), stable for the cluster's
# life, reachable over HTTP and over kubectl, and needs no new endpoint.
#
#   INTEGRATION_SKIP_TARGET_ASSERT=1  bypass (offline/unit contexts)
#   INTEGRATION_TARGET_EXPECT=<uuid|apex-substring>
#                                     hard pin — refuse anything else. Use this
#                                     when running destructive suites by hand.

_target_fp_api() {
  local tok="${INTEGRATION_TOKEN:-${TOKEN:-${ADMIN_TOKEN:-}}}"
  [[ -n "${ADMIN_HOST:-}" ]] || return 0
  if [[ -z "$tok" ]]; then
    [[ -n "${ADMIN_EMAIL:-}" && -n "${ADMIN_PASSWORD:-}" ]] || return 0
    tok=$(ADMIN_EMAIL="$ADMIN_EMAIL" PW="$ADMIN_PASSWORD" python3 -c \
        "import json,os;print(json.dumps({'email':os.environ['ADMIN_EMAIL'],'password':os.environ['PW']}))" 2>/dev/null \
      | curl -sk --max-time 15 -X POST "$ADMIN_HOST/api/v1/auth/login" \
          -H 'Content-Type: application/json' --data-binary @- 2>/dev/null \
      | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('data') or {}).get('token','') or '')" 2>/dev/null) || return 0
  fi
  [[ -n "$tok" ]] || return 0
  curl -sk --max-time 15 "$ADMIN_HOST/api/v1/tenants?limit=100" -H "Authorization: Bearer $tok" 2>/dev/null \
    | python3 -c "
import json,sys
try: d=json.load(sys.stdin).get('data') or []
except Exception: sys.exit(0)
for t in d:
    if t.get('isSystem') or t.get('is_system'):
        print(t.get('id','')); break" 2>/dev/null
}

_target_fp_node() {
  local kc="${KUBECTL:-kubectl}" pod
  pod=$($kc -n platform get pods -l cnpg.io/cluster=system-db,role=primary \
        -o jsonpath='{.items[0].metadata.name}' 2>/dev/null | tr -d '\r')
  [[ -n "$pod" ]] || return 0
  $kc -n platform exec "$pod" -c postgres -- \
    psql -U postgres -d platform -tAc 'select id from tenants where is_system = true' 2>/dev/null \
    | tr -d '\r' | tr -d '[:space:]'
}

assert_single_target() {
  local label="${1:-run}" api node
  [[ "${INTEGRATION_SKIP_TARGET_ASSERT:-0}" == 1 ]] && return 0
  api="$(_target_fp_api  || true)"
  node="$(_target_fp_node || true)"

  if [[ -n "${INTEGRATION_TARGET_EXPECT:-}" ]]; then
    local seen="${api:-$node}"
    if [[ -n "$seen" && "$seen" != "$INTEGRATION_TARGET_EXPECT" \
       && "${ADMIN_HOST:-}" != *"$INTEGRATION_TARGET_EXPECT"* ]]; then
      echo "══ TARGET PIN VIOLATED ($label) ══" >&2
      echo "   expected : $INTEGRATION_TARGET_EXPECT" >&2
      echo "   resolved : $seen   (ADMIN_HOST=${ADMIN_HOST:-unset})" >&2
      exit 3
    fi
  fi

  # A proven mismatch is fatal. Being UNABLE to check is not — a suite may
  # legitimately have HTTP access without kubectl, or vice versa; refusing to run
  # then would just make the guard something people disable.
  if [[ -n "$api" && -n "$node" && "$api" != "$node" ]]; then
    echo "══ SPLIT TARGET — REFUSING TO RUN ($label) ══" >&2
    echo "   HTTP  ${ADMIN_HOST:-unset}" >&2
    echo "         → SYSTEM tenant $api" >&2
    echo "   KUBECTL/SSH ${SSH_HOST:-${KUBECTL:-unset}}" >&2
    echo "         → SYSTEM tenant $node" >&2
    echo "   These are TWO DIFFERENT CLUSTERS. The API calls and the kubectl/SSH" >&2
    echo "   probes would land in different places, and any destructive step would" >&2
    echo "   execute against whichever side it happens to use." >&2
    echo "   Set every target var from ONE source (INTEGRATION_ENV=<profile>, or" >&2
    echo "   export them all yourself)." >&2
    exit 3
  fi

  if [[ -n "$api$node" ]]; then
    INTEGRATION_TARGET_FP="${api:-$node}"; export INTEGRATION_TARGET_FP
    echo "integration-target: ${label} → ${ADMIN_HOST:-?} (cluster ${INTEGRATION_TARGET_FP}${api:+, HTTP+kubectl agree})" >&2
  else
    echo "integration-target: ${label} → ${ADMIN_HOST:-?} (identity NOT verifiable — no API token and no kubectl reach)" >&2
  fi
  return 0
}

# require_env VAR [VAR...] — exit 2 if any named var is unset/empty.
# Mandatory inputs the suite genuinely cannot run without (e.g. ADMIN_PASSWORD,
# the cluster SSH host). Fails in milliseconds, before any slow work.
require_env() {
  local missing=() v
  for v in "$@"; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
  done
  if (( ${#missing[@]} )); then
    {
      echo "ERROR: required environment variable(s) not set: ${missing[*]}"
      echo "       Set them in the environment or in scripts/integration.env"
      echo "       (copy scripts/integration.env.example and fill it in)."
    } >&2
    exit 2
  fi
}

# require_or_skip "human label" VAR [VAR...] — if any named var is unset, print
# a SKIP notice and exit $INTEGRATION_SKIP_RC (77). Use for OPTIONAL external /
# confidential targets so an unconfigured environment skips cleanly instead of
# failing or running against placeholder values.
require_or_skip() {
  local label="$1"; shift
  local missing=() v
  for v in "$@"; do
    [[ -n "${!v:-}" ]] || missing+=("$v")
  done
  if (( ${#missing[@]} )); then
    {
      echo "SKIP: '$label' needs ${missing[*]} — not configured in this environment."
      echo "      Provide them in scripts/integration.env to enable this suite."
    } >&2
    exit "${INTEGRATION_SKIP_RC}"
  fi
}

# _backup_class_target <class> — read the assignments payload on stdin, print
# the bound targetId ('' when the class exists but is unbound) or UNKNOWN when
# the payload is unparseable / the class is absent. Split out so the decision
# is unit-testable without a live cluster.
_backup_class_target() {
  python3 -c "
import json,sys
try:
    rows = json.load(sys.stdin)['data']['assignments']
except Exception:
    print('UNKNOWN'); raise SystemExit
for r in rows:
    if r.get('className') == sys.argv[1]:
        print(r.get('targetId') or ''); raise SystemExit
print('UNKNOWN')
" "$1" 2>/dev/null || printf 'UNKNOWN'
}

# require_backup_class_or_skip <class> — SKIP (77) when the CLUSTER has no
# backup target bound to <class> (system | tenant | mail).
#
# Unlike require_or_skip this is about cluster STATE, not a missing env var: a
# freshly bootstrapped cluster has no target bound, so every backup/DR suite
# fails deep in its run with
#     NO_SNAPSHOT_TARGET — "No backup target bound to the 'tenant' class"
#     target: no active backup config — run /tenant-backup → Off-site Targets
# On 2026-08-04 that turned twelve suites red on a fresh cluster and read as
# twelve product failures. "Not configured" must report as SKIPPED, not FAILED.
#
# FAILS OPEN: if the check itself cannot run (no host, no credentials, API
# unreachable, unexpected payload) it returns 0 and lets the suite proceed —
# a broken precondition check must never mask a real failure.
require_backup_class_or_skip() {
  local class="${1:-tenant}"
  local host="${ADMIN_HOST:-${API_URL:-}}"
  local token="${INTEGRATION_TOKEN:-}"
  [[ -n "$host" ]] || return 0
  if [[ -z "$token" ]]; then
    [[ -n "${ADMIN_EMAIL:-}" && -n "${ADMIN_PASSWORD:-}" ]] || return 0
    token="$(curl -sk -m 20 -X POST "$host/api/v1/auth/login" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" 2>/dev/null \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    [[ -n "$token" ]] || return 0
  fi
  local payload bound
  payload="$(curl -sk -m 20 "$host/api/v1/admin/backup-rclone-shim/assignments" \
    -H "Authorization: Bearer $token" 2>/dev/null)"
  # Empty/failed fetch → cannot determine → fail open.
  [[ -n "$payload" ]] || return 0
  bound="$(printf '%s' "$payload" | _backup_class_target "$class")"
  # UNKNOWN = unparseable payload or no such class → fail open.
  [[ "$bound" == "UNKNOWN" ]] && return 0
  if [[ -z "$bound" ]]; then
    {
      echo "SKIP: no backup target is bound to the '${class}' class on this cluster."
      echo "      Bind one in the admin panel (Backups → Targets, Schedules & Retention)"
      echo "      or via PUT /api/v1/admin/backup-rclone-shim/assignments/${class}."
    } >&2
    exit "${INTEGRATION_SKIP_RC}"
  fi
  return 0
}

# redact <string> — best-effort scrub of secrets before logging. Use when a
# harness must echo a URL/connection string that may embed credentials.
redact() {
  sed -E 's#(://[^:/@]+:)[^@]+@#\1***@#g; s#([?&](password|token|key|secret|sig)=)[^&]+#\1***#gI'
}

# provision_tenant <cid> [timeout_seconds]
#
# Tenants are created `status:'pending'` + `provisioningStatus:'unprovisioned'`
# with NO auto-provision. Provisioning is an explicit step that activates the
# tenant on completion (status -> 'active'). Until active, a tenant cannot
# deploy workloads, configure domains/ingress, or set up email — those are
# gated by the backend (TENANT_NOT_ACTIVE). So every test that creates a tenant
# must call this right after the create before doing anything else.
#
# Relies on the sourcing script defining `api METHOD PATH [BODY]` (the standard
# integration helper). Triggers POST /admin/tenants/:id/provision and polls
# GET /tenants/:id until status=active. Returns non-zero on timeout.
provision_tenant() {
  local cid="$1" timeout="${2:-180}" i=0
  api POST "/admin/tenants/${cid}/provision" "{}" >/dev/null 2>&1 || true
  while (( i < timeout )); do
    case "$(api GET "/tenants/${cid}" 2>/dev/null)" in
      *'"status":"active"'*) return 0 ;;
    esac
    sleep 4; i=$((i + 4))
  done
  echo "provision_tenant: tenant ${cid} did not reach status=active within ${timeout}s" >&2
  return 1
}
