#!/usr/bin/env bash
# test-vmtier-profile-isolation.sh — the VM tier must never inherit the
# operator's integration profile, and must never copy it to a test VM.
#
# WHY (observed on runs 739730e6 / 5a7f45b3, 2026-08-19):
#   run.sh tars the whole scripts/ directory to the throwaway runner VM. That
#   directory contains the operator's gitignored scripts/integration.env, which
#   pins ADMIN_HOST / MAIL_HOST / PLATFORM_BASE_DOMAIN at their REAL staging
#   cluster — and carries ADMIN_PASSWORD and SSH_KEY.
#
#   Two consequences:
#     1. lib/integration-env.sh loads it (its caller-wins guard only protects
#        vars the caller EXPORTED; run.sh never exports MAIL_HOST), so the tier
#        ran with a config naming TWO clusters: the ephemeral VM for the API and
#        the operator's staging server for mail. The smoke gate then attempted
#        an SMTP AUTH against staging, failed "Login denied", and aborted the
#        whole run before a single suite.
#     2. Staging credentials landed on disposable VM disks.
#
#   run.sh tried to prevent (1) with `export INTEGRATION_ENV=`. An EMPTY value
#   does NOT suppress the profile search — the lib iterates
#   [$INTEGRATION_ENV, scripts/integration.env, ~/.config/...] and takes the
#   first EXISTING file, so an empty candidate just hands the run to the
#   operator's profile. It must name a real, tier-owned file.
#
# These are grep-level invariants on run.sh: cheap, and they fail the moment
# someone reverts either half.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="${HERE}/vm-integration-tests/run.sh"
LIB="${HERE}/lib/integration-env.sh"

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ok: $*"; }
bad()  { fail=$((fail+1)); echo "  FAIL: $*" >&2; }

[[ -r "$RUN_SH" ]] || { echo "test-vmtier-profile-isolation: $RUN_SH not readable" >&2; exit 1; }

# 1. The tar to the runner must exclude the operator profile.
if grep -qE 'tar czf -[^|]*--exclude=integration\.env' "$RUN_SH"; then
  ok "runner tar excludes integration.env"
else
  bad "runner tar does NOT exclude integration.env — staging ADMIN_PASSWORD/SSH_KEY would be copied to throwaway VMs"
fi

# 2. INTEGRATION_ENV must name a file, never be empty.
if grep -qE '^export .*INTEGRATION_ENV=[[:space:]]*$' "$RUN_SH" \
   || grep -qE 'INTEGRATION_ENV=[[:space:]]*(&&|;|$)' "$RUN_SH"; then
  bad "run.sh sets an EMPTY INTEGRATION_ENV — that does not suppress the profile search, it hands the run to scripts/integration.env"
else
  ok "INTEGRATION_ENV is not set empty"
fi

if grep -qE 'INTEGRATION_ENV=/[^[:space:]]+' "$RUN_SH"; then
  ok "INTEGRATION_ENV points at a concrete path"
else
  bad "INTEGRATION_ENV does not point at a tier-owned profile path"
fi

# 3. That profile must DEFINE MAIL_HOST — the var whose absence caused the
#    cross-cluster probe — but define it EMPTY, not pinned to a hostname.
#    Both halves matter:
#      - defined  → the operator's own profile can never leak in (isolation,
#        the original bug this guard exists for)
#      - EMPTY    → _resolve_serving_mail_host's sweep stays active. A
#        hostname pin bypasses the sweep, so after a legitimate mail-stack
#        migration every probe kept hitting the STATIC dnsmasq A-record and
#        failed "Connection refused" against a healthy mail server for the
#        rest of the run (run 3897175c — the tier's only failure).
if grep -qE '^\s*echo "MAIL_HOST="\s*$' "$RUN_SH"; then
  ok "tier profile defines MAIL_HOST empty (isolation kept, serving-node sweep active)"
elif grep -qE 'MAIL_HOST=mail\.' "$RUN_SH"; then
  bad "tier profile PINS MAIL_HOST to a hostname — the serving-node sweep is bypassed and any mail migration strands every later probe"
else
  bad "tier profile does not define MAIL_HOST — smoke can inherit the operator's mail server again"
fi

# 3b. The tier profile must be COMPLETE. Replacing the operator profile with a
#     partial one just moves the two-clusters problem: MAIL_PORT_* absent meant
#     smoke probed the dev DinD NodePorts (2025/2587/2143/2993), which nothing
#     on a real cluster listens on.
for _v in MAIL_PORT_SMTP MAIL_PORT_SUBMISSION MAIL_PORT_IMAP MAIL_PORT_IMAPS MAIL_PROBE_MODE; do
  if grep -qE "echo \"${_v}=" "$RUN_SH"; then
    ok "tier profile defines ${_v}"
  else
    bad "tier profile is missing ${_v} — smoke falls back to a default that does not apply here"
  fi
done

# 4. Guard the lib's search semantics the above relies on: first EXISTING
#    candidate wins, with $INTEGRATION_ENV first.
if [[ -r "$LIB" ]]; then
  if grep -qE '"\$\{INTEGRATION_ENV:-\}"' "$LIB" && grep -qE '\[\[ -n "\$candidate" && -f "\$candidate" \]\]' "$LIB"; then
    ok "integration-env.sh still skips non-existent candidates (empty INTEGRATION_ENV cannot suppress)"
  else
    bad "integration-env.sh search semantics changed — re-check whether an empty INTEGRATION_ENV now suppresses the search"
  fi
fi

echo "test-vmtier-profile-isolation: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
