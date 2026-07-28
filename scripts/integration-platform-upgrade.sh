#!/usr/bin/env bash
# integration-platform-upgrade.sh — DESTRUCTIVE end-to-end harness for the
# admin-controlled production PULL MODEL (ADR-045 W11/W13): version-poller
# detection → preflight gate → Flux GitRepository re-pin → real platform roll →
# rollback. Drives the REAL operator API and watches Flux actually redeploy the
# platform, so it belongs on a cluster you are willing to roll — staging.
#
# WHY (2026-07-28): the upgrade module had 118 unit tests but NO end-to-end
# exercise against a live cluster — dev follows a git branch and staging follows
# Flux-native `ref.semver`, so neither exercised the operator-click re-pin
# (`flux-repin.ts`). This suite closes that gap AND guards the two version-poller
# bugs fixed the same day (non-numeric runAsUser + missing postgres netpol) by
# asserting the poller actually writes `available_version`.
#
# It is genuinely DESTRUCTIVE: it rolls the platform through
#   rc-current → v7.8 (setup) → v7.9 (real forward upgrade) → v7.8 (rollback)
#   → semver/rc-current (teardown)
# using ONLY release tags that are migration-neutral relative to each other
# (verified at authoring: no backend/src/db/migrations delta among 7.8/7.9/rc).
# The manual-apply endpoint only accepts STABLE tags unless
# auto_update_include_prereleases is on, hence the stable 7.8/7.9 pair.
#
# The teardown ALWAYS restores the source's ORIGINAL ref (captured up front),
# so staging ends exactly as found — even on failure (EXIT trap).
#
# Asserts:
#   Phase 1 — Auth (super_admin)
#   Phase 2 — Detection: version-poller writes platform_settings.available_version
#   Phase 3 — Preflight API: GET /admin/platform/upgrade/preflight → 200 + gates
#   Phase 4 — Setup: put the source in the production TAG model at $BASE_TAG,
#             wait for the platform to actually be running $BASE_TAG
#   Phase 5 — REAL apply: POST /admin/platform/upgrade {version:$TARGET, apply}
#             → Flux rolls the platform to $TARGET; platform-api serves $TARGET
#   Phase 6 — REAL rollback: POST /admin/platform/rollback {apply}
#             → Flux rolls back to $BASE_TAG; platform-api serves $BASE_TAG
#   Phase 7 — RBAC: unauthenticated POST /admin/platform/upgrade → 401/403
#   Teardown — restore the original ref; platform back to the starting version
#
# Env (real-cluster convention):
#   ADMIN_HOST      https://admin.<apex>
#   ADMIN_EMAIL / ADMIN_PASSWORD
#   SSH_HOST        root@<node-ip>   (tunnels kubectl to a control-plane node)
#   SSH_KEY         default ~/hosting-platform.key
#   BASE_TAG        default v2026.7.8   (setup floor)
#   TARGET_VERSION  default 2026.7.9    (the real forward-upgrade target)
#   ROLL_TIMEOUT    default 600  (seconds to wait for one Flux roll to converge)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ADMIN_HOST="${ADMIN_HOST:-http://admin.k8s-platform.test:2010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"
SSH_HOST="${SSH_HOST:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
SSH_KEY="${SSH_KEY/#\~/$HOME}"

BASE_TAG="${BASE_TAG:-v2026.7.8}"
TARGET_VERSION="${TARGET_VERSION:-2026.7.9}"
TARGET_TAG="v${TARGET_VERSION#v}"
ROLL_TIMEOUT="${ROLL_TIMEOUT:-600}"

PASSED=0; FAILED=0; FAILURES=()
ok()    { echo -e "  \033[32m✓\033[0m $*"; PASSED=$((PASSED+1)); }
fail()  { echo -e "  \033[31m✗\033[0m $*"; FAILURES+=("$*"); FAILED=$((FAILED+1)); }
log()   { echo -e "\033[36m[$(date +%H:%M:%S)]\033[0m $*"; }
phase() { echo -e "\n\033[1;35m── $* ──\033[0m"; }

kctl() {
  if [[ "$ADMIN_HOST" == *"k8s-platform.test"* ]]; then
    docker exec "$K3S_CONTAINER" kubectl "$@"
  elif [[ -n "$SSH_HOST" ]]; then
    local remote_cmd="kubectl" a
    for a in "$@"; do remote_cmd+=" $(printf '%q' "$a")"; done
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "$remote_cmd"
  else
    kubectl "$@"
  fi
}

# Resolve the platform Flux Kustomization + the GitRepository it tracks. The
# Kustomization name varies by install (`platform` on staging, sometimes
# `hosting-platform-*`), so find it by its GitRepository sourceRef rather than
# guessing the name — the same "resolve by source" idea the backend uses.
GITREPO=""
KS_NAME=""
resolve_gitrepo() {
  local line
  line=$(kctl -n flux-system get kustomization \
      -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{.spec.sourceRef.kind}{"|"}{.spec.sourceRef.name}{"\n"}{end}' 2>/dev/null \
    | awk -F'|' '$2=="GitRepository" && $3 ~ /^hosting-platform/ {print; exit}')
  [[ -z "$line" ]] && return 1
  KS_NAME="${line%%|*}"
  GITREPO="${line##*|}"
  [[ -n "$GITREPO" && -n "$KS_NAME" ]]
}

reconcile() {  # nudge Flux to act immediately instead of on its 5m interval
  local kind="$1" name="$2"
  kctl -n flux-system annotate "$kind" "$name" \
    "reconcile.fluxcd.io/requestedAt=$(date +%s)" --overwrite >/dev/null 2>&1 || true
}

deployed_backend_tag() {
  kctl -n platform get deploy platform-api \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null | sed 's/.*://'
}

# Wait until platform-api is running $1 AND healthy. Nudges Flux each loop.
wait_for_version() {
  local want="$1" deadline=$(( $(date +%s) + ROLL_TIMEOUT )) cur=""
  while (( $(date +%s) < deadline )); do
    reconcile gitrepository "$GITREPO"; reconcile kustomization "$(platform_ks)"
    cur=$(deployed_backend_tag)
    if [[ "$cur" == "$want" ]]; then
      local ready
      ready=$(kctl -n platform get deploy platform-api -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo 0)
      if [[ "${ready:-0}" -ge 1 ]]; then
        local code
        code=$(curl -sk -o /dev/null -w '%{http_code}' "$ADMIN_HOST/api/v1/healthz" 2>/dev/null || echo 000)
        [[ "$code" == "200" ]] && { echo "$cur"; return 0; }
      fi
    fi
    sleep 15
  done
  echo "$cur"; return 1
}

platform_ks() { echo "$KS_NAME"; }

ORIGINAL_REF=""   # JSON of the source's ref at start — restored on exit
restore_original_ref() {
  [[ -z "$ORIGINAL_REF" || -z "$GITREPO" ]] && return 0
  log "TEARDOWN: restoring $GITREPO ref → $ORIGINAL_REF"
  # REPLACE the whole spec.ref — a merge-patch of {ref:{semver:…}} would leave
  # the setup-added `tag` in place (giving a malformed {semver,tag} ref that
  # pins the OLD version). A JSON `replace` op swaps the entire ref for exactly
  # the captured original.
  kctl -n flux-system patch gitrepository "$GITREPO" --type=json \
    -p "[{\"op\":\"replace\",\"path\":\"/spec/ref\",\"value\":$ORIGINAL_REF}]" >/dev/null 2>&1 || true
  reconcile gitrepository "$GITREPO"; reconcile kustomization "$(platform_ks)"
}
trap restore_original_ref EXIT

# ── Phase 1: Auth ──────────────────────────────────────────────────────────
phase "Phase 1: Authenticating as super_admin"
TOKEN=""
if [[ -f "$(dirname "${BASH_SOURCE[0]}")/integration-token.sh" ]]; then
  source "$(dirname "${BASH_SOURCE[0]}")/integration-token.sh"
  TOKEN="$(get_admin_token 2>/dev/null || true)"
fi
if [[ -z "${TOKEN:-}" ]]; then
  TR=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" -H 'Content-Type: application/json' \
       -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" || true)
  TOKEN=$(echo "$TR" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null || true)
fi
[[ -n "${TOKEN:-}" ]] || { echo "ERROR: login failed" >&2; exit 2; }
ok "Authenticated"
api() {
  local m="$1" p="$2" b="${3:-}"
  if [[ -n "$b" ]]; then
    curl -sk -X "$m" "$ADMIN_HOST$p" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary "$b" -w "\nHTTP_STATUS=%{http_code}"
  else
    curl -sk -X "$m" "$ADMIN_HOST$p" -H "Authorization: Bearer $TOKEN" -w "\nHTTP_STATUS=%{http_code}"
  fi
}
status_of() { echo "$1" | sed -n 's/.*HTTP_STATUS=\([0-9]*\).*/\1/p' | tail -1; }

resolve_gitrepo || { echo "ERROR: could not resolve the platform GitRepository" >&2; exit 2; }
ORIGINAL_REF=$(kctl -n flux-system get gitrepository "$GITREPO" -o jsonpath='{.spec.ref}' 2>/dev/null | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)))" 2>/dev/null || echo '')
START_VERSION=$(deployed_backend_tag)
log "source=$GITREPO  original-ref=$ORIGINAL_REF  starting-version=$START_VERSION"
[[ -n "$ORIGINAL_REF" ]] || { echo "ERROR: could not capture original ref (refusing to run without a restore target)" >&2; exit 2; }

# ── Phase 2: Detection ─────────────────────────────────────────────────────
phase "Phase 2: Detection (version-poller → available_version)"
kctl -n platform get cronjob version-poller >/dev/null 2>&1 && ok "version-poller CronJob exists" || fail "version-poller CronJob missing"
kctl -n platform delete job version-poller-itest --ignore-not-found >/dev/null 2>&1 || true
if kctl -n platform create job version-poller-itest --from=cronjob/version-poller >/dev/null 2>&1; then
  pj=""; poll_succ=0; poll_fail=0
  for _ in $(seq 1 24); do
    # k8s 1.36 marks a successful Job with a SuccessCriteriaMet condition (and
    # later Complete); a failure with Failed. `.status.succeeded>=1` is the
    # version-independent success signal. (No `local` here — this loop runs in
    # the main script body, not a function.)
    poll_succ=$(kctl -n platform get job version-poller-itest -o jsonpath='{.status.succeeded}' 2>/dev/null || echo 0)
    poll_fail=$(kctl -n platform get job version-poller-itest -o jsonpath='{.status.failed}' 2>/dev/null || echo 0)
    if [[ "${poll_succ:-0}" -ge 1 ]]; then pj="Complete"; break; fi
    if [[ "${poll_fail:-0}" -ge 1 ]]; then pj="Failed"; break; fi
    sleep 5
  done
  [[ "$pj" == "Complete" ]] && ok "poller run completed (securityContext runAsUser fix)" || fail "poller run phase=${pj:-timeout} (securityContext/netpol regression)"
  AV=$(kctl -n platform exec "$(kctl -n platform get pods -l app=platform-api --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')" -- \
       sh -c 'psql "$DATABASE_URL" -tAc "SELECT setting_value FROM platform_settings WHERE setting_key='"'"'available_version'"'"'"' 2>/dev/null | tr -d '[:space:]')
  [[ -n "$AV" ]] && ok "available_version persisted ($AV) — poller reached the DB (netpol fix)" || fail "available_version NOT written — poller could not reach the DB"
  kctl -n platform delete job version-poller-itest --ignore-not-found >/dev/null 2>&1 || true
fi

# ── Phase 3: Preflight API ─────────────────────────────────────────────────
phase "Phase 3: Preflight gate API"
PF=$(api GET /api/v1/admin/platform/upgrade/preflight)
[[ "$(status_of "$PF")" == "200" ]] && ok "preflight → 200" || fail "preflight → $(status_of "$PF")"
echo "$PF" | grep -qiE '"gates?"|"canApply"|"blockers?"|"ok"' && ok "preflight carries gate fields" || fail "preflight body has no gate fields"

# ── Phase 4: Setup — production tag model at $BASE_TAG ──────────────────────
phase "Phase 4: Setup — re-pin source to $BASE_TAG (production tag model)"
kctl -n flux-system patch gitrepository "$GITREPO" --type=merge \
  -p "{\"spec\":{\"ref\":{\"tag\":\"$BASE_TAG\",\"branch\":null,\"commit\":null,\"semver\":null}}}" >/dev/null 2>&1 || true
log "waiting for platform to roll to ${BASE_TAG#v} (≤${ROLL_TIMEOUT}s)…"
if got=$(wait_for_version "${BASE_TAG#v}"); then
  ok "platform running ${BASE_TAG#v} + healthy (setup floor reached)"
else
  fail "setup roll to ${BASE_TAG#v} did not converge (stuck at '$got')"
  phase "Summary"; echo "  passed:$PASSED failed:$FAILED"; printf '  ✗ %s\n' "${FAILURES[@]}"; exit 1
fi

# ── Phase 5: REAL forward upgrade via the operator endpoint ─────────────────
phase "Phase 5: REAL apply — POST /admin/platform/upgrade → $TARGET_VERSION"
AP=$(api POST /api/v1/admin/platform/upgrade "{\"version\":\"$TARGET_VERSION\",\"apply\":true}")
apc=$(status_of "$AP")
if [[ "$apc" == "200" || "$apc" == "202" ]]; then
  ok "apply accepted ($apc) — rescue snapshot taken + Flux source re-pinned"
else
  fail "apply → $apc :: $(echo "$AP" | head -c 200)"
fi
NEW_TAG=$(kctl -n flux-system get gitrepository "$GITREPO" -o jsonpath='{.spec.ref.tag}' 2>/dev/null || true)
[[ "$NEW_TAG" == "$TARGET_TAG" ]] && ok "GitRepository spec.ref.tag re-pinned → $TARGET_TAG" || fail "ref.tag not moved (got '$NEW_TAG')"
log "waiting for the REAL platform roll to $TARGET_VERSION (≤${ROLL_TIMEOUT}s)…"
if got=$(wait_for_version "$TARGET_VERSION"); then
  ok "platform ROLLED to $TARGET_VERSION + healthy (real Flux redeploy)"
  RI=$(api GET /api/v1/auth/runtime-info)
  echo "$RI" | grep -q "\"version\":\"$TARGET_VERSION\"" && ok "runtime-info reports $TARGET_VERSION" || log "runtime-info: $(echo "$RI" | head -c 120)"
else
  fail "platform did not converge on $TARGET_VERSION (stuck at '$got')"
fi

# ── Phase 6: REAL rollback via the operator endpoint ───────────────────────
phase "Phase 6: REAL rollback — POST /admin/platform/rollback"
RB=$(api POST /api/v1/admin/platform/rollback '{"apply":true}')
rbc=$(status_of "$RB")
[[ "$rbc" == "200" || "$rbc" == "202" ]] && ok "rollback accepted ($rbc)" || fail "rollback → $rbc :: $(echo "$RB" | head -c 200)"
BACK_TAG=$(kctl -n flux-system get gitrepository "$GITREPO" -o jsonpath='{.spec.ref.tag}' 2>/dev/null || true)
[[ "$BACK_TAG" == "$BASE_TAG" ]] && ok "ref.tag restored → $BASE_TAG (previous ref)" || fail "rollback ref not restored (got '$BACK_TAG')"
log "waiting for the platform to roll back to ${BASE_TAG#v} (≤${ROLL_TIMEOUT}s)…"
if got=$(wait_for_version "${BASE_TAG#v}"); then
  ok "platform ROLLED BACK to ${BASE_TAG#v} + healthy"
else
  fail "rollback roll did not converge (stuck at '$got')"
fi

# ── Phase 7: RBAC ──────────────────────────────────────────────────────────
phase "Phase 7: RBAC on the apply endpoint"
UN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/admin/platform/upgrade" -H 'Content-Type: application/json' \
     -d '{"version":"2026.7.9","apply":false}' -w "\nHTTP_STATUS=%{http_code}")
case "$(status_of "$UN")" in 401|403) ok "unauthenticated apply → $(status_of "$UN")";; *) fail "unauthenticated apply → $(status_of "$UN")";; esac

# ── Summary (teardown runs on EXIT, restoring the original ref) ─────────────
phase "Summary"
echo "  passed: $PASSED   failed: $FAILED   (source restored to original ref on exit)"
if (( FAILED > 0 )); then printf '  \033[31m✗ %s\033[0m\n' "${FAILURES[@]}"; exit 1; fi
echo -e "  \033[32mintegration-platform-upgrade: PASS\033[0m"
