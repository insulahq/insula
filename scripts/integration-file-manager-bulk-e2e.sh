#!/usr/bin/env bash
#
# Integration E2E — bulk file-manager operations over the real API.
#
# Drives the exact flow that broke production on 2026-09-02: select a large
# group of files and move them to another folder. The old panel sent one HTTP
# request PER FILE, all concurrently, which exceeded the global API rate limit
# (100/min) and took the rest of the page down with it — including
# /files/status, whose 429 made the Files page render "Starting file manager…"
# for a pod that was running fine the whole time.
#
# This harness asserts the properties that regression depended on:
#   1. a whole selection is ONE request (measured: no 429 anywhere, and the
#      selection is larger than the rate limit itself)
#   2. /files/status still answers 200 immediately after a large bulk op
#   3. per-path failures are reported in `complete.failed`, never as an
#      `error` frame, and never abort the batch
#   4. the files actually moved on disk — asserted inside the pod, not from
#      the API's own say-so
#
# Usage:
#   scripts/integration-file-manager-bulk-e2e.sh            # against DinD
#   API_URL=… API_HOST=… ADMIN_EMAIL=… ADMIN_PASSWORD=… scripts/…
set -euo pipefail

API_URL="${API_URL:-https://dind.local:2011}"
API_HOST="${API_HOST:-admin.k8s-platform.test}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@insula.host}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"
# Deliberately larger than the 100/min rate limit: under the old one-request-
# per-file panel this selection COULD NOT complete without 429s.
FILE_COUNT="${FILE_COUNT:-120}"

TMPDIR_E2E="$(mktemp -d)"
# tmpfs leftovers pin node RAM — always clean up.
trap 'rm -rf "$TMPDIR_E2E"' EXIT

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; fail=$((fail+1)); }
info() { printf '  ---- %s\n' "$*"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

kc() { docker exec "$K3S_CONTAINER" kubectl "$@"; }

api() {
  local method="$1" path="$2"; shift 2
  curl -sk -m 120 -X "$method" -H "Host: $API_HOST" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' "$@" "$API_URL$path"
}

# ── Auth ────────────────────────────────────────────────────────────────────
hdr "── auth ───────────────────────────────────────────────────────────"
TOKEN=$(curl -sk -m 30 -H "Host: $API_HOST" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  "$API_URL/api/v1/auth/login" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])')
[ -n "$TOKEN" ] || { echo "login failed" >&2; exit 1; }
ok "logged in as $ADMIN_EMAIL"

# ── Target tenant ───────────────────────────────────────────────────────────
TENANT_ID="${TENANT_ID:-}"
if [ -z "$TENANT_ID" ]; then
  TENANT_ID=$(api GET "/api/v1/tenants?limit=50" | python3 -c '
import sys,json
for t in json.load(sys.stdin)["data"]:
    if not t.get("isSystem") and t.get("status") == "active":
        print(t["id"]); break')
fi
[ -n "$TENANT_ID" ] || { echo "no non-system active tenant found; set TENANT_ID=" >&2; exit 1; }
NS=$(api GET "/api/v1/tenants/$TENANT_ID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["kubernetesNamespace"])')
ok "tenant $TENANT_ID (namespace $NS)"

# ── File manager up ─────────────────────────────────────────────────────────
hdr "── file manager ───────────────────────────────────────────────────"
api POST "/api/v1/tenants/$TENANT_ID/files/start" -d '{}' >/dev/null
for _ in $(seq 1 60); do
  phase=$(api GET "/api/v1/tenants/$TENANT_ID/files/status" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["phase"])' 2>/dev/null || echo '?')
  [ "$phase" = "ready" ] && break
  sleep 5
done
[ "$phase" = "ready" ] || { echo "file-manager never became ready (phase=$phase)" >&2; exit 1; }
ok "file-manager ready"

FM_POD=$(kc -n "$NS" get pod -l app=file-manager -o jsonpath='{.items[0].metadata.name}')
info "pod $FM_POD"
FM_RESTARTS_BEFORE=$(kc -n "$NS" get pod "$FM_POD" -o jsonpath='{.status.containerStatuses[0].restartCount}')

# ── Seed ────────────────────────────────────────────────────────────────────
#
# Seeded INSIDE the pod on purpose: creating the fixture through the API would
# itself be N requests and would trip the very rate limit under test.
hdr "── seed $FILE_COUNT files ─────────────────────────────────────────"
kc -n "$NS" exec "$FM_POD" -- sh -c "
  rm -rf /data/e2e-src /data/e2e-dest /data/e2e-copy
  mkdir -p /data/e2e-src /data/e2e-dest /data/e2e-copy
  i=1; while [ \$i -le $FILE_COUNT ]; do echo \"content-\$i\" > /data/e2e-src/f\$i.txt; i=\$((i+1)); done
  ls /data/e2e-src | wc -l" >/dev/null
seeded=$(kc -n "$NS" exec "$FM_POD" -- sh -c 'ls -A /data/e2e-src | wc -l' | tr -d ' \r')
[ "$seeded" = "$FILE_COUNT" ] && ok "seeded $seeded files" || bad "expected $FILE_COUNT seeded, got $seeded"

paths_json() { python3 -c "
import json,sys
n=int(sys.argv[1]); print(json.dumps([f'/e2e-src/f{i}.txt' for i in range(1,n+1)]))" "$1"; }

# ── 1. Bulk move: one request for the whole selection ───────────────────────
hdr "── 1. bulk-move ($FILE_COUNT paths, one request) ──────────────────"
START_TS=$(date +%s)
api POST "/api/v1/tenants/$TENANT_ID/files/bulk-move" \
  -d "{\"paths\": $(paths_json "$FILE_COUNT"), \"destDir\": \"/e2e-dest\"}" \
  > "$TMPDIR_E2E/move.ndjson"

python3 - "$TMPDIR_E2E/move.ndjson" "$FILE_COUNT" <<'PY' && ok "NDJSON stream well-formed" || bad "NDJSON stream malformed"
import json,sys
frames=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
n=int(sys.argv[2])
assert frames[0]=={'type':'start','total':n}, f'bad start frame: {frames[0]}'
prog=[f for f in frames if f['type']=='progress']
assert len(prog)==n, f'expected {n} progress frames, got {len(prog)}'
assert [p['done'] for p in prog]==list(range(1,n+1)), 'progress not monotonic 1..n'
assert prog[-1]['percent']==100, f'last percent {prog[-1]["percent"]}'
comp=[f for f in frames if f['type']=='complete']
assert len(comp)==1, f'expected exactly 1 complete frame, got {len(comp)}'
assert not any(f['type']=='error' for f in frames), 'unexpected error frame'
assert len(comp[0]['succeeded'])==n, f'succeeded {len(comp[0]["succeeded"])} != {n}'
assert comp[0]['failed']==[], f'unexpected failures: {comp[0]["failed"]}'
print(f'    {len(frames)} frames: 1 start + {len(prog)} progress + 1 complete, 0 failed')
PY

# The user-visible outcome, read off the volume rather than from the API.
src_left=$(kc -n "$NS" exec "$FM_POD" -- sh -c 'ls -A /data/e2e-src | wc -l' | tr -d ' \r')
dest_have=$(kc -n "$NS" exec "$FM_POD" -- sh -c 'ls -A /data/e2e-dest | wc -l' | tr -d ' \r')
[ "$src_left" = "0" ] && ok "source folder emptied" || bad "source still holds $src_left files"
[ "$dest_have" = "$FILE_COUNT" ] && ok "all $FILE_COUNT files present in destination" || bad "destination has $dest_have, expected $FILE_COUNT"
content=$(kc -n "$NS" exec "$FM_POD" -- sh -c 'cat /data/e2e-dest/f42.txt' | tr -d '\r')
[ "$content" = "content-42" ] && ok "moved file content intact" || bad "content mismatch: '$content'"

# ── 2. The regression itself: no rate-limit collateral ──────────────────────
hdr "── 2. no 429 collateral (the reported symptom) ────────────────────"
API_POD=$(kc -n platform get pod -l app=platform-api -o jsonpath='{.items[0].metadata.name}')
n429=$(kc -n platform logs "$API_POD" --since="$(( $(date +%s) - START_TS + 30 ))s" 2>/dev/null \
  | grep -c '"statusCode":429' || true)
[ "$n429" = "0" ] && ok "zero 429s during a $FILE_COUNT-file move (limit is 100/min)" \
                  || bad "$n429 requests were rate-limited"

# /files/status is what fell over and made the panel show "Starting…".
status_code=$(curl -sk -m 30 -o /dev/null -w '%{http_code}' -H "Host: $API_HOST" \
  -H "Authorization: Bearer $TOKEN" "$API_URL/api/v1/tenants/$TENANT_ID/files/status")
[ "$status_code" = "200" ] && ok "/files/status still 200 straight after the bulk op" \
                           || bad "/files/status returned $status_code"

# ── 3. Partial failure is reported, not thrown ──────────────────────────────
hdr "── 3. partial failure reporting ───────────────────────────────────"
api POST "/api/v1/tenants/$TENANT_ID/files/bulk-move" \
  -d '{"paths":["/e2e-dest/f1.txt","/e2e-dest/does-not-exist.txt","/e2e-dest/f2.txt"],"destDir":"/e2e-src"}' \
  > "$TMPDIR_E2E/partial.ndjson"

python3 - "$TMPDIR_E2E/partial.ndjson" <<'PY' && ok "partial result reported per-path" || bad "partial result mishandled"
import json,sys
frames=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
comp=next(f for f in frames if f['type']=='complete')
assert sorted(comp['succeeded'])==['/e2e-dest/f1.txt','/e2e-dest/f2.txt'], comp['succeeded']
assert len(comp['failed'])==1 and comp['failed'][0]['path']=='/e2e-dest/does-not-exist.txt', comp['failed']
# The batch must NOT abort at the bad path: f2 comes after it and still moved.
assert '/e2e-dest/f2.txt' in comp['succeeded'], 'batch aborted at the failing path'
# A per-path failure is not an `error` frame — that is what the client throws on.
assert not any(f['type']=='error' for f in frames), 'per-path failure emitted an error frame'
print(f"    2 succeeded, 1 failed ({comp['failed'][0]['error']}) — batch continued past the failure")
PY

# ── 4. Copy / chmod / chown ─────────────────────────────────────────────────
hdr "── 4. bulk-copy, bulk-chmod, bulk-chown ───────────────────────────"
api POST "/api/v1/tenants/$TENANT_ID/files/bulk-copy" \
  -d '{"paths":["/e2e-dest/f3.txt","/e2e-dest/f4.txt"],"destDir":"/e2e-copy"}' > "$TMPDIR_E2E/copy.ndjson"
copied=$(kc -n "$NS" exec "$FM_POD" -- sh -c 'ls -A /data/e2e-copy | wc -l' | tr -d ' \r')
still_there=$(kc -n "$NS" exec "$FM_POD" -- sh -c 'ls /data/e2e-dest/f3.txt 2>/dev/null | wc -l' | tr -d ' \r')
[ "$copied" = "2" ] && ok "bulk-copy placed 2 files" || bad "bulk-copy produced $copied files"
[ "$still_there" = "1" ] && ok "bulk-copy left the sources in place" || bad "bulk-copy removed its source"

api POST "/api/v1/tenants/$TENANT_ID/files/bulk-chmod" \
  -d '{"paths":["/e2e-copy/f3.txt","/e2e-copy/f4.txt"],"mode":"640"}' > "$TMPDIR_E2E/chmod.ndjson"
modes=$(kc -n "$NS" exec "$FM_POD" -- sh -c 'stat -c %a /data/e2e-copy/f3.txt /data/e2e-copy/f4.txt' | tr -d '\r' | tr '\n' ',')
[ "$modes" = "640,640," ] && ok "bulk-chmod applied 640 to every path" || bad "modes are $modes"

api POST "/api/v1/tenants/$TENANT_ID/files/bulk-chown" \
  -d '{"paths":["/e2e-copy/f3.txt","/e2e-copy/f4.txt"],"uid":1001,"gid":1001}' > "$TMPDIR_E2E/chown.ndjson"
owners=$(kc -n "$NS" exec "$FM_POD" -- sh -c 'stat -c %u:%g /data/e2e-copy/f3.txt /data/e2e-copy/f4.txt' | tr -d '\r' | tr '\n' ',')
[ "$owners" = "1001:1001,1001:1001," ] && ok "bulk-chown applied 1001:1001 to every path" || bad "owners are $owners"

# ── 5. The WAF argument ceiling ─────────────────────────────────────────────
#
# ModSecurity flattens each JSON array element into its own ARGS entry and
# rule 200007 refuses the request at 1000 of them — at the EDGE, as a bare
# nginx 400 the API never sees and that carries no error envelope. This is why
# MAX_BULK_PATHS is 500 and the panel splits anything larger.
hdr "── 5. WAF argument ceiling ────────────────────────────────────────"
cap_probe() {
  local n="$1"
  python3 -c "import json,sys;print(json.dumps({'paths':[f'/e2e-dest/f{i}.txt' for i in range($n)],'destDir':'/e2e-nowhere'}))" > "$TMPDIR_E2E/probe.json"
  curl -sk -m 90 -o "$TMPDIR_E2E/probe.out" -w '%{http_code}' -X POST -H "Host: $API_HOST" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data-binary "@$TMPDIR_E2E/probe.json" \
    "$API_URL/api/v1/tenants/$TENANT_ID/files/bulk-move"
}

cap_code=$(cap_probe 500)
[ "$cap_code" = "200" ] && ok "a full $((500))-path request (MAX_BULK_PATHS) crosses the WAF" \
                        || bad "a 500-path request was refused with $cap_code — cap is above the WAF ceiling"

over_code=$(cap_probe 1000)
if [ "$over_code" = "400" ] && grep -qi 'nginx' "$TMPDIR_E2E/probe.out"; then
  ok "1000 paths still refused at the edge — the reason the cap exists (documented, not regressed)"
else
  info "1000-path probe returned $over_code (WAF ARGS ceiling may have moved)"
fi

# Over-cap input is rejected by the API's own validation when it gets there.
code=$(curl -sk -m 60 -o "$TMPDIR_E2E/cap.json" -w '%{http_code}' -X POST -H "Host: $API_HOST" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"paths\": $(python3 -c 'import json;print(json.dumps([f"/x/f{i}" for i in range(501)]))'), \"destDir\":\"/e2e-dest\"}" \
  "$API_URL/api/v1/tenants/$TENANT_ID/files/bulk-move")
if [ "$code" = "400" ] && grep -q INVALID_FIELD_VALUE "$TMPDIR_E2E/cap.json"; then
  ok "over-cap selection rejected with a JSON 400, not a half-open stream"
else
  bad "over-cap selection returned $code: $(head -c 200 "$TMPDIR_E2E/cap.json")"
fi

# ── 6. The pod was never restarted by any of this ───────────────────────────
hdr "── 6. file-manager pod untouched ──────────────────────────────────"
FM_POD_AFTER=$(kc -n "$NS" get pod -l app=file-manager -o jsonpath='{.items[0].metadata.name}')
FM_RESTARTS_AFTER=$(kc -n "$NS" get pod "$FM_POD_AFTER" -o jsonpath='{.status.containerStatuses[0].restartCount}')
[ "$FM_POD" = "$FM_POD_AFTER" ] && ok "same pod throughout ($FM_POD_AFTER)" || bad "pod changed: $FM_POD -> $FM_POD_AFTER"
[ "$FM_RESTARTS_BEFORE" = "$FM_RESTARTS_AFTER" ] && ok "restart count unchanged ($FM_RESTARTS_AFTER)" \
  || bad "restarts went $FM_RESTARTS_BEFORE -> $FM_RESTARTS_AFTER"

# ── Cleanup ─────────────────────────────────────────────────────────────────
kc -n "$NS" exec "$FM_POD_AFTER" -- sh -c 'rm -rf /data/e2e-src /data/e2e-dest /data/e2e-copy' || true

hdr "── result ─────────────────────────────────────────────────────────"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
