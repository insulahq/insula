#!/usr/bin/env bash
# ensure-mail-e2e-mailbox.sh — provision the mailbox the mail DELIVERY gate needs.
#
# WHY THIS EXISTS
#
# smoke-test.sh's delivery gate (authenticated SMTPS send-to-self on :465 +
# IMAPS retrieve on :993) is the ONLY check that proves mail actually delivers.
# The TCP/banner probes around it are liveness only: a listener answering "220"
# passes them while the server rejects every message at DATA with
# "452 4.3.1 Mail system full" — exactly the Stalwart regression that shipped
# undetected in v2026.6.14.
#
# That gate needs a real mailbox with a real password, and it skipped on every
# run because nothing ever created one: the suites' own mailboxes are
# deliberately ephemeral (staging-all deletes its mail-scenario clients in
# cleanup), so the mailboxes table is empty between runs.
#
# Rather than require an operator to hand-create standing state — which drifts,
# and which nobody remembers to recreate after a DR restore — this provisions a
# throwaway tenant + domain + mailbox on demand and exports the credentials.
#
# The gate authenticates DIRECTLY to Stalwart and sends to itself, so the test
# domain needs no public MX and no authoritative DNS: Stalwart accepts mail for
# any domain it hosts. `dns_mode=cname` is therefore correct and deliberate —
# it also keeps the platform from writing records into a zone it doesn't own.
#
# USAGE (sourced, not executed — it exports into the caller's env):
#   source scripts/lib/ensure-mail-e2e-mailbox.sh
#   ensure_mail_e2e_mailbox            # sets MAIL_E2E_USER / MAIL_E2E_PASS
#   ...
#   cleanup_mail_e2e_mailbox           # deletes the throwaway tenant
#
# Honours pre-set values: if the operator already exported MAIL_E2E_USER and
# MAIL_E2E_PASS (a persistent mailbox they maintain), this is a no-op.
#
# Never fatal. If provisioning fails the gate simply stays skipped, with a loud
# reason — a broken helper must not take down a whole integration run.

MAIL_E2E_TENANT_ID="${MAIL_E2E_TENANT_ID:-}"

_me2e_api() {
  # $1=METHOD $2=PATH $3=BODY(optional)
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -k --max-time 60 -X "$method" "${ADMIN_HOST}/api/v1${path}" \
      -H "Authorization: Bearer ${MAIL_E2E_TOKEN}" \
      -H 'Content-Type: application/json' -d "$body" 2>/dev/null
  else
    curl -sS -k --max-time 60 -X "$method" "${ADMIN_HOST}/api/v1${path}" \
      -H "Authorization: Bearer ${MAIL_E2E_TOKEN}" 2>/dev/null
  fi
}

_me2e_jget() { python3 -c "import json,sys;
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
try:
  v=d$1
  print(v if v is not None else '')
except Exception: pass" 2>/dev/null; }

ensure_mail_e2e_mailbox() {
  if [[ -n "${MAIL_E2E_USER:-}" && -n "${MAIL_E2E_PASS:-}" ]]; then
    echo "  ⊙ mail-e2e: using operator-supplied MAIL_E2E_USER=${MAIL_E2E_USER}"
    return 0
  fi
  if [[ -z "${ADMIN_HOST:-}" || -z "${ADMIN_EMAIL:-}" || -z "${ADMIN_PASSWORD:-}" ]]; then
    echo "  ⊘ mail-e2e: ADMIN_HOST/EMAIL/PASSWORD unset — delivery gate stays skipped" >&2
    return 0
  fi

  MAIL_E2E_TOKEN=$(curl -sS -k --max-time 30 -X POST "${ADMIN_HOST}/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" 2>/dev/null \
    | _me2e_jget "['data']['token']")
  if [[ -z "$MAIL_E2E_TOKEN" ]]; then
    echo "  ⊘ mail-e2e: admin login failed — delivery gate stays skipped" >&2
    return 0
  fi

  local stamp; stamp="$(date +%s)"
  local tname="itest-maildeliv-${stamp}"
  # TLD must be alpha-only: Zod 3.25 email validation rejects a numeric TLD,
  # so `…-1786455322.net` style names are fine but `…​.123` is not.
  local tdomain="maildeliv${stamp}.test"

  local plan_id region_id
  plan_id=$(_me2e_api GET "/plans?limit=1" | _me2e_jget "['data'][0]['id']")
  region_id=$(_me2e_api GET "/regions?limit=1" | _me2e_jget "['data'][0]['id']")
  if [[ -z "$plan_id" || -z "$region_id" ]]; then
    echo "  ⊘ mail-e2e: could not resolve plan/region — delivery gate stays skipped" >&2
    return 0
  fi

  local tenant
  tenant=$(_me2e_api POST "/tenants" "{\"name\":\"${tname}\",\"contact_name\":\"Mail E2E\",\"primary_email\":\"mail-e2e@example.test\",\"plan_id\":\"${plan_id}\",\"region_id\":\"${region_id}\"}")
  MAIL_E2E_TENANT_ID=$(printf '%s' "$tenant" | _me2e_jget "['data']['id']")
  if [[ -z "$MAIL_E2E_TENANT_ID" ]]; then
    echo "  ⊘ mail-e2e: tenant create failed — delivery gate stays skipped ($(printf '%s' "$tenant" | head -c 160))" >&2
    return 0
  fi

  # Tenants are created status=pending / unprovisioned with NO auto-provision.
  # Until active the backend gates domains, email and workloads behind
  # TENANT_NOT_ACTIVE — so provisioning is mandatory before the domain create,
  # not an optimisation. (Mirrors provision_tenant() in integration-env.sh, but
  # inlined against _me2e_api so this helper stays self-contained.)
  _me2e_api POST "/admin/tenants/${MAIL_E2E_TENANT_ID}/provision" "{}" >/dev/null 2>&1 || true
  local waited=0 active=0
  while (( waited < 180 )); do
    case "$(_me2e_api GET "/tenants/${MAIL_E2E_TENANT_ID}" 2>/dev/null)" in
      *'"status":"active"'*) active=1; break ;;
    esac
    sleep 4; waited=$((waited + 4))
  done
  if (( active == 0 )); then
    echo "  ⊘ mail-e2e: tenant did not reach active within 180s — delivery gate stays skipped" >&2
    cleanup_mail_e2e_mailbox; return 0
  fi

  local dom_id
  dom_id=$(_me2e_api POST "/tenants/${MAIL_E2E_TENANT_ID}/domains" \
    "{\"domain_name\":\"${tdomain}\",\"dns_mode\":\"cname\"}" | _me2e_jget "['data']['id']")
  if [[ -z "$dom_id" ]]; then
    echo "  ⊘ mail-e2e: domain create failed — delivery gate stays skipped" >&2
    cleanup_mail_e2e_mailbox; return 0
  fi

  local ed_id
  ed_id=$(_me2e_api POST "/tenants/${MAIL_E2E_TENANT_ID}/email/domains/${dom_id}/enable" "{}" \
    | _me2e_jget "['data']['id']")
  if [[ -z "$ed_id" ]]; then
    echo "  ⊘ mail-e2e: email-domain enable failed — delivery gate stays skipped" >&2
    cleanup_mail_e2e_mailbox; return 0
  fi

  local mb pass
  mb=$(_me2e_api POST "/tenants/${MAIL_E2E_TENANT_ID}/email/domains/${ed_id}/mailboxes" \
    "{\"local_part\":\"deliv\",\"mailbox_type\":\"mailbox\"}")
  pass=$(printf '%s' "$mb" | _me2e_jget "['data']['initialLoginPassword']['secret']")
  local addr; addr=$(printf '%s' "$mb" | _me2e_jget "['data']['fullAddress']")
  [[ -z "$addr" ]] && addr="deliv@${tdomain}"

  if [[ -z "$pass" ]]; then
    # initialLoginPassword is null when the mailbox couldn't reach the mail
    # server yet — surfacing that is the point, so say so rather than skip mute.
    echo "  ⊘ mail-e2e: mailbox created but no initial login password issued (mail server not ready?) — delivery gate stays skipped" >&2
    cleanup_mail_e2e_mailbox; return 0
  fi

  export MAIL_E2E_USER="$addr"
  export MAIL_E2E_PASS="$pass"
  echo "  ✓ mail-e2e: provisioned ${MAIL_E2E_USER} (throwaway tenant ${MAIL_E2E_TENANT_ID})"
}

cleanup_mail_e2e_mailbox() {
  [[ -z "${MAIL_E2E_TENANT_ID:-}" || -z "${MAIL_E2E_TOKEN:-}" ]] && return 0
  _me2e_api DELETE "/tenants/${MAIL_E2E_TENANT_ID}" >/dev/null 2>&1 || true
  echo "  ⊙ mail-e2e: deleted throwaway tenant ${MAIL_E2E_TENANT_ID}"
  MAIL_E2E_TENANT_ID=""
}
