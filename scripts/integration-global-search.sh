#!/usr/bin/env bash
# integration-global-search.sh — E2E harness for GET /api/v1/search.
#
# The endpoint carries NO requireRole gate: every authenticated user hits the
# same URL and the providers decide what comes back. That makes authorization
# the thing worth driving against a real cluster, not the matching.
#
# Phases:
#   A — admin can find the four core record kinds
#     A1. a tenant by name
#     A2. a domain by hostname
#     A3. a mailbox by local-part
#     A4. case-insensitivity: the UPPER-CASED term finds the same tenant
#         (the whole estate searched with `like` before this feature — an
#         all-lowercase query never matched a capitalised name)
#   B — input handling
#     B1. a 1-character term is refused (400), not silently run
#     B2. `_` returns a BOUNDED set, not the whole table. `_` is LIKE's
#         single-character wildcard; unescaped it matches every row, which
#         reads as "search is broken" rather than "you typed a wildcard"
#     B3. a 65-character term is refused (400)
#   C — tenant scoping (THE test — everything else is convenience)
#     C1. the tenant token finds its OWN domain
#     C2. the tenant token does NOT find the other tenant's domain, by
#         searching for that hostname explicitly
#     C3. no admin-only group (tenants/nodes/plans) appears for a tenant
#   D — role scoping on the admin panel
#     D1. a read_only admin gets tenants/domains/mailboxes
#     D2. a read_only admin gets NO `user` group — the directory is gated
#         on super_admin/admin by admin-users/routes.ts, and search must
#         not be a way around a boundary the API already draws
#   E — unauthenticated access is refused (401)
#
# Every assertion reads the RESPONSE BODY, not a status code alone: a 200
# carrying zero groups and a 200 carrying the right groups are the same
# status, and only one of them is the feature working.
#
# Skip conditions (exit 77):
#   * GET /api/v1/search → 404 (build predates this feature)
#
# Env (profile-loaded via lib/integration-env.sh):
#   API_URL          required — https://admin.<apex>
#   ADMIN_EMAIL      required
#   ADMIN_PASSWORD   required

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/integration-env.sh"
load_integration_env
source "$SCRIPT_DIR/lib/integration-lib.sh"

require_env API_URL ADMIN_EMAIL ADMIN_PASSWORD

NONCE="gs$(date +%s)"
TOKEN=""
TMPDIR_GS="$(mktemp -d /tmp/integration-global-search.XXXXXX)"
CREATED_TENANTS=()

cleanup() {
  # Tenants created here own a namespace and a PVC; leaving them behind burns
  # cluster quota on every run.
  #
  # The delete is CONFIRMED, not fired and forgotten. A sibling harness
  # reported "cleaned up 2 tenants" while all four it had created were still
  # on the cluster — it was counting attempts, not outcomes. Deleting a
  # provisioned tenant tears down a namespace and can take well over the
  # default timeout, so each one is re-checked and retried once.
  local t code still
  for t in "${CREATED_TENANTS[@]:-}"; do
    [[ -n "$t" ]] || continue
    curl -sk -X DELETE "$API_URL/api/v1/tenants/$t" \
      -H "Authorization: Bearer $TOKEN" --max-time 60 >/dev/null 2>&1 || true
    code=$(curl -sk -o /dev/null -w '%{http_code}' "$API_URL/api/v1/tenants/$t" \
      -H "Authorization: Bearer $TOKEN" --max-time 30 2>/dev/null || echo 000)
    if [[ "$code" != "404" ]]; then
      curl -sk -X DELETE "$API_URL/api/v1/tenants/$t" \
        -H "Authorization: Bearer $TOKEN" --max-time 60 >/dev/null 2>&1 || true
      still=$(curl -sk -o /dev/null -w '%{http_code}' "$API_URL/api/v1/tenants/$t" \
        -H "Authorization: Bearer $TOKEN" --max-time 30 2>/dev/null || echo 000)
      [[ "$still" == "404" ]] \
        || echo "WARNING: tenant $t may still exist (GET returned $still) — check the estate" >&2
    fi
  done
  rm -rf "$TMPDIR_GS"
}
trap cleanup EXIT

api() { # api <method> <path> [body] [token]
  local method="$1" path="$2" body="${3:-}" tok="${4:-$TOKEN}"
  if [[ -n "$body" ]]; then
    curl -sk -X "$method" "$API_URL/api/v1$path" \
      -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
      --max-time 30 -d "$body"
  else
    curl -sk -X "$method" "$API_URL/api/v1$path" \
      -H "Authorization: Bearer $tok" --max-time 30
  fi
}

search() { # search <term> [token] -> response body
  local term="$1" tok="${2:-$TOKEN}"
  curl -sk -G "$API_URL/api/v1/search" --data-urlencode "q=$term" \
    -H "Authorization: Bearer $tok" --max-time 30
}

search_status() { # search_status <term> [token] -> HTTP status
  local term="$1" tok="${2:-$TOKEN}"
  curl -sk -o /dev/null -w '%{http_code}' -G "$API_URL/api/v1/search" \
    --data-urlencode "q=$term" -H "Authorization: Bearer $tok" --max-time 30
}

# Titles in one group, or empty when the group is absent. The distinction
# between "group absent" and "group present but empty" matters: the API
# drops empty groups, so absence is the expected shape for no matches.
titles_in() { jq -r --arg t "$2" '[.data.groups[]? | select(.type==$t) | .items[].title] | .[]' <<<"$1"; }
group_types() { jq -r '[.data.groups[]?.type] | join(",")' <<<"$1"; }

# ── Auth ─────────────────────────────────────────────────────────────────
il_phase_begin "auth"
TOKEN=$(curl -fsSk -X POST "$API_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email:$e,password:$p}')" \
  | jq -r '.data.token // empty')
[[ -n "$TOKEN" ]] || { echo "ERROR: admin login failed" >&2; exit 2; }
il_ok "admin login"

if [[ "$(search_status "zzz")" == "404" ]]; then
  echo "SKIP: /api/v1/search not present in this build (pre-feature)" >&2
  exit 77
fi
il_phase_end

# ── Fixtures: two tenants, so "cannot see the other one" is testable ─────
il_phase_begin "fixtures"
# Pick the plan with the most sub-user headroom, not data[0].
#
# Phase C needs a tenant_admin sub-user to hold a tenant-panel token, and a
# tenant's own owner already consumes one slot — so the default Starter plan
# (maxSubUsers=1) fails with SUB_USER_LIMIT before phase C can run at all.
# Ordering by the limit keeps this working on any plan set rather than
# depending on which plan happens to be listed first.
PLANS=$(api GET "/plans?limit=50")
PLAN_ID=$(jq -r '[.data[]] | sort_by(.maxSubUsers // 0) | reverse | .[0].id // empty' <<<"$PLANS")
PLAN_SUBS=$(jq -r --arg id "$PLAN_ID" '.data[] | select(.id==$id) | .maxSubUsers // 0' <<<"$PLANS")
[[ -n "$PLAN_ID" ]] || { echo "ERROR: no hosting plan to attach" >&2; exit 2; }
if [[ "${PLAN_SUBS:-0}" -lt 2 ]]; then
  il_info "best plan allows only ${PLAN_SUBS:-0} sub-user(s) — phase C may hit SUB_USER_LIMIT"
fi

# NOTE: this writes the new id into NEW_TENANT_ID rather than echoing it.
# An earlier form was called as `TENANT_A=$(make_tenant a)` — a COMMAND
# SUBSTITUTION, which runs in a subshell, so `CREATED_TENANTS+=(...)` mutated
# a copy that died with the subshell. The parent array stayed empty and the
# cleanup trap deleted nothing: a failed run left two provisioned tenants
# (namespace + PVC each) on the cluster with no sign anything had leaked.
NEW_TENANT_ID=""
make_tenant() { # make_tenant <suffix> -> sets NEW_TENANT_ID
  local suffix="$1" body resp id
  body=$(jq -nc --arg n "Search E2E ${NONCE} ${suffix}" \
    --arg e "search-${NONCE}-${suffix}@example.test" --arg p "$PLAN_ID" \
    '{name:$n, contact_name:"Search E2E", primary_email:$e, plan_id:$p}')
  resp=$(api POST "/tenants" "$body")
  id=$(jq -r '.data.id // empty' <<<"$resp")
  [[ -n "$id" ]] || { echo "ERROR: tenant create failed: $resp" >&2; exit 2; }
  CREATED_TENANTS+=("$id")
  NEW_TENANT_ID="$id"
}

# A tenant is created `pending` and REFUSES to configure domains until it has
# been provisioned (409 TENANT_NOT_ACTIVE) — provisioning builds its namespace
# and PVC, so it is a real wait, not a formality.
provision_and_wait() { # provision_and_wait <tenant-id>
  local id="$1" i status
  api POST "/admin/tenants/$id/provision" "{}" >/dev/null 2>&1 || true
  for i in $(seq 1 60); do
    status=$(api GET "/tenants/$id" | jq -r '.data.status // empty')
    [[ "$status" == "active" ]] && return 0
    sleep 5
  done
  echo "ERROR: tenant $id never reached active (last status: ${status:-unknown})" >&2
  return 1
}

make_tenant a; TENANT_A="$NEW_TENANT_ID"
make_tenant b; TENANT_B="$NEW_TENANT_ID"
il_ok "two tenants created (A=$TENANT_A B=$TENANT_B)"

for t in "$TENANT_A" "$TENANT_B"; do
  provision_and_wait "$t" || { echo "ERROR: provisioning failed" >&2; exit 2; }
done
il_ok "both tenants provisioned and active"

DOMAIN_A="a-${NONCE}.example.test"
DOMAIN_B="b-${NONCE}.example.test"
for pair in "$TENANT_A:$DOMAIN_A" "$TENANT_B:$DOMAIN_B"; do
  tid="${pair%%:*}"; dn="${pair##*:}"
  resp=$(api POST "/tenants/$tid/domains" "$(jq -nc --arg d "$dn" '{domain_name:$d}')")
  jq -e '.data.id' <<<"$resp" >/dev/null 2>&1 \
    || { echo "ERROR: domain create failed for $dn: $resp" >&2; exit 2; }
done
il_ok "one domain per tenant ($DOMAIN_A / $DOMAIN_B)"
il_phase_end

# ── A. admin finds the core record kinds ─────────────────────────────────
il_phase_begin "A: admin record search"
RESP=$(search "$NONCE")

if titles_in "$RESP" tenant | grep -q "$NONCE"; then
  il_ok "A1 tenant found by name"
else
  il_fail "A1 tenant NOT found for '$NONCE' — groups: $(group_types "$RESP")"
fi

if titles_in "$RESP" domain | grep -q "$DOMAIN_A"; then
  il_ok "A2 domain found by hostname"
else
  il_fail "A2 domain $DOMAIN_A NOT found — groups: $(group_types "$RESP")"
fi

# A mailbox hangs off an ENABLED email domain, so this is a two-step chain.
# Each step reports its own failure: "mailbox create failed" when the enable
# was the thing that broke is a misleading skip reason, and a skip whose
# stated cause is a guess is worse than no skip at all.
MB_LOCAL="mb${NONCE}"
DOMAIN_A_ID=$(api GET "/tenants/$TENANT_A/domains" \
  | jq -r --arg d "$DOMAIN_A" '.data[] | select(.domainName==$d) | .id' | head -1)
if [[ -z "$DOMAIN_A_ID" ]]; then
  il_skip "A3 mailbox — could not resolve the domain id for $DOMAIN_A"
else
  EN_RESP=$(api POST "/tenants/$TENANT_A/email/domains/$DOMAIN_A_ID/enable" "{}" 2>/dev/null || true)
  EMAIL_DOMAIN_ID=$(jq -r '.data.id // .data.emailDomainId // empty' <<<"$EN_RESP")
  if [[ -z "$EMAIL_DOMAIN_ID" ]]; then
    il_skip "A3 mailbox — email-domain enable failed: $(jq -rc '.error.code // .' <<<"$EN_RESP" 2>/dev/null | head -c 120)"
  else
    MB_RESP=$(api POST "/tenants/$TENANT_A/email/domains/$EMAIL_DOMAIN_ID/mailboxes" \
      "$(jq -nc --arg l "$MB_LOCAL" '{local_part:$l, quota_mb:20}')" 2>/dev/null || true)
    if jq -e '.data.id' <<<"$MB_RESP" >/dev/null 2>&1; then
      if titles_in "$(search "$MB_LOCAL")" mailbox | grep -q "$MB_LOCAL"; then
        il_ok "A3 mailbox found by local-part"
      else
        il_fail "A3 mailbox $MB_LOCAL created but NOT found by search"
      fi
    else
      il_skip "A3 mailbox — create failed: $(jq -rc '.error.code // .' <<<"$MB_RESP" 2>/dev/null | head -c 120)"
    fi
  fi
fi

# The estate searched with case-SENSITIVE `like` before this change, so an
# all-lowercase query never matched a capitalised tenant name.
UPPER=$(tr '[:lower:]' '[:upper:]' <<<"$NONCE")
if titles_in "$(search "$UPPER")" tenant | grep -q "$NONCE"; then
  il_ok "A4 search is case-insensitive"
else
  il_fail "A4 UPPERCASE '$UPPER' did not match the tenant — ilike regression"
fi
il_phase_end

# ── B. input handling ────────────────────────────────────────────────────
il_phase_begin "B: input handling"
S=$(search_status "z")
[[ "$S" == "400" ]] && il_ok "B1 one-character term refused (400)" \
                    || il_fail "B1 one-character term returned $S, expected 400"

# `_` is LIKE's single-character wildcard: unescaped, `__` matches every name
# of two characters or more — i.e. the whole estate.
#
# Asserting only "the result is small" would ALSO pass if search were dead,
# since zero is small. So this pairs the wildcard query with a CONTROL query
# that must return something. Escaping is proven by the pair: the control
# finds rows, the wildcard does not.
UNDERSCORE=$(search "__")
WIDEST=$(jq -r '[.data.groups[]?.items | length] | max // 0' <<<"$UNDERSCORE")
CONTROL=$(search "$NONCE")
CONTROL_ROWS=$(jq -r '[.data.groups[]?.items | length] | add // 0' <<<"$CONTROL")
if [[ "$CONTROL_ROWS" -lt 1 ]]; then
  il_fail "B2 control query returned nothing — cannot conclude anything about escaping"
elif [[ "$WIDEST" -le 5 ]]; then
  il_ok "B2 wildcard escaped (control found $CONTROL_ROWS rows; '__' largest group $WIDEST)"
else
  il_fail "B2 '__' returned $WIDEST rows in one group — %/_ escaping regressed"
fi

LONG=$(printf 'a%.0s' $(seq 1 65))
S=$(search_status "$LONG")
[[ "$S" == "400" ]] && il_ok "B3 over-long term refused (400)" \
                    || il_fail "B3 65-char term returned $S, expected 400"
il_phase_end

# ── C. tenant scoping — the one that matters ─────────────────────────────
il_phase_begin "C: tenant scoping"
# The API refuses a caller-supplied password (INVALID_FIELD_VALUE) and hands
# back `generatedPassword` exactly once, on create. There is no second chance
# to read it, so it is captured here rather than re-fetched later.
TU_EMAIL="tu-${NONCE}@example.test"
TU_RESP=$(api POST "/tenants/$TENANT_A/users" \
  "$(jq -nc --arg e "$TU_EMAIL" \
     '{email:$e, full_name:"Search E2E Tenant User", role_name:"tenant_admin"}')")
TU_PASSWORD=$(jq -r '.data.generatedPassword // empty' <<<"$TU_RESP")
if [[ -z "$TU_PASSWORD" ]]; then
  il_fail "C0 tenant user created but no generatedPassword returned: $(jq -rc '.error.code // .' <<<"$TU_RESP" | head -c 120)"
elif ! jq -e '.data.id' <<<"$TU_RESP" >/dev/null 2>&1; then
  il_fail "C0 tenant user create failed: $TU_RESP"
else
  TU_TOKEN=$(curl -sk -X POST "$API_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg e "$TU_EMAIL" --arg p "$TU_PASSWORD" '{email:$e,password:$p,panel:"tenant"}')" \
    | jq -r '.data.token // empty')
  if [[ -z "$TU_TOKEN" ]]; then
    il_fail "C0 tenant login failed"
  else
    il_ok "C0 tenant_admin token obtained"

    if titles_in "$(search "$NONCE" "$TU_TOKEN")" domain | grep -q "$DOMAIN_A"; then
      il_ok "C1 tenant finds its own domain"
    else
      il_fail "C1 tenant could NOT find its own domain $DOMAIN_A"
    fi

    # Search for the OTHER tenant's hostname explicitly. A shared prefix
    # would make this pass by accident, so the term is B's full hostname.
    CROSS=$(search "$DOMAIN_B" "$TU_TOKEN")
    if titles_in "$CROSS" domain | grep -q "$DOMAIN_B"; then
      il_fail "C2 CROSS-TENANT LEAK — tenant A's token returned $DOMAIN_B"
    else
      il_ok "C2 tenant cannot see the other tenant's domain"
    fi

    TYPES=$(group_types "$(search "$NONCE" "$TU_TOKEN")")
    if grep -qE '(^|,)(tenant|node|hosting_plan|backup_target|user)(,|$)' <<<"$TYPES"; then
      il_fail "C3 admin-only group leaked to the tenant panel: $TYPES"
    else
      il_ok "C3 no admin-only group on the tenant panel"
    fi
  fi
fi
il_phase_end

# ── D. role scoping on the admin panel ───────────────────────────────────
il_phase_begin "D: admin role scoping"
RO_EMAIL="ro-${NONCE}@example.test"
RO_PASSWORD="ReadOnly!E2E-${NONCE}"
RO_RESP=$(api POST "/admin/users" \
  "$(jq -nc --arg e "$RO_EMAIL" --arg p "$RO_PASSWORD" \
     '{email:$e, full_name:"Search E2E Read Only", role_name:"read_only", password:$p}')" 2>/dev/null || true)
if ! jq -e '.data.id' <<<"$RO_RESP" >/dev/null 2>&1; then
  il_skip "D read_only admin create failed — skipping role-scoping phase"
else
  RO_TOKEN=$(curl -sk -X POST "$API_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg e "$RO_EMAIL" --arg p "$RO_PASSWORD" '{email:$e,password:$p}')" \
    | jq -r '.data.token // empty')
  if [[ -z "$RO_TOKEN" ]]; then
    il_skip "D read_only login failed — skipping role-scoping phase"
  else
    RO_RESULT=$(search "$NONCE" "$RO_TOKEN")
    RO_TYPES=$(group_types "$RO_RESULT")
    if grep -q 'tenant' <<<"$RO_TYPES"; then
      il_ok "D1 read_only still finds tenants ($RO_TYPES)"
    else
      il_fail "D1 read_only got no tenant group — over-tightened: $RO_TYPES"
    fi
    if grep -qE '(^|,)user(,|$)' <<<"$RO_TYPES"; then
      il_fail "D2 read_only received the USER directory — role boundary bypassed"
    else
      il_ok "D2 read_only gets no user group"
    fi
  fi
fi
il_phase_end

# ── E. unauthenticated ───────────────────────────────────────────────────
il_phase_begin "E: unauthenticated"
S=$(curl -sk -o /dev/null -w '%{http_code}' -G "$API_URL/api/v1/search" \
  --data-urlencode "q=$NONCE" --max-time 30)
[[ "$S" == "401" ]] && il_ok "E1 anonymous search refused (401)" \
                    || il_fail "E1 anonymous search returned $S, expected 401"
il_phase_end

il_summary "global-search"
