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

echo
echo "─── Summary ───"
echo "  passed: $PASS"
echo "  failed: $FAIL"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
echo "✅ integration-dr-bundle: all checks passed."
