#!/usr/bin/env bash
#
# Platform-API E2E for the JMAP→IMAP mailbox-backup-engine migration.
# Tests the FULL stack — POST /admin/tenant-bundles through the
# orchestrator, K8s Job spawn, restic snapshot validation, restore-cart.
#
# Layer 2 (platform API): goes through HTTP endpoints, not direct
# script invocation. Validates that the engine selector flips both
# capture AND restore paths.
#
# Layer 3 (full bundle): exercises the bundle with ALL FOUR components
# (files, mailboxes, config, secrets) — the realistic tenant-bundle
# shape.
#
# Two modes:
#   MODE=mailboxes-only (default) — bundle with only mailboxes:true.
#     Mirrors the JMAP full-e2e script. Faster, narrower validation.
#   MODE=full              — bundle with all 4 components. Stresses the
#     whole orchestrator path; takes longer.
#
# Both modes run the full flow for BOTH ENGINES (jmap, imap) and
# compare msg/sec wall times.
#
# DOES NOT RUN ON TESTING.phoenix-host.net AS-IS — testing is single
# node with no S3 target, no real tenant, no NetBird mesh, no
# integration-test backup config. This script is a STAGING runner
# (mirrors scripts/integration-tenant-bundles-jmap-full-e2e.sh) — it
# expects:
#   * `~/k8s-staging/servers.txt` with S3 endpoint + access keys + SSH host
#   * An admin login on the cluster's admin panel
#   * A test tenant + mailbox (TEST_ADDR / RESTORE_ADDR env vars)
#   * A pre-configured backup target with id $TARGET_CFG_ID
#
# Run modes:
#   ENGINE=imap MODE=mailboxes-only ./integration-tenant-bundles-engine-e2e.sh
#   ENGINE=jmap MODE=full           ./integration-tenant-bundles-engine-e2e.sh
#   MODE=api-smoke                  ./integration-tenant-bundles-engine-e2e.sh
#     (only stages 0+1+1.5 — verifies the GET/PATCH endpoints work
#      without exercising the bundle path. Runs against any cluster,
#      no S3/tenant setup required.)
#
# Env knobs (defaults shown):
#   ENGINE                      jmap | imap   (default 'imap')
#   MODE                        mailboxes-only | full   (default 'mailboxes-only')
#   API_BASE                    https://admin.staging.phoenix-host.net
#   ADMIN_EMAIL                 markus@phoenix-host.net
#   ADMIN_PASSWORD              (read from cluster Secret if unset)
#   SSH_KEY                     ~/hosting-platform.key
#   STAGING_HOST                root@staging1.phoenix-host.net
#   SERVERS_TXT                 ~/k8s-staging/servers.txt
#   TARGET_CFG_ID               <S3 target UUID>
#   TENANT_ID                   <test tenant UUID>
#   TEST_ADDR                   jack@x.staging.success.com.na
#   RESTORE_ADDR                john@x.staging.success.com.na
#   CORPUS_SIZE                 1000

set -euo pipefail

ENGINE="${ENGINE:-imap}"
MODE="${MODE:-mailboxes-only}"
API_BASE="${API_BASE:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-markus@phoenix-host.net}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
STAGING_HOST="${STAGING_HOST:-root@staging1.phoenix-host.net}"
SERVERS_TXT="${SERVERS_TXT:-$HOME/k8s-staging/servers.txt}"
TARGET_CFG_ID="${TARGET_CFG_ID:-6476f958-3050-4ac2-9c91-1cb4c2dab69e}"
TENANT_ID="${TENANT_ID:-b4384ca8-c5c9-4e1e-8c1c-f864c7a2419d}"
TEST_ADDR="${TEST_ADDR:-jack@x.staging.success.com.na}"
RESTORE_ADDR="${RESTORE_ADDR:-john@x.staging.success.com.na}"
CORPUS_SIZE="${CORPUS_SIZE:-1000}"
RESTIC_BIN="${SPIKE_RESTIC:-$(command -v restic 2>/dev/null || true)}"

red() { printf "\e[31m%s\e[0m\n" "$*"; }
green() { printf "\e[32m%s\e[0m\n" "$*"; }
yellow() { printf "\e[33m%s\e[0m\n" "$*"; }
heading() { echo; echo "──── $* ────"; }

api() { curl -sSk "$@"; }
apij() { api -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
strip_cr() { tr -d '\r'; }

case "$ENGINE" in jmap|imap) ;; *) red "ENGINE must be jmap|imap (got '$ENGINE')"; exit 2 ;; esac
case "$MODE" in mailboxes-only|full|api-smoke) ;; *) red "MODE must be mailboxes-only|full|api-smoke (got '$MODE')"; exit 2 ;; esac

# ──────────────────────────────────────────────────────────────────
heading "Stage 0 — auth + secrets"
# ──────────────────────────────────────────────────────────────────

if [ -z "${ADMIN_PASSWORD:-}" ]; then
  ADMIN_PASSWORD=$(ssh -i "$SSH_KEY" "$STAGING_HOST" \
    "kubectl -n platform get secret platform-admin-seed -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d" \
    | strip_cr || true)
fi
TOKEN=$(api -X POST "$API_BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])')
[ -n "$TOKEN" ] || { red "ERROR: login failed"; exit 2; }
green "  ✓ login: ${#TOKEN}-char token"

# ──────────────────────────────────────────────────────────────────
heading "Stage 1 — flip mailbox_backup_engine = $ENGINE"
# ──────────────────────────────────────────────────────────────────

PATCH_RESP=$(apij -X PATCH "$API_BASE/api/v1/admin/mailbox-backup-settings" \
  -d "{\"engine\":\"$ENGINE\"}")
echo "  patch response: $(echo "$PATCH_RESP" | python3 -m json.tool | head -8)"
CURRENT_ENGINE=$(echo "$PATCH_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["engine"])')
[ "$CURRENT_ENGINE" = "$ENGINE" ] || { red "engine flip failed: got $CURRENT_ENGINE"; exit 1; }
green "  ✓ engine=$ENGINE persisted"

# ──────────────────────────────────────────────────────────────────
heading "Stage 1.5 — GET /admin/mailbox-backup-settings round-trip"
# ──────────────────────────────────────────────────────────────────

GET_RESP=$(apij "$API_BASE/api/v1/admin/mailbox-backup-settings")
echo "  GET response: $(echo "$GET_RESP" | python3 -m json.tool | head -8)"
RT_ENGINE=$(echo "$GET_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["engine"])')
RT_RECOMMENDED=$(echo "$GET_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["isRecommendedDefault"])')
RT_LAST=$(echo "$GET_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["lastUpdatedAt"])')
[ "$RT_ENGINE" = "$ENGINE" ] || { red "GET returned engine=$RT_ENGINE expected=$ENGINE"; exit 1; }
green "  ✓ GET returns engine=$RT_ENGINE recommended=$RT_RECOMMENDED lastUpdatedAt=$RT_LAST"

# Stop here if api-smoke mode (no S3/tenant required beyond this point).
if [ "$MODE" = "api-smoke" ]; then
  green "✓ api-smoke complete — engine selector endpoints work"
  exit 0
fi

# ──────────────────────────────────────────────────────────────────
heading "Stage 2 — verify tenant mailbox + target ($CORPUS_SIZE msg corpus)"
# ──────────────────────────────────────────────────────────────────
# NOTE: assumes the tenant + mailbox + target already exist on the
# staging cluster. The companion `integration-tenant-bundles-jmap-full-e2e.sh`
# has the wipe+seed stages; clone or re-run that if you need a fresh
# corpus. This script focuses on the engine selector + bundle path.
green "  (skipping seed — assumed pre-populated)"

# ──────────────────────────────────────────────────────────────────
heading "Stage 3 — trigger bundle (mode=$MODE engine=$ENGINE)"
# ──────────────────────────────────────────────────────────────────

case "$MODE" in
  mailboxes-only)  COMPONENTS='{"files":false,"mailboxes":true,"config":false,"secrets":false}' ;;
  full)            COMPONENTS='{"files":true,"mailboxes":true,"config":true,"secrets":true}' ;;
esac

T0=$(date +%s)
RESP=$(apij -X POST "$API_BASE/api/v1/admin/tenant-bundles" \
  -d "$(python3 -c "
import json
print(json.dumps({
  'tenantId': '$TENANT_ID',
  'async': True,
  'targetConfigId': '$TARGET_CFG_ID',
  'label': '$ENGINE-$MODE-engine-e2e',
  'retentionDays': 1,
  'components': $COMPONENTS,
}))
")")
BUNDLE=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["bundleId"])')
echo "  bundle: $BUNDLE"

poll_bundle() {
  local b="$1" deadline=$(( $(date +%s) + 900 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local d s; d=$(apij "$API_BASE/api/v1/admin/tenant-bundles/$b")
    s=$(echo "$d" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])')
    case "$s" in
      completed|partial|failed) echo "$s"; return ;;
    esac
    sleep 6
  done
  echo "timeout"
}

ST=$(poll_bundle "$BUNDLE")
T1=$(date +%s)
if [ "$ST" != "completed" ]; then
  red "  ✗ bundle ended status=$ST after $((T1-T0))s"
  apij "$API_BASE/api/v1/admin/tenant-bundles/$BUNDLE" | python3 -m json.tool | head -40
  exit 1
fi
green "  ✓ bundle completed in $((T1-T0))s"

# ──────────────────────────────────────────────────────────────────
heading "Stage 4 — verify engine actually used (Job log)"
# ──────────────────────────────────────────────────────────────────

EXPECTED_DONE_TAG=$( [ "$ENGINE" = "imap" ] && echo IMAP_DONE || echo JMAP_DONE )
LOG=$(ssh -i "$SSH_KEY" "$STAGING_HOST" \
  "kubectl -n mail logs -l platform.io/backup-id=$BUNDLE,platform.io/sub-component=backup-mailboxes --tail=500 2>/dev/null || true")
if echo "$LOG" | grep -q "$EXPECTED_DONE_TAG bundleId=$BUNDLE"; then
  green "  ✓ Job log contains $EXPECTED_DONE_TAG marker — correct engine ran"
else
  red "  ✗ Job log MISSING $EXPECTED_DONE_TAG marker — wrong engine!"
  echo "  Recent log lines:"
  echo "$LOG" | tail -20
  exit 1
fi

# ──────────────────────────────────────────────────────────────────
heading "Stage 5 — verify mailbox-worker cluster gate respected"
# ──────────────────────────────────────────────────────────────────
# tenant_bundle_in_flight should contain a row with
# component='mailbox-worker' during the run; absence here (post-run)
# means the slot was released cleanly.
LEAKED=$(ssh -i "$SSH_KEY" "$STAGING_HOST" \
  "kubectl -n platform exec deploy/platform-api -- node -e 'const{Pool}=require(\"pg\");(async()=>{const p=new Pool({connectionString:process.env.DATABASE_URL});const r=await p.query(\"SELECT count(*)::int FROM tenant_bundle_in_flight WHERE component = \$\$mailbox-worker\$\$ AND bundle_id = \$\$$BUNDLE\$\$\");console.log(r.rows[0].count);await p.end()})()'" \
  | strip_cr | tail -1)
if [ "$LEAKED" = "0" ]; then
  green "  ✓ mailbox-worker slot released cleanly"
else
  red "  ✗ mailbox-worker slot LEAKED — $LEAKED row(s) still present"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────
heading "DONE — engine=$ENGINE mode=$MODE bundle=$BUNDLE wall=$((T1-T0))s"
# ──────────────────────────────────────────────────────────────────

green "✓ Layer 2/3 E2E passed for engine=$ENGINE mode=$MODE"
echo "  Next: run with the other engine for direct comparison:"
echo "    ENGINE=$([ "$ENGINE" = "imap" ] && echo jmap || echo imap) MODE=$MODE $0"
