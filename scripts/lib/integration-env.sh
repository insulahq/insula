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
load_integration_env() {
  local script_dir candidate
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"  # scripts/
  for candidate in \
    "${INTEGRATION_ENV:-}" \
    "$script_dir/integration.env" \
    "${XDG_CONFIG_HOME:-$HOME/.config}/insula/integration.env"; do
    [[ -n "$candidate" && -f "$candidate" ]] || continue
    # shellcheck disable=SC1090
    set -a; source "$candidate"; set +a
    [[ -n "${INTEGRATION_ENV_VERBOSE:-}" ]] && echo "integration-env: loaded $candidate" >&2
    return 0
  done
  return 0  # no profile is fine — env vars / CI secrets may supply everything
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
