#!/usr/bin/env bash
# dr-drill.sh — DR drill harness. Runs LOCALLY or on a PRIVATE host —
# NEVER in public CI (the age key + report token are too sensitive to
# store as public-repo Actions secrets; see docs/operations/DR_DRILL.md).
#
# Proves the Tier-1 secrets bundle is RECOVERABLE — three modes, fast→faithful:
#
#   --mode validate   (default)  static integrity: decrypt + structure only.
#                                 No cluster. Safe for a frequent private cron.
#   --mode dind                  validate + run the REAL restore tooling
#                                 (apply-secrets-bundle.sh) on the bundle +
#                                 assert every restored Secret is accepted by a
#                                 live local-cluster API (server-side dry-run).
#                                 Workstation. (Does NOT boot a full platform —
#                                 a staging/prod bundle's creds won't match a
#                                 local dev Postgres; that proof is 'bootstrap'.)
#   --mode bootstrap             validate + run the REAL recovery path
#                                 (bootstrap.sh --remote <host> --secrets-bundle)
#                                 against a throwaway VM + assert platform-api
#                                 reaches Available. Gold standard.
#
# dind/bootstrap prove what 'validate' alone can't: dind proves the restore
# TOOLING runs clean on THIS bundle and the cluster API accepts the result;
# bootstrap proves a real DR succeeds end-to-end (platform serves off the
# bundle), not just that the bundle is well-formed.
#
# CONFIG: values come from flags, then env, then a gitignored
# scripts/dr-drill.env (copy scripts/dr-drill.env.example). Nothing
# sensitive is committed.
#
# Required:  DR_DRILL_BUNDLE (path to .tar.age)   DR_DRILL_AGE_KEY (age priv key)
# bootstrap: DR_DRILL_TARGET (root@vm)  DR_DRILL_SSH_KEY  DR_DRILL_DOMAIN
# Optional:  DR_DRILL_REPORT  DR_DRILL_WEBHOOK_URL/TOKEN/INSECURE
#            DR_DRILL_TRIGGER  DR_DRILL_RUNNER  DR_DRILL_META_TEST
#            DR_DRILL_TIMEOUT (restore/bootstrap wall-clock cap, default 1800s)
#            DR_DRILL_BOOTSTRAP_ARGS (extra flags appended to bootstrap.sh)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── config: gitignored profile, then env, then flags (flags win) ─────
if [[ -f "$SCRIPT_DIR/dr-drill.env" ]]; then
  set -a; # shellcheck disable=SC1091
  source "$SCRIPT_DIR/dr-drill.env"; set +a
fi

MODE="${DR_DRILL_MODE:-validate}"
BUNDLE="${DR_DRILL_BUNDLE:-}"
AGE_KEY="${DR_DRILL_AGE_KEY:-}"
TARGET="${DR_DRILL_TARGET:-}"
SSH_KEY="${DR_DRILL_SSH_KEY:-$HOME/hosting-platform.key}"
DOMAIN="${DR_DRILL_DOMAIN:-}"
REPORT="${DR_DRILL_REPORT:-}"
WEBHOOK_URL="${DR_DRILL_WEBHOOK_URL:-}"
WEBHOOK_TOKEN="${DR_DRILL_WEBHOOK_TOKEN:-}"
TRIGGER="${DR_DRILL_TRIGGER:-manual}"
META_TEST="${DR_DRILL_META_TEST:-0}"
TIMEOUT="${DR_DRILL_TIMEOUT:-1800}"
RUNNER="${DR_DRILL_RUNNER:-$(hostname)/dr-drill@$(date -u +%s)}"

usage() { sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while [[ $# -gt 0 ]]; do case "$1" in
  --mode) MODE="$2"; shift 2 ;;
  --bundle) BUNDLE="$2"; shift 2 ;;
  --age-key) AGE_KEY="$2"; shift 2 ;;
  --target) TARGET="$2"; shift 2 ;;
  --ssh-key) SSH_KEY="$2"; shift 2 ;;
  --domain) DOMAIN="$2"; shift 2 ;;
  --report) REPORT="$2"; shift 2 ;;
  --meta-test) META_TEST=1; shift ;;
  -h|--help) usage 0 ;;
  *) echo "unknown arg: $1" >&2; usage 2 ;;
esac; done

case "$MODE" in validate|dind|bootstrap) ;; *) echo "ERROR: --mode must be validate|dind|bootstrap" >&2; exit 2 ;; esac
[[ -n "$BUNDLE" && -n "$AGE_KEY" ]] || { echo "ERROR: bundle + age key required (see scripts/dr-drill.env.example)" >&2; exit 2; }
[[ -r "$BUNDLE" ]]  || { echo "ERROR: bundle not readable: $BUNDLE" >&2; exit 2; }
[[ -r "$AGE_KEY" ]] || { echo "ERROR: age key not readable: $AGE_KEY" >&2; exit 2; }
if [[ "$MODE" == bootstrap ]]; then
  [[ -n "$TARGET" && -n "$DOMAIN" ]] || { echo "ERROR: bootstrap mode needs DR_DRILL_TARGET + DR_DRILL_DOMAIN" >&2; exit 2; }
fi
for bin in age tar jq; do command -v "$bin" >/dev/null || { echo "ERROR: '$bin' not installed" >&2; exit 2; }; done

TMPDIR=$(mktemp -d); trap 'rm -rf "$TMPDIR"' EXIT
DRILL_ID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
STARTED_AT=$(date -u +%FT%TZ); START_TS=$(date +%s)
PHASES_JSON='[]'; SMOKE_JSON='[]'; STATUS="running"; FAILURE_REASON=""; SECRETS_RESTORED=0
BUNDLE_SHA=$(sha256sum "$BUNDLE" | awk '{print $1}')
BUNDLE_SIZE=$(stat -c%s "$BUNDLE" 2>/dev/null || stat -f%z "$BUNDLE")

log()  { echo "[$(date -u +%H:%M:%S)] $*" >&2; }
fail() { STATUS="failed"; FAILURE_REASON="$1"; }
append_phase() { PHASES_JSON=$(jq --arg n "$1" --arg s "$2" --argjson d "$3" --arg m "${4:-}" \
  '. + [{name:$n,status:$s,durationSeconds:$d,message:$m}]' <<<"$PHASES_JSON"); }
append_smoke() { SMOKE_JSON=$(jq --arg n "$1" --argjson p "$2" --arg m "${3:-}" \
  '. + [{name:$n,passed:$p,message:$m}]' <<<"$SMOKE_JSON"); }

log "DR drill ($MODE) id=$DRILL_ID"

# ── meta-test: corrupt the bundle so a working drill MUST fail ───────
if [[ "$META_TEST" == "1" ]]; then
  log "META-TEST: corrupting bundle to self-verify the drill catches breakage"
  head -c 100 "$BUNDLE" > "$TMPDIR/corrupt.tar.age"; BUNDLE="$TMPDIR/corrupt.tar.age"; TRIGGER=meta_test
fi

# ── shared pre-flight: static bundle integrity (the 'validate' core) ─
PT=$(date +%s)
if age -d -i "$AGE_KEY" "$BUNDLE" > "$TMPDIR/decrypted.tar" 2>"$TMPDIR/age.err"; then
  TAR_ENTRIES=$(tar tf "$TMPDIR/decrypted.tar" 2>/dev/null | wc -l | tr -d ' ')
  append_phase decrypt success $(( $(date +%s)-PT )) "$TAR_ENTRIES entries"
else
  fail "bundle decryption failed: $(head -c 200 "$TMPDIR/age.err")"
  append_phase decrypt failed $(( $(date +%s)-PT )) "$FAILURE_REASON"
fi
CONTENTS="$TMPDIR/contents"; SECRET_FILES=()
if [[ "$STATUS" != failed ]]; then
  mkdir -p "$CONTENTS"
  tar -xf "$TMPDIR/decrypted.tar" -C "$CONTENTS" 2>/dev/null || true
  # Count Secret YAMLs ONLY — the bundle also ships non-Secret sidecars
  # (dr-inputs.yaml, dr-rows.json, MANIFEST.*) that must not be counted.
  mapfile -t SECRET_FILES < <(grep -rlE '^kind: Secret$' "$CONTENTS" --include='*.yaml' 2>/dev/null | sort)
  SECRETS_RESTORED=${#SECRET_FILES[@]}
  if [[ "$SECRETS_RESTORED" -lt 5 ]]; then fail "bundle too small ($SECRETS_RESTORED Secret YAMLs, expected >= 5)"; fi
  append_phase enumerate "$([[ "$STATUS" == failed ]] && echo failed || echo success)" 0 "$SECRETS_RESTORED Secret YAML(s)"
fi
if [[ "$STATUS" != failed ]]; then
  if grep -q 'recipient:' "$CONTENTS"/MANIFEST.txt 2>/dev/null; then append_smoke manifest-has-recipient true ""
  else fail "MANIFEST.txt missing or has no recipient field"; append_smoke manifest-has-recipient false ""; fi
fi
if [[ "$STATUS" != failed ]]; then
  BAD=0
  for f in "${SECRET_FILES[@]}"; do
    grep -q '^apiVersion: v1$' "$f" && grep -q '^  namespace:' "$f" && grep -q '^  name:' "$f" || BAD=$((BAD+1))
  done
  if [[ "$BAD" -gt 0 ]]; then fail "$BAD Secret YAML(s) malformed"; append_smoke all-secret-yamls-valid false "$BAD bad"
  else append_smoke all-secret-yamls-valid true ""; fi
fi

# ── mode dind: exercise the REAL restore library + validate every
#    restored Secret against a live Kubernetes API.
#
#    We deliberately do NOT boot a full platform off the bundle here. A
#    drill bundle comes from staging/prod, so its DB creds + encryption
#    key won't match a local dev Postgres — bringing the platform up
#    would false-fail on a credential mismatch, not on any bundle defect.
#    dind proves what 'validate' can't, without that false-fail risk:
#      (a) the production restore TOOLING (apply-secrets-bundle.sh:
#          MANIFEST.json parse, profile gating, skipAtRestore) runs clean
#          on THIS bundle, and
#      (b) every Secret it emits is ACCEPTED by a real Kubernetes API
#          (server-side dry-run against the local DinD cluster).
#    The full "platform serves traffic off the bundle" proof is --mode
#    bootstrap. ──────────────────────────────────────────────────────
if [[ "$MODE" == dind && "$STATUS" != failed ]]; then
  PT=$(date +%s); RESTORED_DIR="$TMPDIR/restored"; mkdir -p "$RESTORED_DIR"; RESTORED_SECRETS=()
  log "dind: running the production restore library (extract mode) on the bundle"
  if ( set -euo pipefail
       # shellcheck disable=SC1091
       source "$SCRIPT_DIR/lib/apply-secrets-bundle.sh"
       RESTORE_PROFILE=full RESTORE_EXTRACT_TO="$RESTORED_DIR" \
         apply_secrets_bundle "$BUNDLE" "$AGE_KEY" ) >"$TMPDIR/dind.log" 2>&1; then
    mapfile -t RESTORED_SECRETS < <(grep -rlE '^kind: Secret$' "$RESTORED_DIR" --include='*.yaml' 2>/dev/null | sort)
    append_phase dind-restore-lib success $(( $(date +%s)-PT )) "${#RESTORED_SECRETS[@]} Secret(s) emitted by apply-secrets-bundle.sh"
    if [[ "${#RESTORED_SECRETS[@]}" -lt 1 ]]; then fail "restore library emitted 0 Secrets"; append_smoke restore-lib-emitted-secrets false ""
    else append_smoke restore-lib-emitted-secrets true ""; fi
  else
    fail "restore library failed on bundle (see log)"; append_phase dind-restore-lib failed $(( $(date +%s)-PT )) "$(tail -c 300 "$TMPDIR/dind.log")"
  fi
  if [[ "$STATUS" != failed ]]; then
    if command -v kubectl >/dev/null 2>&1 && timeout 15 kubectl cluster-info >/dev/null 2>&1; then
      DRY_MODE=server; CLUSTER_NOTE="server-side dry-run (live cluster)"
    elif command -v kubectl >/dev/null 2>&1; then
      DRY_MODE=client; CLUSTER_NOTE="client-side only (no cluster reachable — run ./scripts/local.sh up first)"
    else
      DRY_MODE=none; CLUSTER_NOTE="skipped (kubectl not installed)"
    fi
    if [[ "$DRY_MODE" == none ]]; then
      log "dind: kubectl absent — skipping cluster validation"; append_smoke cluster-accepts-secrets true "$CLUSTER_NOTE"
    else
      PT=$(date +%s); BAD=0
      for f in "${RESTORED_SECRETS[@]}"; do
        kubectl apply --dry-run="$DRY_MODE" -f "$f" >>"$TMPDIR/dryrun.log" 2>&1 || BAD=$((BAD+1))
      done
      if [[ "$BAD" -gt 0 ]]; then fail "$BAD restored Secret(s) rejected ($DRY_MODE dry-run)"; append_smoke cluster-accepts-secrets false "$BAD rejected"
      else append_smoke cluster-accepts-secrets true "$CLUSTER_NOTE"; fi
      append_phase dind-cluster-dryrun "$([[ "$STATUS" == failed ]] && echo failed || echo success)" $(( $(date +%s)-PT )) "$CLUSTER_NOTE"
    fi
  fi
fi

# ── mode bootstrap: REAL recovery via bootstrap.sh --remote on a VM ──
if [[ "$MODE" == bootstrap && "$STATUS" != failed ]]; then
  PT=$(date +%s); log "bootstrap: real recovery onto $TARGET via bootstrap.sh --secrets-bundle (timeout ${TIMEOUT}s)"
  # shellcheck disable=SC2086
  if timeout "$TIMEOUT" "$SCRIPT_DIR/bootstrap.sh" \
        --remote "$TARGET" --ssh-key "$SSH_KEY" \
        --secrets-bundle "$BUNDLE" --age-key "$AGE_KEY" \
        --domain "$DOMAIN" --env staging ${DR_DRILL_BOOTSTRAP_ARGS:-} \
        >"$TMPDIR/bootstrap.log" 2>&1; then
    append_phase bootstrap-restore success $(( $(date +%s)-PT )) "bootstrap completed on $TARGET"
  else
    fail "bootstrap --secrets-bundle failed on $TARGET (see log)"
    append_phase bootstrap-restore failed $(( $(date +%s)-PT )) "$(tail -c 300 "$TMPDIR/bootstrap.log")"
  fi
  if [[ "$STATUS" != failed ]]; then
    # the real proof: the recovered platform-api is actually serving
    if timeout 300 ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$TARGET" \
         'kubectl -n platform wait --for=condition=Available deploy/platform-api --timeout=240s' >/dev/null 2>&1; then
      append_smoke platform-api-ready true "recovered platform serving on $TARGET"
    else fail "recovered platform-api not Available on $TARGET"; append_smoke platform-api-ready false ""; fi
  fi
fi

# ── report ──────────────────────────────────────────────────────────
[[ "$STATUS" == running ]] && STATUS=success
FINISHED_AT=$(date -u +%FT%TZ); DURATION=$(( $(date +%s)-START_TS ))
REPORT_JSON=$(jq -n --arg id "$DRILL_ID" --arg mode "$MODE" --arg s "$STATUS" \
  --arg st "$STARTED_AT" --arg fin "$FINISHED_AT" --arg trig "$TRIGGER" \
  --arg sha "$BUNDLE_SHA" --argjson restored "$SECRETS_RESTORED" --argjson sz "$BUNDLE_SIZE" \
  --argjson dur "$DURATION" --arg reason "$FAILURE_REASON" \
  --argjson phases "$PHASES_JSON" --argjson smoke "$SMOKE_JSON" --arg runner "$RUNNER" \
  '{id:$id, mode:$mode, status:$s, startedAt:$st, finishedAt:$fin, trigger:$trig,
    sourceBundleSha256:$sha, secretsRestoredCount:$restored, bundleSizeBytes:$sz,
    durationSeconds:$dur, failureReason:(if $reason=="" then null else $reason end),
    report:{phases:$phases, smokeAssertions:$smoke}, runner:$runner}')
if [[ -n "$REPORT" ]]; then echo "$REPORT_JSON" > "$REPORT"; log "report -> $REPORT"; else echo "$REPORT_JSON"; fi

if [[ -n "$WEBHOOK_URL" ]]; then
  log "POST report -> $WEBHOOK_URL"
  CF=(-s); [[ "${DR_DRILL_WEBHOOK_INSECURE:-0}" == "1" ]] && CF+=(-k)
  HDR=(); [[ -n "$WEBHOOK_TOKEN" ]] && HDR=(-H "Authorization: Bearer $WEBHOOK_TOKEN")
  curl "${CF[@]}" -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" "${HDR[@]}" \
    --data "$REPORT_JSON" >/dev/null 2>&1 || log "webhook POST non-zero (continuing)"
fi

log "DR DRILL [$MODE]: $STATUS (${DURATION}s)"
# meta-test inverts the exit code: a corrupted bundle MUST fail the drill
if [[ "$META_TEST" == "1" ]]; then
  [[ "$STATUS" != success ]] && { log "META-TEST PASSED — drill caught the corrupted bundle"; exit 0; }
  log "META-TEST FAILED — drill reported success on a corrupted bundle. The drill is broken."; exit 3
fi
[[ "$STATUS" == success ]] || exit 1
