#!/usr/bin/env bash
# setup-backup-targets.sh — bind the throw-away services-VM object store as the cluster's
# backup target BEFORE the suites run. The services VM (net-services.sh) exists precisely to
# provide S3/MinIO (+ SFTP/CIFS) endpoints; without an actual backup target BOUND to the
# tenant/system classes, every backup/DR suite fails its precondition (grow → NO_SNAPSHOT_TARGET,
# dr-drill-shim → ScheduledBackup suspended, backup-rclone-shim C3, dr-bundle skip). Staging has
# an operator-configured target; this reproduces that on the ephemeral tier so those suites can run.
#
# Reads the same BACKUP_S3_* + ADMIN_* env the runner script already exports. Idempotent: reuses an
# existing config with our name, re-binds classes each run. Non-fatal (warn, don't abort) so a
# backup-plane hiccup can't block the whole run — the affected suites will then surface it themselves.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${ADMIN_HOST:?ADMIN_HOST unset}"; : "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT unset}"
CURL_OPTS=(-s); [[ "${CURL_INSECURE:-}" == "1" ]] && CURL_OPTS+=(-k)
CFG_NAME="vmtier-services-s3"

# Token: reuse the cached integration token if present, else log in (same path as the suites).
TOKEN="${INTEGRATION_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HERE/../integration-token.sh" ]]; then
  # shellcheck source=/dev/null
  source "$HERE/../integration-token.sh" 2>/dev/null && TOKEN="$(get_admin_token 2>/dev/null || true)"
fi
if [[ -z "$TOKEN" ]]; then
  TOKEN=$(curl "${CURL_OPTS[@]}" -X POST "$ADMIN_HOST/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"${ADMIN_EMAIL:-admin@example.test}\",\"password\":\"${ADMIN_PASSWORD:-}\"}" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("token",""))' 2>/dev/null)
fi
[[ -n "$TOKEN" ]] || { echo "  WARN: backup-target setup could not obtain an admin token — skipping" >&2; exit 0; }

api() { local m="$1" p="$2" b="${3:-}"; if [[ -n "$b" ]]; then
    curl "${CURL_OPTS[@]}" -X "$m" "$ADMIN_HOST$p" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -w '\n%{http_code}' --data "$b"
  else curl "${CURL_OPTS[@]}" -X "$m" "$ADMIN_HOST$p" -H "Authorization: Bearer $TOKEN" -w '\n%{http_code}'; fi; }
code() { tail -n1 <<<"$1"; }; body() { head -n -1 <<<"$1"; }

# 1) create the S3 target (or reuse an existing one with our name). Fields are snake_case;
#    createBackupConfigSchema discriminates on storage_type. Creds come from net-services' MinIO.
LIST_RESP=$(api GET /api/v1/admin/backup-configs)
TARGET_ID=$(body "$LIST_RESP" | python3 -c '
import json,sys
try: print(next((c["id"] for c in json.load(sys.stdin).get("data",[]) if c.get("name")=="'"$CFG_NAME"'"), ""))
except Exception: print("")' 2>/dev/null)
if [[ -z "$TARGET_ID" ]]; then
  CREATE=$(api POST /api/v1/admin/backup-configs "{\"name\":\"$CFG_NAME\",\"storage_type\":\"s3\",\"s3_endpoint\":\"$BACKUP_S3_ENDPOINT\",\"s3_bucket\":\"${BACKUP_S3_BUCKET:-backups}\",\"s3_region\":\"${BACKUP_S3_REGION:-us-east-1}\",\"s3_access_key\":\"${BACKUP_S3_ACCESS_KEY}\",\"s3_secret_key\":\"${BACKUP_S3_SECRET_KEY}\",\"retention_days\":7}")
  case "$(code "$CREATE")" in
    200|201) TARGET_ID=$(body "$CREATE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("id",""))' 2>/dev/null) ;;
    *) echo "  WARN: create backup-config → HTTP $(code "$CREATE"): $(body "$CREATE" | head -c 200)" >&2; exit 0 ;;
  esac
fi
[[ -n "$TARGET_ID" ]] || { echo "  WARN: no backup target id — skipping bind" >&2; exit 0; }
echo "  backup target $CFG_NAME id=$TARGET_ID (S3 → $BACKUP_S3_ENDPOINT)"

# 2) activate it (cluster's active Longhorn backup target — snapshot-before-shrink etc.)
A=$(api POST "/api/v1/admin/backup-configs/$TARGET_ID/activate"); echo "  activate → HTTP $(code "$A")"

# 3) bind it to each backup class so class-scoped suites (grow=tenant, dr-drill=system, mail) pass.
for cls in system tenant mail; do
  R=$(api PUT "/api/v1/admin/backup-rclone-shim/assignments/$cls" "{\"targetId\":\"$TARGET_ID\",\"force\":false}")
  echo "  bind class '$cls' → HTTP $(code "$R")"
done
echo "  backup targets configured."
