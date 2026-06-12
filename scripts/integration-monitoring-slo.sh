#!/usr/bin/env bash
# integration-monitoring-slo.sh — E2E harness for the ADR-051 monitoring
# stack: vmsingle scrape health, the admin-gated VMUI, the in-API SLO
# evaluator, and the categorised SLO alert notifications (#56 + #57).
#
# Phases:
#   A — VMUI auth gate + scrape health (through the user-facing endpoint)
#     A1. anonymous GET https://metrics.<apex>/ → denied (401/403/302)
#     A2. same URL with the platform_session cookie → 200 (VMUI serves)
#     A3. /api/v1/query `min by (job) (up)` through the gate: every
#         scrape job up==1, and at least MIN_SCRAPE_JOBS jobs present
#   B — SLO admin API
#     B1. GET /admin/monitoring/slo → vmReachable=true, evaluator
#         heartbeat (lastEvaluationAt) fresh, full rule pack listed
#     B2. GET /admin/monitoring/series?panel=cnpg-up → ≥1 datapoint
#     B3. unknown panel → 400 UNKNOWN_PANEL (server-side panel registry)
#     B4. PATCH /admin/monitoring/rules/<bogus> → 404 RULE_NOT_FOUND
#   C — Notification sources (#56)
#     C1. the 3 admin.slo_alert_* categories exist, active, audience=admin
#     C2. all 6 (category × channel) templates seeded
#   D — Induced alert lifecycle (skippable: SKIP_ALERT_SCENARIO=1; ~8–11
#       min because cnpg-down carries forSeconds=300)
#     D1. override cnpg-down threshold → −1: `(count(...) or vector(0))
#         > -1` passes with value 0 → alert fires after the for-window
#     D2. delivery rows written for admin.slo_alert_critical: in_app
#         'sent' AND an email row PRESENT with any status — the #57
#         contract: email deliveries must never silently vanish (they
#         may be queued/failed-no-provider on clusters without an SMTP
#         provider, but the ROW must exist)
#     D3. clear the override → alert resolves; admin.slo_alert_resolved
#         delivery rows written (same in_app + email-presence contract)
#
#   Induce-rule choice: cnpg-down is the only deterministic live induce —
#   acme-order-rate (forSeconds=0) has no `or vector(0)` arm, so with zero
#   fired/forced/error renewal series it returns an empty set regardless
#   of threshold (by design — it materialises only on real LE activity).
#
# Skip conditions (exit 77):
#   * GET /admin/monitoring/slo → 404 (build predates ADR-051)
#   * vmsingle Deployment absent (overlay without k8s/base/monitoring,
#     e.g. local DinD) — probed via $KUBECTL when available, else
#     inferred from vmReachable=false
#
# Env (profile-loaded via lib/integration-env.sh):
#   API_URL          required — https://admin.<apex>
#   ADMIN_EMAIL      required
#   ADMIN_PASSWORD   required
#   PLATFORM_DOMAIN  apex override (default: derived from API_URL host)
#   METRICS_HOST     default: metrics.<apex>
#   KUBECTL          optional — kubectl command for the vmsingle-absent
#                    probe (lib/kubectl-remote.sh on staging)
#   SKIP_ALERT_SCENARIO=1   skip phase D (the slow leg)
#   MIN_SCRAPE_JOBS  default 8

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/integration-env.sh"
load_integration_env
source "$SCRIPT_DIR/lib/integration-lib.sh"

require_env API_URL ADMIN_EMAIL ADMIN_PASSWORD

APEX="${PLATFORM_DOMAIN:-}"
if [[ -z "$APEX" ]]; then
  APEX="$(sed -E 's#^https?://[^./]+\.##; s#/.*$##' <<<"$API_URL")"
fi
METRICS_HOST="${METRICS_HOST:-metrics.$APEX}"
MIN_SCRAPE_JOBS="${MIN_SCRAPE_JOBS:-8}"
KUBECTL="${KUBECTL:-}"

COOKIE_JAR="$(mktemp /tmp/integration-monitoring-slo.XXXXXX.cookies)"
OVERRIDE_SET=0
TOKEN=""

cleanup() {
  # Always clear the induced override — a leftover threshold=-1 keeps
  # cnpg-down firing forever and pages the operator.
  if [[ "$OVERRIDE_SET" == "1" && -n "$TOKEN" ]]; then
    curl -sk -X PATCH "$API_URL/api/v1/admin/monitoring/rules/cnpg-down" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d '{"threshold": null}' >/dev/null 2>&1 || true
  fi
  rm -f "$COOKIE_JAR"
}
trap cleanup EXIT

api() { # api <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sk -X "$method" "$API_URL/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      --max-time 30 -d "$body"
  else
    curl -sk -X "$method" "$API_URL/api/v1$path" \
      -H "Authorization: Bearer $TOKEN" --max-time 30
  fi
}

# ── Auth (login also sets the platform_session cookie we reuse for the
#    VMUI gate — the exact path an operator's browser takes) ──────────
il_phase_begin "auth"
LOGIN_RESP="$(curl -sk -c "$COOKIE_JAR" -X POST "$API_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
TOKEN="$(jq -r '.data.token // empty' <<<"$LOGIN_RESP")"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: login failed against $API_URL" >&2
  exit 2
fi
grep -q "platform_session" "$COOKIE_JAR" \
  && il_ok "login OK (token + platform_session cookie)" \
  || { il_fail "login did not set platform_session cookie"; }
il_phase_end

# ── Skip checks ──────────────────────────────────────────────────────
SLO_HTTP="$(curl -sk -o /tmp/slo-probe-$$.json -w '%{http_code}' \
  -H "Authorization: Bearer $TOKEN" "$API_URL/api/v1/admin/monitoring/slo")"
SLO_BODY="$(cat /tmp/slo-probe-$$.json; rm -f /tmp/slo-probe-$$.json)"
if [[ "$SLO_HTTP" == "404" ]]; then
  echo "SKIP: /admin/monitoring/slo not found — build predates ADR-051" >&2
  exit "$INTEGRATION_SKIP_RC"
fi
if [[ -n "$KUBECTL" ]]; then
  if ! $KUBECTL get deploy vmsingle -n monitoring >/dev/null 2>&1; then
    echo "SKIP: vmsingle Deployment absent — overlay without k8s/base/monitoring" >&2
    exit "$INTEGRATION_SKIP_RC"
  fi
elif [[ "$(jq -r '.data.vmReachable' <<<"$SLO_BODY")" != "true" ]]; then
  echo "SKIP: vmReachable=false and no \$KUBECTL to confirm the stack exists" >&2
  echo "      (set KUBECTL=scripts/lib/kubectl-remote.sh to make this a hard check)" >&2
  exit "$INTEGRATION_SKIP_RC"
fi

# ── Phase A: VMUI gate + scrape health ───────────────────────────────
il_phase_begin "A: VMUI auth gate + scrape health"
ANON_CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "https://$METRICS_HOST/" || echo 000)"
if [[ "$ANON_CODE" =~ ^(401|403|302)$ ]]; then
  il_ok "A1 anonymous metrics UI denied ($ANON_CODE)"
else
  il_fail "A1 anonymous metrics UI returned $ANON_CODE (expected 401/403/302)"
fi

AUTH_CODE="$(curl -sk -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' --max-time 15 "https://$METRICS_HOST/" || echo 000)"
if [[ "$AUTH_CODE" == "200" ]]; then
  il_ok "A2 metrics UI serves with platform_session cookie"
else
  il_fail "A2 metrics UI with cookie returned $AUTH_CODE (expected 200)"
fi

UP_JSON="$(curl -sk -b "$COOKIE_JAR" --max-time 15 \
  "https://$METRICS_HOST/api/v1/query" --data-urlencode 'query=min by (job) (up)' -G || echo '{}')"
JOB_COUNT="$(jq -r '.data.result | length' <<<"$UP_JSON" 2>/dev/null || echo 0)"
DOWN_JOBS="$(jq -r '[.data.result[] | select(.value[1] != "1") | .metric.job] | join(",")' <<<"$UP_JSON" 2>/dev/null || echo parse-error)"
if [[ "$JOB_COUNT" -ge "$MIN_SCRAPE_JOBS" && -z "$DOWN_JOBS" ]]; then
  il_ok "A3 all $JOB_COUNT scrape jobs up==1"
else
  il_fail "A3 scrape health: jobs=$JOB_COUNT (need ≥$MIN_SCRAPE_JOBS), down=[${DOWN_JOBS:-?}]"
fi
il_phase_end

# ── Phase B: SLO admin API ───────────────────────────────────────────
il_phase_begin "B: SLO admin API"
VM_REACHABLE="$(jq -r '.data.vmReachable' <<<"$SLO_BODY")"
RULE_COUNT="$(jq -r '.data.rules | length' <<<"$SLO_BODY")"
LAST_EVAL="$(jq -r '.data.lastEvaluationAt // empty' <<<"$SLO_BODY")"
EVAL_AGE=99999
if [[ -n "$LAST_EVAL" ]]; then
  EVAL_AGE=$(( $(date +%s) - $(date -d "$LAST_EVAL" +%s 2>/dev/null || echo 0) ))
fi
[[ "$VM_REACHABLE" == "true" ]] \
  && il_ok "B1 vmReachable=true" || il_fail "B1 vmReachable=$VM_REACHABLE"
if [[ "$EVAL_AGE" -le 180 ]]; then
  il_ok "B1 evaluator heartbeat fresh (${EVAL_AGE}s ago)"
else
  il_fail "B1 evaluator heartbeat stale (lastEvaluationAt=${LAST_EVAL:-null}, ${EVAL_AGE}s)"
fi
[[ "$RULE_COUNT" -ge 14 ]] \
  && il_ok "B1 rule pack listed ($RULE_COUNT rules)" \
  || il_fail "B1 only $RULE_COUNT rules listed (expected ≥14)"

SERIES="$(api GET '/admin/monitoring/series?panel=cnpg-up&minutes=30')"
POINTS="$(jq -r '[.data.series[].points | length] | add // 0' <<<"$SERIES")"
[[ "$POINTS" -ge 1 ]] \
  && il_ok "B2 series proxy panel=cnpg-up returned $POINTS points" \
  || il_fail "B2 series proxy returned no datapoints: $(jq -c '.error // .' <<<"$SERIES" | head -c 200)"

BAD_PANEL_CODE="$(curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "$API_URL/api/v1/admin/monitoring/series?panel=nope")"
[[ "$BAD_PANEL_CODE" == "400" ]] \
  && il_ok "B3 unknown panel rejected (400)" \
  || il_fail "B3 unknown panel returned $BAD_PANEL_CODE (expected 400)"

BAD_RULE_CODE="$(curl -sk -o /dev/null -w '%{http_code}' -X PATCH \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled": true}' "$API_URL/api/v1/admin/monitoring/rules/no-such-rule")"
[[ "$BAD_RULE_CODE" == "404" ]] \
  && il_ok "B4 unknown rule PATCH rejected (404)" \
  || il_fail "B4 unknown rule PATCH returned $BAD_RULE_CODE (expected 404)"
il_phase_end

# ── Phase C: notification sources (#56) ──────────────────────────────
il_phase_begin "C: SLO notification sources"
CATS="$(api GET '/admin/notifications/categories?audience=admin')"
for cat in admin.slo_alert_critical admin.slo_alert_warning admin.slo_alert_resolved; do
  ROW="$(jq -r --arg id "$cat" '.data[] | select(.id == $id) | "\(.isActive)/\(.audience)"' <<<"$CATS")"
  [[ "$ROW" == "true/admin" ]] \
    && il_ok "C1 category $cat active" \
    || il_fail "C1 category $cat missing or inactive (got: ${ROW:-absent})"
done

TPLS="$(api GET '/admin/notifications/templates')"
TPL_COUNT="$(jq -r '[.data[] | select(.categoryId | startswith("admin.slo_alert"))] | length' <<<"$TPLS")"
[[ "$TPL_COUNT" -ge 6 ]] \
  && il_ok "C2 all 6 SLO templates seeded" \
  || il_fail "C2 only $TPL_COUNT SLO templates present (expected 6)"
il_phase_end

# ── Phase D: induced alert lifecycle ─────────────────────────────────
if [[ "${SKIP_ALERT_SCENARIO:-0}" == "1" ]]; then
  il_skip "D: induced alert lifecycle (SKIP_ALERT_SCENARIO=1)"
else
  il_phase_begin "D: induced cnpg-down alert lifecycle"
  D_START_EPOCH="$(date +%s)"

  PATCH_RESP="$(api PATCH '/admin/monitoring/rules/cnpg-down' '{"threshold": -1}')"
  if [[ "$(jq -r '.data.threshold' <<<"$PATCH_RESP")" == "-1" ]]; then
    OVERRIDE_SET=1
    il_ok "D1 override set (cnpg-down threshold → -1)"
  else
    il_fail "D1 override PATCH failed: $(head -c 200 <<<"$PATCH_RESP")"
  fi

  # forSeconds=300 + up to ~2 evaluation ticks of slack.
  il_wait_for 480 "D1 cnpg-down reaches state=firing" \
    '"ruleId":"cnpg-down","state":"firing"' '-' \
    "curl -sk -H 'Authorization: Bearer $TOKEN' '$API_URL/api/v1/admin/monitoring/alerts' | jq -c '.data[]'" \
    || true

  # The #57 contract: BOTH default channels leave a delivery row. The
  # email row's status is cluster-dependent (queued/sent, or failed
  # 'no provider configured' without an SMTP provider) — absence is the
  # bug class #57 fixed, so absence FAILS.
  SINCE=$(( $(date +%s) - D_START_EPOCH + 60 ))
  DELIV="$(api GET "/admin/notifications/deliveries?categoryId=admin.slo_alert_critical&sinceSeconds=$SINCE")"
  IN_APP_ST="$(jq -r '[.data[] | select(.channel == "in_app")][0].status // "absent"' <<<"$DELIV")"
  EMAIL_ST="$(jq -r '[.data[] | select(.channel == "email")][0].status // "absent"' <<<"$DELIV")"
  [[ "$IN_APP_ST" == "sent" ]] \
    && il_ok "D2 in_app delivery row sent (admin.slo_alert_critical)" \
    || il_fail "D2 in_app delivery row status=$IN_APP_ST (expected sent)"
  [[ "$EMAIL_ST" != "absent" ]] \
    && il_ok "D2 email delivery row present (status=$EMAIL_ST — #57 no-silent-loss contract)" \
    || il_fail "D2 email delivery row ABSENT — the #57 silent-loss regression"

  api PATCH '/admin/monitoring/rules/cnpg-down' '{"threshold": null}' >/dev/null
  OVERRIDE_SET=0
  il_ok "D3 override cleared"

  il_wait_for 240 "D3 cnpg-down resolves" \
    '"ruleId":"cnpg-down","state":"resolved"' '-' \
    "curl -sk -H 'Authorization: Bearer $TOKEN' '$API_URL/api/v1/admin/monitoring/alerts' | jq -c '.data[]'" \
    || true

  SINCE=$(( $(date +%s) - D_START_EPOCH + 60 ))
  RDELIV="$(api GET "/admin/notifications/deliveries?categoryId=admin.slo_alert_resolved&sinceSeconds=$SINCE")"
  R_IN_APP="$(jq -r '[.data[] | select(.channel == "in_app")][0].status // "absent"' <<<"$RDELIV")"
  R_EMAIL="$(jq -r '[.data[] | select(.channel == "email")][0].status // "absent"' <<<"$RDELIV")"
  [[ "$R_IN_APP" == "sent" ]] \
    && il_ok "D3 resolved in_app delivery row sent" \
    || il_fail "D3 resolved in_app delivery row status=$R_IN_APP (expected sent)"
  [[ "$R_EMAIL" != "absent" ]] \
    && il_ok "D3 resolved email delivery row present (status=$R_EMAIL)" \
    || il_fail "D3 resolved email delivery row ABSENT"
  il_phase_end
fi

il_summary "integration-monitoring-slo"
