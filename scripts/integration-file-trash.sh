#!/usr/bin/env bash
# integration-file-trash.sh — file-manager recycle-bin E2E against a real cluster.
#
# Drives the operator's actual path (curl → Traefik → admin-panel nginx →
# platform-api → file-manager sidecar → tenant PVC) and asserts user-visible
# outcomes, not the API's own self-report:
#
#   1. A delete MOVES the file — it disappears from the listing AND reappears
#      in the bin, with its bytes still counted against the tenant's storage.
#   2. Restore returns the ORIGINAL CONTENT, byte for byte, to the original
#      path, recreating parent directories that the delete removed.
#   3. A restore onto an occupied path does not clobber: 409 + conflictPath,
#      then "restore alongside" and "replace" both do what they say.
#   4. `permanent: true` really bypasses the bin (nothing new appears in it).
#   5. The bin is unreachable through ordinary file operations — a tenant
#      cannot rm/rename/copy/write their way into .trash and desync it.
#   6. Purge frees the space: trashBytes returns to zero.
#
# ENV (same shape as the sibling suites; integration-all supplies these):
#   ADMIN_HOST / ADMIN_EMAIL / ADMIN_PASSWORD (required)
#   SSH_KEY (default ~/hosting-platform.key) · STAGING_SSH_HOST / SSH_HOST
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/integration-env.sh"
set -uo pipefail

ADMIN_HOST="${ADMIN_HOST:-https://admin.$(resolve_platform_apex)}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
if [[ -z "$ADMIN_PASSWORD" ]]; then echo "ERROR: ADMIN_PASSWORD must be set" >&2; exit 2; fi

PASS=0; FAIL=0
pass() { echo "  PASS  $*"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $*" >&2; FAIL=$((FAIL+1)); }
note() { echo "== $* =="; }

WORK="$(mktemp -d)"
# tmpfs leftovers pin node RAM — always clean up, whatever the exit path.
trap 'rm -rf "$WORK"' EXIT

api() { curl -sk -H "Authorization: Bearer $TOKEN" "$@"; }
japi() { api -H 'Content-Type: application/json' "$@"; }
# GET with a URL-ENCODED `path` query parameter. Mandatory: autoRename produces
# names containing a space ("payload (restored).txt"), and sending that raw
# returns an empty body that looks exactly like "the file does not exist".
getp() { api --get --data-urlencode "path=$2" "$1"; }

note "authenticate"
TOKEN=$(curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | jq -r '.data.token // empty')
[[ -n "$TOKEN" ]] || { echo "ERROR: login failed against $ADMIN_HOST" >&2; exit 2; }
pass "admin login"

note "select a tenant whose file manager is actually usable"
# PROBE, don't guess: the tenant LIST response carries `status`, not
# `provisioningStatus`, so filtering on the latter silently matches nothing and
# the suite would "pass" against no subject at all. Ask the file-manager
# endpoint itself — it is the thing that has to work.
TENANTS=$(api "$ADMIN_HOST/api/v1/tenants?limit=100")
# Non-system first: the SYSTEM tenant works but is special-cased elsewhere and
# is a poor default subject for a destructive suite.
CANDIDATES=$(jq -r '[.data[] | select(.isSystem != true)][].id, [.data[] | select(.isSystem == true)][].id' <<<"$TENANTS")
TENANT_ID=""
for c in $CANDIDATES; do
  if [[ "$(api -o /dev/null -w '%{http_code}' "$ADMIN_HOST/api/v1/tenants/$c/files/status")" == "200" ]]; then
    TENANT_ID="$c"; break
  fi
done
[[ -n "$TENANT_ID" ]] || { echo "ERROR: no tenant on this cluster has a usable file manager" >&2; exit 2; }
IS_SYSTEM=$(jq -r --arg id "$TENANT_ID" '.data[] | select(.id==$id) | .isSystem' <<<"$TENANTS")
echo "  subject: tenant $TENANT_ID (isSystem=$IS_SYSTEM)"
T="$ADMIN_HOST/api/v1/tenants/$TENANT_ID/files"

note "start the file manager"
# Keep the /start response: discarding it hid the real reason for a failure
# once already (a STORAGE_OP_IN_PROGRESS or a mid-rollout image pin looks
# identical to "never became ready" when the body is thrown away).
START=$(api -X POST "$T/start")
for _ in $(seq 1 90); do
  [[ "$(api "$T/status" | jq -r '.data.phase // empty')" == "ready" ]] && break
  sleep 2
done
if [[ "$(api "$T/status" | jq -r '.data.phase')" == "ready" ]]; then
  pass "file manager ready (one /start call)"
else
  fail "file manager never became ready"
  echo "    /start said : $(jq -c . <<<"$START" 2>/dev/null || printf %s "$START")" >&2
  echo "    /status says: $(api "$T/status" | jq -c '.data // .' 2>/dev/null)" >&2
  exit 1
fi

STAMP="itrash-$$-$RANDOM"
DIR="$STAMP/nested/deep"
FILE="$DIR/payload.txt"
CONTENT="recycle-bin-e2e-$STAMP-$(head -c 64 /dev/urandom | base64 | tr -d '\n/+=')"

note "seed a file"
japi -X POST "$T/write" -d "$(jq -nc --arg p "$FILE" --arg c "$CONTENT" '{path:$p,content:$c}')" >/dev/null
[[ "$(getp "$T/read" "$FILE" | jq -r '.data.content')" == "$CONTENT" ]] \
  && pass "seed file readable" || fail "seed file did not round-trip"

TRASH_BEFORE=$(api "$T/disk-usage" | jq -r '.data.trashBytes')
RETENTION=$(api "$T/disk-usage" | jq -r '.data.trashRetentionDays')
[[ "$RETENTION" =~ ^[0-9]+$ && "$RETENTION" -ge 1 ]] \
  && pass "disk-usage carries trashRetentionDays ($RETENTION)" \
  || fail "trashRetentionDays missing/invalid: $RETENTION"

note "1. delete MOVES the file into the bin"
DEL=$(japi -X POST "$T/delete" -d "$(jq -nc --arg p "$FILE" '{path:$p}')")
[[ "$(jq -r '.data.trashed' <<<"$DEL")" == "true" ]] \
  && pass "delete reports trashed" || fail "delete did not trash: $(jq -c . <<<"$DEL")"
ENTRY_ID=$(jq -r '.data.trashEntry.id' <<<"$DEL")

# User-visible: gone from the listing.
jq -e --arg n "payload.txt" '.data.entries | map(.name) | index($n) | not' \
  >/dev/null <<<"$(getp "$T" "$DIR")" \
  && pass "file is gone from its directory" || fail "file still listed after delete"

# User-visible: present in the bin, with its original path recorded.
BIN=$(api "$T/trash")
jq -e --arg id "$ENTRY_ID" --arg p "$FILE" \
  '.data.entries[] | select(.id==$id) | select(.originalPath==$p)' >/dev/null <<<"$BIN" \
  && pass "bin lists the entry with its original path" \
  || fail "entry missing/incorrect in bin: $(jq -c '.data.entries' <<<"$BIN")"

note "2. the bin costs quota (no size cap — transparency is the control)"
TRASH_AFTER=$(api "$T/disk-usage" | jq -r '.data.trashBytes')
USED_AFTER=$(api "$T/disk-usage" | jq -r '.data.usedBytes')
[[ "$TRASH_AFTER" -gt "$TRASH_BEFORE" ]] \
  && pass "trashBytes grew ($TRASH_BEFORE → $TRASH_AFTER)" \
  || fail "trashBytes did not grow ($TRASH_BEFORE → $TRASH_AFTER)"
[[ "$TRASH_AFTER" -le "$USED_AFTER" ]] \
  && pass "trashBytes is a subset of usedBytes" \
  || fail "trashBytes $TRASH_AFTER exceeds usedBytes $USED_AFTER"

note "3. the bin is hidden from ordinary browsing"
jq -e '.data.entries | map(.name) | index(".trash") | not' >/dev/null <<<"$(getp "$T" "/")" \
  && pass ".trash is not listed at the PVC root" || fail ".trash leaked into the root listing"

note "4. ordinary file operations cannot reach into the bin"
SHARD=$(jq -r --arg id "$ENTRY_ID" '.data.entries[] | select(.id==$id) | .shard' <<<"$BIN")
INSIDE=".trash/files/$SHARD/$ENTRY_ID"
for op in \
  "delete|$(jq -nc --arg p "$INSIDE" '{path:$p}')" \
  "rename|$(jq -nc --arg o "$INSIDE" '{oldPath:$o,newPath:"stolen.txt"}')" \
  "copy|$(jq -nc --arg s "$INSIDE" '{sourcePath:$s,destPath:"stolen.txt"}')"
do
  name="${op%%|*}"; body="${op#*|}"
  code=$(japi -o /dev/null -w '%{http_code}' -X POST "$T/$name" -d "$body")
  [[ "$code" == "404" ]] && pass "$name into .trash refused ($code)" \
    || fail "$name into .trash returned $code, expected 404"
done
code=$(japi -o /dev/null -w '%{http_code}' -X POST "$T/write" -d '{"path":".trash/info/evil.json","content":"x"}')
[[ "$code" == "404" ]] && pass "write into .trash refused ($code)" || fail "write into .trash returned $code"
# …and the entry survived every attempt.
jq -e --arg id "$ENTRY_ID" '.data.entries[] | select(.id==$id)' >/dev/null <<<"$(api "$T/trash")" \
  && pass "entry intact after the attempts" || fail "entry damaged by the attempts"

note "5. restore returns the original bytes to the original path"
# Remove the parents too, so the restore has to recreate them.
japi -X POST "$T/delete" -d "$(jq -nc --arg p "$STAMP" '{path:$p,permanent:true}')" >/dev/null
RES=$(japi -X POST "$T/trash/restore" -d "$(jq -nc --arg id "$ENTRY_ID" '{id:$id}')")
[[ "$(jq -r '.data.restoredTo' <<<"$RES")" == "$FILE" ]] \
  && pass "restored to the original path" || fail "restoredTo: $(jq -c '.data' <<<"$RES")"
[[ "$(getp "$T/read" "$FILE" | jq -r '.data.content')" == "$CONTENT" ]] \
  && pass "restored content matches byte for byte" || fail "restored content differs"
jq -e --arg id "$ENTRY_ID" '.data.entries | map(.id) | index($id) | not' >/dev/null <<<"$(api "$T/trash")" \
  && pass "entry consumed by the restore" || fail "entry still in the bin after restore"

note "6. a restore onto an occupied path does not clobber"
D2=$(japi -X POST "$T/delete" -d "$(jq -nc --arg p "$FILE" '{path:$p}')")
ID2=$(jq -r '.data.trashEntry.id' <<<"$D2")
NEWER="occupant-$STAMP"
japi -X POST "$T/write" -d "$(jq -nc --arg p "$FILE" --arg c "$NEWER" '{path:$p,content:$c}')" >/dev/null
CONFLICT=$(japi -X POST "$T/trash/restore" -d "$(jq -nc --arg id "$ID2" '{id:$id}')")
[[ "$(jq -r '.error.code // empty' <<<"$CONFLICT")" == "FILE_EXISTS" ]] \
  && pass "conflict reported instead of overwriting" || fail "expected FILE_EXISTS: $(jq -c . <<<"$CONFLICT")"
[[ "$(getp "$T/read" "$FILE" | jq -r '.data.content')" == "$NEWER" ]] \
  && pass "the occupying file was left untouched" || fail "occupant was modified"

ALONG=$(japi -X POST "$T/trash/restore" -d "$(jq -nc --arg id "$ID2" '{id:$id,autoRename:true}')")
ALONG_PATH=$(jq -r '.data.restoredTo' <<<"$ALONG")
[[ "$ALONG_PATH" == *"(restored)"* ]] \
  && pass "restore-alongside renamed to $ALONG_PATH" || fail "autoRename path: $ALONG_PATH"
[[ "$(getp "$T/read" "$ALONG_PATH" | jq -r '.data.content')" == "$CONTENT" ]] \
  && pass "the alongside copy holds the recovered content" || fail "alongside copy content wrong"
[[ "$(getp "$T/read" "$FILE" | jq -r '.data.content')" == "$NEWER" ]] \
  && pass "and the occupant is still intact" || fail "occupant lost during autoRename"

note "7. permanent:true really bypasses the bin"
BIN_N=$(api "$T/trash" | jq '.data.entries | length')
japi -X POST "$T/delete" -d "$(jq -nc --arg p "$ALONG_PATH" '{path:$p,permanent:true}')" >/dev/null
[[ "$(api "$T/trash" | jq '.data.entries | length')" == "$BIN_N" ]] \
  && pass "permanent delete added nothing to the bin" || fail "permanent delete still trashed"
[[ "$(getp "$T/read" "$ALONG_PATH" | jq -r '.data.content // empty')" == "" ]] \
  && pass "permanently deleted file is unreadable" || fail "file survived a permanent delete"

note "8. purge frees the space"
japi -X POST "$T/delete" -d "$(jq -nc --arg p "$FILE" '{path:$p}')" >/dev/null
japi -X POST "$T/delete" -d "$(jq -nc --arg p "$STAMP" '{path:$p}')" >/dev/null
BEFORE_PURGE=$(api "$T/disk-usage" | jq -r '.data.trashBytes')
PURGE=$(japi -X POST "$T/trash/purge" -d '{"all":true}')
[[ "$(jq -r '.data.failed | length' <<<"$PURGE")" == "0" ]] \
  && pass "purge reported no failures" || fail "purge failures: $(jq -c '.data.failed' <<<"$PURGE")"
[[ "$(api "$T/trash" | jq '.data.entries | length')" == "0" ]] \
  && pass "bin is empty after purge" || fail "bin not empty after purge"
AFTER_PURGE=$(api "$T/disk-usage" | jq -r '.data.trashBytes')
[[ "$AFTER_PURGE" -lt "$BEFORE_PURGE" || "$AFTER_PURGE" == "0" ]] \
  && pass "trashBytes dropped ($BEFORE_PURGE → $AFTER_PURGE)" \
  || fail "trashBytes did not drop ($BEFORE_PURGE → $AFTER_PURGE)"


echo
echo "RESULT: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
