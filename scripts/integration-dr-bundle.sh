#!/usr/bin/env bash
# integration-dr-bundle.sh — A2 end-to-end verification of the DR
# bundle sidecars (dr-inputs.yaml + dr-rows.json) inside every
# secrets-bundle export.
#
# Verifies:
#   A1. POST /system-backup/secrets/export creates a run.
#   A2. The run completes (status=succeeded) within timeout.
#   A3. The bundle download URL works.
#   B1. The downloaded payload is a valid age ciphertext.
#   B2. age -d -i <operator-private-key> decrypts to a tar archive.
#   C1. The decrypted tar contains MANIFEST.txt + MANIFEST.json
#       (regression — pre-A2 behaviour).
#   C2. The decrypted tar contains dr-inputs.yaml (A2 addition).
#   C3. The decrypted tar contains dr-rows.json (A2 addition).
#   D1. dr-inputs.yaml has drBundleVersion=1 + apexDomain populated.
#   D2. dr-inputs.yaml's mailPortMode is one of haproxy|hostport.
#   D3. dr-inputs.yaml's bundleTopology is one of single|ha.
#   E1. dr-rows.json has drBundleVersion=1.
#   E2. EVERY backup_configurations row in dr-rows.json has
#       readOnly:true (the critical contract — Unit B's importer
#       relies on this).
#   F1. The Critical-Secret list (PLATFORM_ENCRYPTION_KEY +
#       backup-target-key) is present in the tar — checked by
#       grepping for the well-known YAML filenames.
#
# Env:
#   ADMIN_HOST       — defaults to https://admin.staging.example.test
#   ADMIN_EMAIL      — defaults to admin@example.test
#   ADMIN_PASSWORD   — required if no INTEGRATION_TOKEN cache.
#   AGE_KEY_FILE     — path to operator AGE private key (defaults to
#                      ~/k8s-staging/<env>-age.key). REQUIRED for B2+.
#   CURL_INSECURE    — set 1 to ignore TLS errors

set -euo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.staging.example.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
AGE_KEY_FILE="${AGE_KEY_FILE:-$HOME/k8s-staging/staging-age.key}"
CURL_OPTS=(-s --max-time 120)
if [[ "${CURL_INSECURE:-0}" == "1" ]]; then
  CURL_OPTS+=(-k)
fi

# shellcheck disable=SC1090
source "$(dirname "$0")/lib/integration-token.sh"

WORK_DIR=$(mktemp -d -t dr-bundle-XXXXXX)
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

PASS=0
FAIL=0
ok() { echo "  ✅ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $*" >&2; FAIL=$((FAIL + 1)); }

# ─── Auth ───────────────────────────────────────────────────────────
echo "==> Phase A: trigger export run + wait for success"
TOKEN=$(get_integration_token "$ADMIN_HOST" "$ADMIN_EMAIL" "${ADMIN_PASSWORD:-}" "${CURL_OPTS[@]}")
if [[ -z "$TOKEN" ]]; then
  fail "no auth token"
  exit 1
fi

# A1 — POST export
TRIGGER=$(curl "${CURL_OPTS[@]}" -X POST "$ADMIN_HOST/api/v1/system-backup/secrets/export" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reason":"integration-dr-bundle.sh"}')
RUN_ID=$(echo "$TRIGGER" | jq -r '.data.runId // empty')
if [[ -z "$RUN_ID" ]]; then
  fail "POST export did not return runId: $TRIGGER"
  exit 1
fi
ok "A1 export run created: $RUN_ID"

# A2 — Poll until succeeded
DEADLINE=$(( $(date +%s) + 180 ))
STATUS=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
  STATUS=$(curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $TOKEN" \
    "$ADMIN_HOST/api/v1/system-backup/runs/$RUN_ID" | jq -r '.data.status')
  if [[ "$STATUS" == "succeeded" ]]; then break; fi
  if [[ "$STATUS" == "failed" ]]; then
    fail "A2 export failed: $(curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $TOKEN" "$ADMIN_HOST/api/v1/system-backup/runs/$RUN_ID")"
    exit 1
  fi
  sleep 3
done
if [[ "$STATUS" != "succeeded" ]]; then
  fail "A2 export did not reach succeeded in 180s (last=$STATUS)"
  exit 1
fi
ok "A2 export reached status=succeeded"

# A3 — Download URL
DOWNLOAD_URL=$(curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $TOKEN" \
  "$ADMIN_HOST/api/v1/system-backup/runs/$RUN_ID" | jq -r '.data.downloadUrl')
if [[ -z "$DOWNLOAD_URL" || "$DOWNLOAD_URL" == "null" ]]; then
  fail "A3 no downloadUrl in run record"
  exit 1
fi
curl "${CURL_OPTS[@]}" -o "$WORK_DIR/bundle.age" "$DOWNLOAD_URL"
if [[ ! -s "$WORK_DIR/bundle.age" ]]; then
  fail "A3 download produced empty file"
  exit 1
fi
ok "A3 download produced $(stat -c%s "$WORK_DIR/bundle.age") bytes"

# ─── Decrypt ────────────────────────────────────────────────────────
echo "==> Phase B: decrypt + untar"
if ! command -v age >/dev/null 2>&1; then
  fail "B0 'age' binary not found on PATH — install via 'apt-get install age' or download from filippo.io/age"
  exit 1
fi
if [[ ! -f "$AGE_KEY_FILE" ]]; then
  fail "B0 AGE_KEY_FILE not found at $AGE_KEY_FILE"
  exit 1
fi

# B1 — looks like an age file (magic = "age-encryption.org/v1")
if ! head -c 22 "$WORK_DIR/bundle.age" | grep -q "age-encryption.org/v1"; then
  fail "B1 payload does not start with age v1 magic"
  exit 1
fi
ok "B1 payload starts with age v1 magic"

# B2 — decrypt
if ! age -d -i "$AGE_KEY_FILE" -o "$WORK_DIR/bundle.tar" "$WORK_DIR/bundle.age"; then
  fail "B2 age decrypt failed"
  exit 1
fi
ok "B2 age decrypt produced tar"

# Untar to work dir
mkdir -p "$WORK_DIR/contents"
tar -xf "$WORK_DIR/bundle.tar" -C "$WORK_DIR/contents"

# ─── Sidecar presence ───────────────────────────────────────────────
echo "==> Phase C: sidecar presence"
for f in MANIFEST.txt MANIFEST.json; do
  if [[ -s "$WORK_DIR/contents/$f" ]]; then
    ok "C1 $f present"
  else
    fail "C1 $f missing or empty"
  fi
done
for f in dr-inputs.yaml dr-rows.json; do
  if [[ -s "$WORK_DIR/contents/$f" ]]; then
    ok "C2/C3 $f present"
  else
    fail "C2/C3 $f missing or empty"
  fi
done

# ─── dr-inputs.yaml content ─────────────────────────────────────────
echo "==> Phase D: dr-inputs.yaml content"
if ! command -v yq >/dev/null 2>&1; then
  echo "  (skip D: yq not installed — apt-get install yq)" >&2
else
  VERSION=$(yq -r '.drBundleVersion' "$WORK_DIR/contents/dr-inputs.yaml")
  if [[ "$VERSION" == "1" ]]; then ok "D1 drBundleVersion=1"; else fail "D1 drBundleVersion=$VERSION (expected 1)"; fi
  APEX=$(yq -r '.apexDomain' "$WORK_DIR/contents/dr-inputs.yaml")
  if [[ -n "$APEX" && "$APEX" != "null" ]]; then ok "D1 apexDomain=$APEX"; else fail "D1 apexDomain empty"; fi
  MODE=$(yq -r '.mailPortMode' "$WORK_DIR/contents/dr-inputs.yaml")
  case "$MODE" in
    haproxy|hostport) ok "D2 mailPortMode=$MODE" ;;
    *) fail "D2 mailPortMode=$MODE (expected haproxy|hostport)" ;;
  esac
  TOPO=$(yq -r '.bundleTopology' "$WORK_DIR/contents/dr-inputs.yaml")
  case "$TOPO" in
    single|ha) ok "D3 bundleTopology=$TOPO" ;;
    *) fail "D3 bundleTopology=$TOPO (expected single|ha)" ;;
  esac
fi

# ─── dr-rows.json content ───────────────────────────────────────────
echo "==> Phase E: dr-rows.json content"
VERSION=$(jq -r '.drBundleVersion' "$WORK_DIR/contents/dr-rows.json")
if [[ "$VERSION" == "1" ]]; then ok "E1 drBundleVersion=1"; else fail "E1 drBundleVersion=$VERSION (expected 1)"; fi

# E2 — every config row carries readOnly:true. This is the critical
# contract Unit B's importer relies on; a bundle violating it would
# defeat the entire DR-safety mechanism.
NON_RO_COUNT=$(jq -r '[.backupConfigurations[] | select(.readOnly != true)] | length' "$WORK_DIR/contents/dr-rows.json")
if [[ "$NON_RO_COUNT" == "0" ]]; then
  TOTAL=$(jq -r '.backupConfigurations | length' "$WORK_DIR/contents/dr-rows.json")
  ok "E2 every backup_configurations row has readOnly:true ($TOTAL rows)"
else
  fail "E2 $NON_RO_COUNT row(s) in dr-rows.json have readOnly!=true — Unit B would refuse to import"
fi

# ─── Critical Secret presence ───────────────────────────────────────
echo "==> Phase F: critical Secret presence"
# The CRITICAL_TIER_1_SECRETS list in secrets-tiers.ts; filenames in
# the tar are <namespace>__<name>.yaml.
for crit in platform__platform-secrets.yaml platform__backup-target-key.yaml; do
  if [[ -f "$WORK_DIR/contents/$crit" ]]; then
    ok "F1 $crit present"
  else
    fail "F1 $crit MISSING — bundle would be unrestorable (PLATFORM_ENCRYPTION_KEY or BACKUP_TARGET_KEY absent)"
  fi
done

# ─── Restore round-trip (Unit B) ────────────────────────────────────
#
# Phase G validates the dr-restore-bundle.sh importer can consume the
# bundle we just produced + populate an empty DB with the right rows.
# Uses a throwaway local Postgres (docker run) so the live system-db
# stays clean. Skipped when --skip-restore is set OR docker is missing.
echo "==> Phase G: dr-restore-bundle.sh round-trip"
if [[ "${SKIP_RESTORE:-0}" == "1" ]]; then
  echo "  (skip G: SKIP_RESTORE=1)"
elif ! command -v docker >/dev/null 2>&1; then
  echo "  (skip G: docker not on PATH — install or set SKIP_RESTORE=1)"
elif ! command -v psql >/dev/null 2>&1; then
  echo "  (skip G: psql not on PATH — install postgresql-client or set SKIP_RESTORE=1)"
else
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  PG_NAME="dr-restore-verify-$$"
  PG_PASS="dr-verify-$(openssl rand -hex 8)"
  PG_PORT=$(shuf -i 55432-65432 -n 1)
  cleanup_pg() {
    docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  }
  trap 'cleanup_pg; cleanup' EXIT

  echo "  spinning up ephemeral Postgres on :$PG_PORT..."
  docker run -d --rm --name "$PG_NAME" -e POSTGRES_PASSWORD="$PG_PASS" -p "$PG_PORT:5432" postgres:18-alpine >/dev/null
  # Wait for Postgres to accept connections (max 30s)
  for _ in $(seq 1 30); do
    if docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
  done

  # Apply schema migrations — every *.sql in backend/src/db/migrations
  # in alphabetical order. Mirrors the platform-api startup migrator.
  export DATABASE_URL="postgresql://postgres:$PG_PASS@localhost:$PG_PORT/postgres"
  MIGRATION_FAIL=0
  for m in "$REPO_ROOT"/backend/src/db/migrations/*.sql; do
    if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$m" >/dev/null 2>&1; then
      fail "G0 migration $(basename "$m") failed against ephemeral Postgres"
      MIGRATION_FAIL=1
      break
    fi
  done
  if [[ $MIGRATION_FAIL -eq 0 ]]; then
    ok "G0 schema migrations applied to ephemeral Postgres"

    # Run the importer against the empty DB.
    if "$REPO_ROOT/scripts/dr-restore-bundle.sh" \
        --bundle "$WORK_DIR/bundle.age" \
        --age-key "$AGE_KEY_FILE" \
        --mode partial \
        > "$WORK_DIR/restore.stdout" 2> "$WORK_DIR/restore.stderr"; then
      ok "G1 dr-restore-bundle.sh exited 0"
    else
      fail "G1 dr-restore-bundle.sh failed: $(cat "$WORK_DIR/restore.stderr")"
    fi

    # Verify the JSON result is well-formed + has the expected shape.
    if jq -e '.ok == true' "$WORK_DIR/restore.stdout" >/dev/null 2>&1; then
      CONFIGS=$(jq -r '.importResult.configsInserted' "$WORK_DIR/restore.stdout")
      ASSIGNS=$(jq -r '.importResult.assignmentsInserted' "$WORK_DIR/restore.stdout")
      ok "G2 importer reports configsInserted=$CONFIGS assignmentsInserted=$ASSIGNS"
    else
      fail "G2 importer JSON result is not ok=true"
    fi

    # Verify the rows landed in the DB with readOnly=true on EVERY row.
    NON_RO=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM backup_configurations WHERE read_only IS NOT TRUE")
    if [[ "$NON_RO" == "0" ]]; then
      TOTAL=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM backup_configurations")
      ok "G3 every imported config has read_only=true (total=$TOTAL)"
    else
      fail "G3 $NON_RO row(s) in DB have read_only != true — A1 freeze invariant violated"
    fi

    # Verify the assignments landed.
    A_TOTAL=$(psql "$DATABASE_URL" -t -A -c "SELECT COUNT(*) FROM backup_target_assignments")
    ok "G4 imported $A_TOTAL backup_target_assignments rows"

    # Verify idempotency: re-running the importer is a no-op (every
    # row is skipped via ON CONFLICT DO NOTHING).
    if "$REPO_ROOT/scripts/dr-restore-bundle.sh" \
        --bundle "$WORK_DIR/bundle.age" --age-key "$AGE_KEY_FILE" --mode partial \
        > "$WORK_DIR/restore2.stdout" 2>&1; then
      RE_INSERTED=$(jq -r '.importResult.configsInserted' "$WORK_DIR/restore2.stdout")
      if [[ "$RE_INSERTED" == "0" ]]; then
        ok "G5 re-running importer is idempotent (0 new inserts)"
      else
        fail "G5 re-run inserted $RE_INSERTED configs — importer is not idempotent"
      fi
    else
      fail "G5 re-run failed"
    fi
  fi
fi

echo
echo "─── Summary ───"
echo "  passed: $PASS"
echo "  failed: $FAIL"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
echo "✅ integration-dr-bundle: all checks passed."
