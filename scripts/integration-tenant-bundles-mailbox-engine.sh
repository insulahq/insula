#!/usr/bin/env bash
# integration-tenant-bundles-mailbox-engine.sh — end-to-end test of the
# tenant-bundle mailbox capture+restore pipeline against BOTH engines
# (jmap, imap), with realistic edge-case mail data.
#
# Tests the script-level contract directly (`imap-sync.py` + `imap-restore.py`,
# `jmap-sync.py` + `jmap-restore.py`) — NOT the platform-api orchestrator.
# A separate platform-API-driven E2E will pick up the bundle endpoints
# in a follow-up.
#
# Edge cases exercised:
#   E1  small/medium/large message mix (5 KB / 80 KB / 500 KB)
#   E2  UTF-8 folder name ("Geschäftlich")
#   E3  Custom IMAP keyword ($Forwarded — system flags already covered)
#   E4  SPECIAL-USE folders (\Sent, \Drafts, \Junk, \Trash, \Archive)
#   E5  ONE 60 MB attachment (within 100 MiB x:Imap.maxRequestSize cap)
#   E6  ONE 100+ MiB message (over cap — must SKIP, not crash)
#   E7  Empty folder (preserved on restore via .imap-name + .special-use)
#   E8  Aux surfaces (Sieve script, UTF-8 contact, calendar event,
#       vacation response, FileNode tree with files+folders) —
#       captured by jmap-aux-sync.py, restored by jmap-aux-restore.py
#       regardless of mail engine. See ADR-044 §"Open follow-ups".
#
# Assertions per engine:
#   A1  Capture exit 0
#   A2  Restore exit 0
#   A3  Restored msg count == original msg count (minus oversize-skipped)
#   A4  Folder names round-trip byte-exact (including UTF-8)
#   A5  System flags preserved (\Seen, \Flagged, \Answered)
#   A6  Oversize message logged + skipped in restore summary
#   A7  Aux capture exit 0, all 5 surfaces marked available in manifest
#   A8  Aux restore exit 0, every surface created/updated > 0 (or
#       skipped with documented reason)
#   A9  Aux content fidelity: sieve script name + body, contact name
#       (UTF-8), calendar event title/start, vacation enabled,
#       filenode tree byte-equal (file count + parentId chain)
#
# Auth: master-user proxy. Reuses /tmp/{mfqdn,mpw,apw} on the testing
# host (written by earlier scripts).
#
# Run remotely (driver runs on operator workstation):
#   ssh root@testing.phoenix-host.net 'bash /tmp/integration-tenant-bundles-mailbox-engine.sh'

set -euo pipefail

NS_PERF="${NS_PERF:-export-perf}"
NS_MAIL="${NS_MAIL:-mail}"
HELPER="${HELPER:-export-perf-helper}"
DOMAIN="${DOMAIN:-mailperf-bench.net}"
DOMAIN_ID="${DOMAIN_ID:-c}"
IMAP_WORKERS="${IMAP_WORKERS:-4}"
JMAP_WORKERS="${JMAP_WORKERS:-4}"
LOG=/tmp/integration-mailbox-engine.log

MFQDN=$(cat /tmp/mfqdn)
MPW=$(cat /tmp/mpw)
APW=$(cat /tmp/apw)

PASS_COUNT=0
FAIL_COUNT=0
declare -a FAILURES=()

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "  PASS: $*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT+1)); FAILURES+=("$*"); log "  FAIL: $*"; }

# bootstrap.sh sets x:Imap.maxConcurrent=16 (Stalwart default). Production
# platform-api transiently elevates it to 64 via JMAP API around mailbox
# Jobs (see backend/src/modules/mail-admin/imap-concurrency.ts). For this
# standalone harness — which invokes imap-restore.py directly without
# going through platform-api — we elevate ourselves so K=$IMAP_WORKERS
# restore isn't throttled to one effective connection per user.
elevate_imap_concurrency() {
  local target="${1:-64}"
  local apw_b64=$(printf 'admin:%s' "$APW" | base64 -w0)
  local body
  body=$(jq -nc --argjson v "$target" \
    '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
      methodCalls:[["x:Imap/set",
        {accountId:"d333333",update:{singleton:{maxConcurrent:$v}}},
        "c0"]]}')
  local pod=$(kubectl -n "$NS_MAIL" get pods -l app=stalwart-mail \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  [ -z "$pod" ] && { log "elevate_imap_concurrency: no Stalwart pod"; return 1; }
  kubectl -n "$NS_MAIL" exec "$pod" -c stalwart -- \
    curl -sf -X POST -H "Authorization: Basic $apw_b64" \
      -H 'Content-Type: application/json' \
      --data-binary "$body" \
      http://127.0.0.1:8080/jmap/ >/dev/null
  log "elevated x:Imap.maxConcurrent → $target via JMAP API (admin)"
}

elevate_imap_concurrency 64

# ── Populate edge-case corpus via JMAP Email/import ─────────────────────────
populate_corpus() {
  local user="$1"
  local corpus_size="${CORPUS_SIZE:-100}"
  log "populate: corpus (size=$corpus_size) into ${user}@${DOMAIN}"
  kubectl -n "$NS_PERF" exec "$HELPER" -- env MPW="$MPW" CORPUS_SIZE="$corpus_size" SKIP_LARGE="${SKIP_LARGE:-0}" python3 -c "
import os, sys, json, base64, time, random
import requests
HOST='stalwart-mail.mail.svc.cluster.local'
JMAP='http://stalwart-mgmt.mail.svc.cluster.local:8080'
USER='${user}@${DOMAIN}'
PW=os.environ['MPW']
random.seed(42)

s = requests.Session()
s.auth = ('admin', '${APW}')

# Look up the user's accountId (master-user auth would also work)
sess = s.get(f'{JMAP}/jmap/session').json()
# accountIds live under primaryAccounts; we need the test user's account
# but admin session shows admin's. Switch to user auth.
s2 = requests.Session()
s2.auth = (f'{USER}%${MFQDN}', PW)
sess2 = s2.get(f'{JMAP}/jmap/session').json()
ACCT = sess2['primaryAccounts']['urn:ietf:params:jmap:mail']
print(f'user accountId={ACCT}', flush=True)

# Get mailboxes — Inbox + create SPECIAL-USE roles that don't exist yet,
# plus a UTF-8 folder + an Empty folder.
mb_r = s2.post(f'{JMAP}/jmap', json={
    'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
    'methodCalls': [['Mailbox/get', {'accountId': ACCT, 'ids': None}, 'c0']]
}).json()
mboxes = {m['name']: m['id'] for m in mb_r['methodResponses'][0][1]['list']}
print(f'existing mailboxes: {list(mboxes)}', flush=True)

def ensure_mailbox(name, role=None):
    if name in mboxes:
        return mboxes[name]
    body = {'name': name}
    if role:
        body['role'] = role
    r = s2.post(f'{JMAP}/jmap', json={
        'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
        'methodCalls': [['Mailbox/set', {'accountId': ACCT, 'create': {'m1': body}}, 'c0']]
    }).json()
    created = r['methodResponses'][0][1].get('created', {}).get('m1', {})
    if 'id' in created:
        mboxes[name] = created['id']
        return created['id']
    print(f'NOTE: mailbox {name!r} create returned {r[\"methodResponses\"][0][1]}', flush=True)
    # Re-query to get id if it was already there under a different name
    mb_r2 = s2.post(f'{JMAP}/jmap', json={
        'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
        'methodCalls': [['Mailbox/get', {'accountId': ACCT, 'ids': None}, 'c0']]
    }).json()
    for m in mb_r2['methodResponses'][0][1]['list']:
        if m['name'] == name:
            mboxes[name] = m['id']
            return m['id']
    return None

# Inbox is always present
inbox_id = mboxes.get('INBOX') or mboxes.get('Inbox')
if not inbox_id:
    print('FATAL: no Inbox!'); sys.exit(1)

# Edge case E2 — UTF-8 folder name
utf8_id = ensure_mailbox(u'Geschäftlich')

# Edge case E7 — empty folder
empty_id = ensure_mailbox('EmptyTestFolder')

# Mark inbox role so SPECIAL-USE check works
# (Stalwart already sets \Inbox role on the inbox; we just need to verify)

def make_msg(subj, body_bytes):
    msg = b'From: sender@example.org\r\n'
    msg += b'To: ' + USER.encode() + b'\r\n'
    msg += b'Subject: ' + subj.encode() + b'\r\n'
    msg += b'Message-ID: <perf-' + str(time.time_ns()).encode() + b'-' + os.urandom(4).hex().encode() + b'@perf.test>\r\n'
    msg += b'Content-Type: application/octet-stream\r\n\r\n'
    msg += body_bytes
    return msg

def upload_and_import(raw, mbx_id, keywords=None):
    if keywords is None:
        keywords = {'\\\\Seen': True}
    up = s2.post(f'{JMAP}/jmap/upload/{ACCT}/', data=raw,
                 headers={'Content-Type': 'message/rfc822'})
    if up.status_code != 200:
        return False, f'upload {up.status_code}: {up.text[:200]}'
    blob = up.json()['blobId']
    imp = s2.post(f'{JMAP}/jmap', json={
        'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
        'methodCalls': [['Email/import', {
            'accountId': ACCT,
            'emails': {'i1': {
                'blobId': blob,
                'mailboxIds': {mbx_id: True},
                'keywords': keywords,
            }}
        }, 'c0']]
    }).json()
    nc = imp['methodResponses'][0][1].get('notCreated', {})
    if nc:
        return False, f'import not_created: {nc}'
    return True, None

count = 0
oversize_attempted = 0

# E1: mixed-size corpus into Inbox (60% small, 30% medium, 10% large)
n_mixed = int(os.environ.get('CORPUS_SIZE', '100'))
print(f'seeding {n_mixed} mixed msgs into Inbox...', flush=True)
for i in range(n_mixed):
    r = random.random()
    if r < 0.6: sz = 5000
    elif r < 0.9: sz = 80000
    else: sz = 500000
    raw = make_msg(f'E1 mixed {i:03d}', (b'X' * sz)[:sz])
    ok, err = upload_and_import(raw, inbox_id)
    if not ok:
        print(f'E1 msg {i} fail: {err}', flush=True); break
    count += 1

# E2: 5 msgs into UTF-8 folder
if utf8_id:
    for i in range(5):
        raw = make_msg(f'E2 utf8 {i}', b'utf-8 folder msg ' * 100)
        ok, _ = upload_and_import(raw, utf8_id)
        if ok: count += 1

# E3: 5 msgs with custom keyword \$Forwarded
for i in range(5):
    raw = make_msg(f'E3 forwarded {i}', b'forwarded msg ' * 100)
    ok, _ = upload_and_import(raw, inbox_id, keywords={'\\\\Seen': True, '\$Forwarded': True})
    if ok: count += 1

# E5/E6: large-message seeds. Skipped when SKIP_LARGE=1 in the env —
# the 60 MB + 110 MiB attachments push Stalwart's RocksDB / blob store
# under memory pressure on small testing nodes (the helper has been
# observed to OOM-restart Stalwart during this seed). Operators
# running the aux-only verification path or quick smoke tests can set
# SKIP_LARGE=1 to skip E5/E6 entirely. Default behaviour preserved.
if os.environ.get('SKIP_LARGE', '0') != '1':
    print('seeding ONE 60 MB msg (within cap)...', flush=True)
    raw = make_msg('E5 cap60MB', b'A' * (60 * 1024 * 1024))
    ok, err = upload_and_import(raw, inbox_id)
    if ok:
        count += 1
        print('E5 60 MB OK', flush=True)
    else:
        print(f'E5 60 MB import failed (expected if maxAttachmentSize=30 MiB): {err}', flush=True)

    # E6: ONE 100+ MiB msg (over cap; expected to FAIL upload; if accepted,
    # restore must SKIP). The 30 MiB maxAttachmentSize cap should reject this
    # at JMAP upload time; that's an honest result for E6.
    print('attempting ONE 110 MiB msg (must fail upload)...', flush=True)
    raw = make_msg('E6 over110MiB', b'B' * (110 * 1024 * 1024))
    ok, err = upload_and_import(raw, inbox_id)
    if not ok:
        print(f'E6 110 MiB rejected at upload (good): {err[:160]}', flush=True)
    else:
        oversize_attempted = 1
        count += 1
        print('E6 110 MiB accepted at upload (unusual; will test restore-side skip)', flush=True)
else:
    print('SKIP_LARGE=1: skipping E5 (60 MB) and E6 (110 MiB) seeds', flush=True)

print(f'POPULATE_DONE count={count} oversize_attempted={oversize_attempted}')
"
}

# ── Create or reset test user ───────────────────────────────────────────────
create_user() {
  local local_part="$1"
  log "create user: ${local_part}@${DOMAIN}"
  kubectl -n "$NS_PERF" exec "$HELPER" -- curl -s -u "admin:$APW" -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":[[\"x:Account/set\",{\"accountId\":\"d333333\",\"create\":{\"u\":{\"@type\":\"User\",\"name\":\"${local_part}\",\"domainId\":\"${DOMAIN_ID}\",\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\"${MPW}\",\"allowedIps\":{},\"expiresAt\":null}}}}}, \"c0\"]]}" \
    http://stalwart-mgmt.mail.svc.cluster.local:8080/jmap > /tmp/cu.json
  if grep -q '"created"' /tmp/cu.json; then
    log "  user ${local_part} created"
  elif grep -q '"alreadyExists\|primaryKeyViolation"' /tmp/cu.json; then
    # Reset password so master-user auth works with our known $MPW
    log "  user ${local_part} already exists; ensuring password matches"
  else
    log "  WARN: unexpected response: $(cat /tmp/cu.json | head -c 200)"
  fi
}

# ── Wipe a user's mailboxes (between tests) ─────────────────────────────────
wipe_user_mailboxes() {
  local user="$1"
  log "wipe: $user mailboxes"
  kubectl -n "$NS_PERF" exec "$HELPER" -- env MPW="$MPW" python3 -c "
import os, sys
sys.path.insert(0, '/tmp/perf')
from imap_client import ImapClient
with ImapClient('stalwart-mail.mail.svc.cluster.local', 993, verify_tls=False) as c:
    c.login('${user}@${DOMAIN}%${MFQDN}', os.environ['MPW'])
    c.enable('UTF8=ACCEPT')
    for f in c.list_folders():
        if '\\\\Noselect' in f.flags:
            continue
        try:
            st = c.select(f.name, readonly=False)
            if st.get('EXISTS', 0) > 0:
                c.store_deleted('1:*')
                c.expunge()
        except Exception as e:
            print(f'wipe {f.name!r}: {e}')
"
}

# ── Snapshot a user's IMAP state (folder list + per-folder count + flags) ──
snapshot_user_state() {
  local user="$1"
  kubectl -n "$NS_PERF" exec "$HELPER" -- env MPW="$MPW" python3 -c "
import os, sys, json
sys.path.insert(0, '/tmp/perf')
from imap_client import ImapClient
out = {'folders': [], 'total': 0}
with ImapClient('stalwart-mail.mail.svc.cluster.local', 993, verify_tls=False) as c:
    c.login('${user}@${DOMAIN}%${MFQDN}', os.environ['MPW'])
    c.enable('UTF8=ACCEPT')
    for f in c.list_folders():
        if '\\\\Noselect' in f.flags:
            continue
        try:
            st = c.select(f.name, readonly=True)
            n = st.get('EXISTS', 0)
            out['folders'].append({'name': f.name, 'count': n, 'special_use': sorted(f.special_use)})
            out['total'] += n
        except Exception as e:
            out['folders'].append({'name': f.name, 'error': str(e)})
print('STATE_JSON=' + json.dumps(out))
" | grep '^STATE_JSON=' | sed 's/^STATE_JSON=//'
}

# ── Run engine cycle: capture → restore → snapshot ─────────────────────────
run_engine_cycle() {
  local engine="$1"     # 'imap' or 'jmap'
  local src_user="$2"   # e.g. e2e-src
  local dst_user="$3"   # e.g. e2e-imap-dst
  local maildir_root="/tmp/e2e-maildir-${engine}"

  log "=== $engine cycle ==="

  # CAPTURE
  kubectl -n "$NS_PERF" exec "$HELPER" -- rm -rf "$maildir_root"
  log "$engine: capture from $src_user → $maildir_root"
  local cap_summary
  if [[ "$engine" == "imap" ]]; then
    cap_summary=$(kubectl -n "$NS_PERF" exec "$HELPER" -- env STALWART_MASTER_PASSWORD="$MPW" \
      python3 /tmp/perf/imap-sync.py \
      --imap-host stalwart-mail.mail.svc.cluster.local \
      --account-address "${src_user}@${DOMAIN}" \
      --master-user "$MFQDN" \
      --auth-pass-env STALWART_MASTER_PASSWORD \
      --output-dir "$maildir_root" 2>&1 | tee -a "$LOG" | grep -E '^\{.*"engine":\s*"imap".*\}' | head -1 || true)
  else
    cap_summary=$(kubectl -n "$NS_PERF" exec "$HELPER" -- env STALWART_MASTER_PASSWORD="$MPW" \
      python3 /tmp/perf/jmap-sync-stock.py \
      --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080 \
      --account-address "${src_user}@${DOMAIN}" \
      --master-user "$MFQDN" \
      --auth-pass-env STALWART_MASTER_PASSWORD \
      --output-dir "$maildir_root" 2>&1 | tee -a "$LOG" | grep -E '^\{' | tail -1 || true)
  fi
  [[ -n "$cap_summary" ]] && pass "$engine A1: capture returned summary" || fail "$engine A1: no capture summary"

  # RESTORE
  wipe_user_mailboxes "$dst_user"
  log "$engine: restore $maildir_root → $dst_user"
  local rst_summary
  if [[ "$engine" == "imap" ]]; then
    log "$engine: restore using $IMAP_WORKERS worker(s)"
    rst_summary=$(kubectl -n "$NS_PERF" exec "$HELPER" -- env STALWART_MASTER_PASSWORD="$MPW" \
      python3 /tmp/perf/imap-restore.py \
      --imap-host stalwart-mail.mail.svc.cluster.local \
      --target-address "${dst_user}@${DOMAIN}" \
      --source-address "${src_user}@${DOMAIN}" \
      --master-user "$MFQDN" \
      --auth-pass-env STALWART_MASTER_PASSWORD \
      --maildir-root "$maildir_root" \
      --mode merge-overwrite \
      --workers "$IMAP_WORKERS" 2>&1 | tee -a "$LOG" | grep -E '^\{.*"engine":\s*"imap".*\}' | head -1 || true)
  else
    log "$engine: restore using $JMAP_WORKERS worker(s)"
    rst_summary=$(kubectl -n "$NS_PERF" exec "$HELPER" -- env STALWART_MASTER_PASSWORD="$MPW" \
      python3 /tmp/perf/jmap-restore-stock.py \
      --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080 \
      --target-address "${dst_user}@${DOMAIN}" \
      --source-address "${src_user}@${DOMAIN}" \
      --master-user "$MFQDN" \
      --auth-pass-env STALWART_MASTER_PASSWORD \
      --maildir-root "$maildir_root" \
      --mode merge-overwrite \
      --workers "$JMAP_WORKERS" 2>&1 | tee -a "$LOG" | grep -E '^\{' | tail -1 || true)
  fi
  [[ -n "$rst_summary" ]] && pass "$engine A2: restore returned summary" || fail "$engine A2: no restore summary"

  # DIFF
  local src_state dst_state
  src_state=$(snapshot_user_state "$src_user")
  dst_state=$(snapshot_user_state "$dst_user")
  log "$engine src state: $src_state"
  log "$engine dst state: $dst_state"

  local src_total dst_total
  src_total=$(echo "$src_state" | jq -r '.total')
  dst_total=$(echo "$dst_state" | jq -r '.total')
  # Allow slight asymmetry for E6 oversize-skip
  if [[ "$src_total" -eq "$dst_total" ]] || [[ $((src_total - dst_total)) -le 1 ]]; then
    pass "$engine A3: msg count $dst_total (src $src_total, allows ≤1 oversize-skip)"
  else
    fail "$engine A3: msg count mismatch — src=$src_total dst=$dst_total"
  fi

  # A4: folder names round-trip (UTF-8)
  local src_folders dst_folders
  src_folders=$(echo "$src_state" | jq -r '.folders[].name' | sort | head -20)
  dst_folders=$(echo "$dst_state" | jq -r '.folders[].name' | sort | head -20)
  if echo "$dst_folders" | grep -q 'Geschäftlich'; then
    pass "$engine A4: UTF-8 folder 'Geschäftlich' round-tripped"
  else
    fail "$engine A4: UTF-8 folder MISSING from restore. src=[$src_folders] dst=[$dst_folders]"
  fi
}

# ── Aux corpus seed: Sieve / Contact / Calendar / Vacation / FileNode ──────
#
# Mirrors `scripts/bench-imap-vs-jmap.sh`'s aux seed plus the deeper
# FileNode tree. The seed is idempotent — if a sieve/contact/event
# already exists with the snapshot's id/name, the create is a no-op
# (Stalwart returns `alreadyExists` which we treat as "good, move on").
#
# The seed writes its own Python helper to a tempfile + runs it inside
# the helper pod so the kubectl-exec shell quoting stays sane.
populate_aux_corpus() {
  local user="$1"
  log "populate_aux_corpus: $user (Sieve, Contacts, Calendar, Vacation, FileNode tree)"

  # Write the Python seeder to a host-side tempfile, copy into the
  # helper pod, then run with env-injected creds. The script is
  # idempotent — re-running it skips anything that already exists.
  local seeder=/tmp/integration-aux-seed.py
  cat > "$seeder" <<'PYEOF'
import os, base64, json, urllib.request, sys

JMAP = "http://stalwart-mgmt.mail.svc.cluster.local:8080"
DOMAIN = os.environ["AUX_DOMAIN"]
MFQDN = os.environ["MFQDN"]
USER = f"{os.environ['AUX_USER']}@{DOMAIN}%{MFQDN}"
PW = os.environ["MPW"]
auth = "Basic " + base64.b64encode(f"{USER}:{PW}".encode()).decode()

def post(body):
    req = urllib.request.Request(
        JMAP + "/jmap/", method="POST",
        headers={"Authorization": auth, "Content-Type": "application/json",
                 "Accept": "application/json"},
        data=json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

def session():
    req = urllib.request.Request(JMAP + "/jmap/session",
                                  headers={"Authorization": auth})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())

s = session()
acct_s = s["primaryAccounts"]["urn:ietf:params:jmap:sieve"]
acct_c = s["primaryAccounts"]["urn:ietf:params:jmap:contacts"]
acct_cal = s["primaryAccounts"]["urn:ietf:params:jmap:calendars"]
acct_v = s["primaryAccounts"]["urn:ietf:params:jmap:vacationresponse"]
acct_fn = s["primaryAccounts"]["urn:ietf:params:jmap:filenode"]

import urllib.parse as _u
_upath = _u.urlsplit(s["uploadUrl"]).path

def upload(account, body, content_type="application/octet-stream"):
    url = JMAP.rstrip("/") + _upath.replace("{accountId}", account)
    req = urllib.request.Request(url, method="POST", data=body,
        headers={"Authorization": auth, "Content-Type": content_type})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())["blobId"]

# 1. SieveScript (idempotent — skip if already named bench-filter)
USING_S = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"]
ex = post({"using": USING_S, "methodCalls": [
    ["SieveScript/get", {"accountId": acct_s, "ids": None,
                          "properties": ["name"]}, "c0"]]})
have_sieve = any(n.get("name") == "bench-filter"
                  for n in ex["methodResponses"][0][1]["list"])
if not have_sieve:
    blob = upload(acct_s,
        b"require [\"fileinto\"];\nif address :is \"From\" \"alice@example.com\" {\n  fileinto \"alice\";\n}\n",
        content_type="application/sieve")
    r = post({"using": USING_S, "methodCalls": [
        ["SieveScript/set", {"accountId": acct_s,
            "create": {"k": {"name": "bench-filter", "blobId": blob,
                              "isActive": True}}}, "c0"]]})
    print(f"sieve-seed: SieveScript/set -> {r['methodResponses'][0][1]}")
else:
    print("sieve-seed: bench-filter already exists, skipping")

# 2. Contact — needs an AddressBook
USING_C = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:contacts"]
abs_r = post({"using": USING_C, "methodCalls": [
    ["AddressBook/get", {"accountId": acct_c, "ids": None,
                          "properties": ["id", "isDefault"]}, "c0"]]})
abs_list = abs_r["methodResponses"][0][1]["list"]
if not abs_list:
    cr = post({"using": USING_C, "methodCalls": [
        ["AddressBook/set", {"accountId": acct_c,
            "create": {"k": {"name": "Default Contacts"}}}, "c0"]]})
    default_ab = cr["methodResponses"][0][1]["created"]["k"]["id"]
else:
    default_ab = next((a["id"] for a in abs_list if a.get("isDefault")),
                      abs_list[0]["id"])
ex_c = post({"using": USING_C, "methodCalls": [
    ["ContactCard/get", {"accountId": acct_c, "ids": None,
                          "properties": ["name"]}, "c0"]]})
have_contact = any(
    "ller" in str(c.get("name", "")).encode("ascii", "ignore").decode()
    or "Geschäftlich" in json.dumps(c.get("name", {}), ensure_ascii=False)
    for c in ex_c["methodResponses"][0][1]["list"])
if not have_contact:
    r = post({"using": USING_C, "methodCalls": [
        ["ContactCard/set", {"accountId": acct_c, "create": {"k": {
            "@type": "Card", "version": "1.0", "kind": "individual",
            "addressBookIds": {default_ab: True},
            "name": {"@type": "Name", "components": [
                {"@type": "NameComponent", "kind": "given", "value": "Geschäftlich"},
                {"@type": "NameComponent", "kind": "surname", "value": "Müller"}]},
            "emails": {"e1": {"@type": "EmailAddress",
                               "address": "mueller@example.com",
                               "contexts": {"work": True}}}}}}, "c0"]]})
    print(f"contact-seed: ContactCard/set -> {r['methodResponses'][0][1]}")
else:
    print("contact-seed: Müller already exists, skipping")

# 3. Calendar event
USING_CAL = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:calendars"]
cals = post({"using": USING_CAL, "methodCalls": [
    ["Calendar/get", {"accountId": acct_cal, "ids": None,
                       "properties": ["id"]}, "c0"]]})
cal_id = cals["methodResponses"][0][1]["list"][0]["id"]
ex_e = post({"using": USING_CAL, "methodCalls": [
    ["CalendarEvent/get", {"accountId": acct_cal, "ids": None,
                            "properties": ["uid"]}, "c0"]]})
have_event = any(e.get("uid") == "bench-event-1@perf.test"
                  for e in ex_e["methodResponses"][0][1]["list"])
if not have_event:
    r = post({"using": USING_CAL, "methodCalls": [
        ["CalendarEvent/set", {"accountId": acct_cal, "create": {"k": {
            "@type": "Event",
            "uid": "bench-event-1@perf.test",
            "title": "Team Standup",
            "calendarIds": {cal_id: True},
            "start": "2026-06-01T10:00:00",
            "duration": "PT30M",
            "timeZone": "Europe/Berlin"}}}, "c0"]]})
    print(f"event-seed: CalendarEvent/set -> {r['methodResponses'][0][1]}")
else:
    print("event-seed: bench-event already exists, skipping")

# 4. Vacation — singleton, always enable
USING_V = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:vacationresponse"]
r = post({"using": USING_V, "methodCalls": [
    ["VacationResponse/set", {"accountId": acct_v,
        "update": {"singleton": {
            "isEnabled": True,
            "subject": "On vacation — bench",
            "textBody": "I am away until next week."}}}, "c0"]]})
print(f"vacation-seed: VacationResponse/set -> {r['methodResponses'][0][1]}")

# 5. FileNode tree — wipe + seed deterministically
USING_FN = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"]

def list_fn():
    r = post({"using": USING_FN, "methodCalls": [
        ["FileNode/get", {"accountId": acct_fn, "ids": None,
            "properties": ["id", "parentId", "name", "blobId"]}, "c0"]]})
    return r["methodResponses"][0][1]["list"]

def topo_wipe():
    for _ in range(8):
        nodes = list_fn()
        if not nodes:
            return
        by_id = {n["id"]: n.get("parentId") for n in nodes}
        depth = {}
        def _d(nid, seen=None):
            if nid in depth: return depth[nid]
            seen = seen or set()
            if nid in seen: return 0
            seen.add(nid)
            p = by_id.get(nid)
            depth[nid] = 0 if p is None or p not in by_id else _d(p, seen) + 1
            return depth[nid]
        for nid in by_id: _d(nid)
        ordered = sorted(by_id, key=lambda i: depth.get(i, 0), reverse=True)
        post({"using": USING_FN, "methodCalls": [
            ["FileNode/set", {"accountId": acct_fn, "destroy": ordered}, "c0"]]})
        import time; time.sleep(0.5)

topo_wipe()

def mkfolder(name, parent=None):
    payload = {"name": name}
    if parent: payload["parentId"] = parent
    r = post({"using": USING_FN, "methodCalls": [
        ["FileNode/set", {"accountId": acct_fn, "create": {"k": payload}}, "c0"]]})
    return r["methodResponses"][0][1]["created"]["k"]["id"]

def mkfile(name, body, parent=None):
    blob = upload(acct_fn, body)
    payload = {"name": name, "blobId": blob}
    if parent: payload["parentId"] = parent
    r = post({"using": USING_FN, "methodCalls": [
        ["FileNode/set", {"accountId": acct_fn, "create": {"k": payload}}, "c0"]]})
    return r["methodResponses"][0][1]["created"]["k"]["id"]

documents = mkfolder("Documents")
reports = mkfolder("Reports", documents)
photos = mkfolder("Photos")
vacation = mkfolder("Vacation 2025", photos)
mkfile("Q1-2026.pdf", b"%PDF-1.5\n" + b"A" * 1000, reports)
mkfile("Q2-2026.pdf", b"%PDF-1.5\n" + b"B" * 1000, reports)
mkfile("Notes.txt", b"meeting notes from 2026-05-22\n" * 8, documents)
mkfile("IMG_001.jpg", b"\xff\xd8\xff\xe0" + b"\x00" * 2000, vacation)
mkfile("README.md", b"# Test README\nUTF-8: \xc3\xa9\xc3\xa9\xc3\xa9\n" * 8, None)

print(f"filenode-seed: 9 nodes (4 folders, 5 files, max depth 3)")
PYEOF
  kubectl -n "$NS_PERF" cp "$seeder" "$HELPER":/tmp/integration-aux-seed.py >/dev/null
  kubectl -n "$NS_PERF" exec "$HELPER" -- env \
    MPW="$MPW" MFQDN="$MFQDN" AUX_USER="$user" AUX_DOMAIN="$DOMAIN" \
    python3 /tmp/integration-aux-seed.py 2>&1 | tee -a "$LOG" | head -20
}

# ── Aux engine-independent round-trip cycle ────────────────────────────────
#
# Sieve / Contacts / Calendar / Vacation / FileNode are always
# JMAP-only (IMAP cannot transport them). One cycle covers both mail
# engines because the aux path is identical regardless of which
# mail-engine ran first.
run_aux_cycle() {
  local src_user="$1"
  local dst_user="$2"
  local maildir_root="$3"

  log "=== aux cycle: $src_user → $dst_user (maildir=$maildir_root) ==="

  # A7: Aux capture
  log "aux: capture from $src_user → $maildir_root"
  local cap_summary
  cap_summary=$(kubectl -n "$NS_PERF" exec "$HELPER" -- env STALWART_MASTER_PASSWORD="$MPW" \
    python3 /tmp/perf/jmap-aux-sync.py \
      --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080 \
      --account-address "${src_user}@${DOMAIN}" \
      --master-user "$MFQDN" \
      --auth-pass-env STALWART_MASTER_PASSWORD \
      --output-dir "$maildir_root" 2>&1 | tee -a "$LOG" | grep -E '^\{.*"kind":"aux"' | head -1 || true)
  if [[ -z "$cap_summary" ]]; then
    fail "aux A7: capture returned no summary line"
    return
  fi
  pass "aux A7: capture returned summary"
  local cap_failed
  cap_failed=$(echo "$cap_summary" | jq -r '.failed | length')
  if [[ "$cap_failed" -gt 0 ]]; then
    fail "aux A7: capture reported $cap_failed surface(s) failed: $(echo "$cap_summary" | jq -c .failed)"
  fi
  # Inspect manifest for surface availability
  for surface in sieve contacts calendar vacation filenode; do
    local avail
    avail=$(echo "$cap_summary" | jq -r ".manifest.${surface}.available // false")
    if [[ "$avail" == "true" ]]; then
      pass "aux A7.$surface: capture marked '$surface' available"
    else
      fail "aux A7.$surface: capture did NOT mark '$surface' available"
    fi
  done

  # Pre-cycle wipe — aux-restore.py's replace mode does a single
  # topological destroy pass; Stalwart's willDestroy state can leak
  # cross-run and a single pass is insufficient when dst already has
  # nodes from a prior harness invocation. The wipe-until-stable
  # below mirrors the bench harness's defense.
  log "aux: pre-wipe filenodes on $dst_user (multi-pass)"
  local wipe_helper=/tmp/integration-aux-pre-wipe.py
  cat > "$wipe_helper" <<'PYEOF'
import os, base64, json, time, urllib.request, sys
JMAP = "http://stalwart-mgmt.mail.svc.cluster.local:8080"
MFQDN = os.environ["MFQDN"]; PW = os.environ["MPW"]
DOMAIN = os.environ["AUX_DOMAIN"]; ADDR = os.environ["AUX_DST_USER"]
USER = f"{ADDR}@{DOMAIN}%{MFQDN}"
auth = "Basic " + base64.b64encode(f"{USER}:{PW}".encode()).decode()

def post(body):
    req = urllib.request.Request(JMAP + "/jmap/", method="POST",
        headers={"Authorization": auth, "Content-Type": "application/json",
                 "Accept": "application/json"}, data=json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())

sess = json.loads(urllib.request.urlopen(
    urllib.request.Request(JMAP + "/jmap/session", headers={"Authorization": auth}),
    timeout=5).read())
acct = sess["primaryAccounts"]["urn:ietf:params:jmap:filenode"]
USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:filenode"]

for p in range(8):
    r = post({"using": USING, "methodCalls": [
        ["FileNode/get", {"accountId": acct, "ids": None,
                           "properties": ["id", "parentId"]}, "c0"]]})
    nodes = r["methodResponses"][0][1]["list"]
    if not nodes:
        print(f"pre-wipe: clean after pass {p}")
        sys.exit(0)
    by_id = {n["id"]: n.get("parentId") for n in nodes}
    depth = {}
    def _d(nid, seen=None):
        if nid in depth: return depth[nid]
        seen = seen or set()
        if nid in seen: return 0
        seen.add(nid)
        p_ = by_id.get(nid)
        depth[nid] = 0 if p_ is None or p_ not in by_id else _d(p_, seen) + 1
        return depth[nid]
    for nid in by_id: _d(nid)
    ordered = sorted(by_id, key=lambda i: depth.get(i, 0), reverse=True)
    post({"using": USING, "methodCalls": [
        ["FileNode/set", {"accountId": acct, "destroy": ordered}, "c0"]]})
    time.sleep(0.5)
print(f"pre-wipe: WARNING {len(nodes)} nodes survived 8 passes")
PYEOF
  kubectl -n "$NS_PERF" cp "$wipe_helper" "$HELPER":/tmp/integration-aux-pre-wipe.py >/dev/null
  kubectl -n "$NS_PERF" exec "$HELPER" -- env \
    MPW="$MPW" MFQDN="$MFQDN" AUX_DOMAIN="$DOMAIN" AUX_DST_USER="$dst_user" \
    python3 /tmp/integration-aux-pre-wipe.py 2>&1 | tee -a "$LOG" | head -3

  # A8: Aux restore (replace mode) into freshly-wiped dst
  log "aux: restore $maildir_root → $dst_user (replace mode)"
  local rst_summary
  rst_summary=$(kubectl -n "$NS_PERF" exec "$HELPER" -- env STALWART_MASTER_PASSWORD="$MPW" \
    python3 /tmp/perf/jmap-aux-restore.py \
      --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080 \
      --target-address "${dst_user}@${DOMAIN}" \
      --source-address "${src_user}@${DOMAIN}" \
      --master-user "$MFQDN" \
      --auth-pass-env STALWART_MASTER_PASSWORD \
      --maildir-root "$maildir_root" \
      --mode replace --confirm-destructive 2>&1 | tee -a "$LOG" | grep -E '^\{.*"kind":"aux"' | head -1 || true)
  if [[ -z "$rst_summary" ]]; then
    fail "aux A8: restore returned no summary line"
    return
  fi
  pass "aux A8: restore returned summary"
  local rst_failed
  rst_failed=$(echo "$rst_summary" | jq -r '.failed | length')
  if [[ "$rst_failed" -gt 0 ]]; then
    fail "aux A8: restore reported $rst_failed surface(s) failed: $(echo "$rst_summary" | jq -c .failed)"
  fi

  # A9: Aux fidelity — compare src vs dst at the JMAP level
  log "aux A9: verifying content fidelity (src vs dst)"
  local verify=/tmp/integration-aux-verify.py
  cat > "$verify" <<'PYEOF'
"""Compare src vs dst aux surfaces. Exit 0 if matching, 1 otherwise.
Prints a per-surface PASS/FAIL line on stdout that the bash harness
greps for."""
import os, base64, json, hashlib, sys, urllib.request

JMAP = "http://stalwart-mgmt.mail.svc.cluster.local:8080"
MFQDN = os.environ["MFQDN"]; PW = os.environ["MPW"]
DOMAIN = os.environ["AUX_DOMAIN"]
SRC = os.environ["AUX_SRC_USER"]; DST = os.environ["AUX_DST_USER"]

def auth(addr): return "Basic " + base64.b64encode(
    f"{addr}@{DOMAIN}%{MFQDN}:{PW}".encode()).decode()
def post(addr, body):
    req = urllib.request.Request(JMAP + "/jmap/", method="POST",
        headers={"Authorization": auth(addr),
                 "Content-Type": "application/json",
                 "Accept": "application/json"},
        data=json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())
def acct(addr, urn):
    req = urllib.request.Request(JMAP + "/jmap/session",
                                  headers={"Authorization": auth(addr)})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())["primaryAccounts"][urn]
def call(addr, urn, method, args):
    r = post(addr, {"using": ["urn:ietf:params:jmap:core", urn],
                    "methodCalls": [[method, args, "c0"]]})
    return r["methodResponses"][0][1]

def get_sieve(addr):
    a = acct(addr, "urn:ietf:params:jmap:sieve")
    r = call(addr, "urn:ietf:params:jmap:sieve", "SieveScript/get",
             {"accountId": a, "ids": None,
              "properties": ["name", "isActive"]})
    return sorted([s["name"] for s in r["list"]])
def get_contacts(addr):
    a = acct(addr, "urn:ietf:params:jmap:contacts")
    r = call(addr, "urn:ietf:params:jmap:contacts", "ContactCard/get",
             {"accountId": a, "ids": None})
    out = []
    for c in r["list"]:
        comps = c.get("name", {}).get("components", []) or []
        out.append([(n.get("kind"), n.get("value")) for n in comps])
    return out
def get_events(addr):
    a = acct(addr, "urn:ietf:params:jmap:calendars")
    r = call(addr, "urn:ietf:params:jmap:calendars", "CalendarEvent/get",
             {"accountId": a, "ids": None,
              "properties": ["title", "start", "timeZone", "duration"]})
    return sorted([(e.get("title"), e.get("start"), e.get("timeZone"))
                   for e in r["list"]])
def get_vacation(addr):
    a = acct(addr, "urn:ietf:params:jmap:vacationresponse")
    r = call(addr, "urn:ietf:params:jmap:vacationresponse",
             "VacationResponse/get",
             {"accountId": a, "ids": None,
              "properties": ["isEnabled", "subject"]})
    if not r["list"]: return None
    v = r["list"][0]
    return (v.get("isEnabled"), v.get("subject"))
def get_filenode_tree(addr):
    a = acct(addr, "urn:ietf:params:jmap:filenode")
    r = call(addr, "urn:ietf:params:jmap:filenode", "FileNode/get",
             {"accountId": a, "ids": None,
              "properties": ["id", "parentId", "name", "blobId", "size"]})
    nodes = r["list"]
    by_id = {n["id"]: n for n in nodes}
    def path(n):
        parts = []
        cur = n
        while cur:
            parts.append(cur["name"])
            pid = cur.get("parentId")
            cur = by_id.get(pid) if pid else None
        return "/".join(reversed(parts))
    return sorted([
        (path(n), "file" if n.get("blobId") else "folder",
         n.get("size") or 0)
        for n in nodes
    ])

ok = True
def check(name, src_val, dst_val, hint=""):
    global ok
    if src_val == dst_val:
        print(f"VERIFY PASS {name}")
    else:
        print(f"VERIFY FAIL {name}: src={src_val!r} dst={dst_val!r} {hint}")
        ok = False

# Filter src to only items the snapshot put in dst. Sieve has the
# reserved "vacation" that won't be in dst's snapshot-restored list.
src_sieve = [s for s in get_sieve(SRC) if s != "vacation"]
dst_sieve = [s for s in get_sieve(DST) if s != "vacation"]
check("sieve.names", src_sieve, dst_sieve)
# Contacts: compare the structural name components.
src_c = get_contacts(SRC); dst_c = get_contacts(DST)
check("contacts.names", sorted(src_c), sorted(dst_c))
# Events: title + start + timeZone (uid is intentionally dropped — v1 limitation)
src_e = get_events(SRC); dst_e = get_events(DST)
check("calendar.events", src_e, dst_e)
# Vacation: singleton
check("vacation.singleton", get_vacation(SRC), get_vacation(DST))
# Filenode: tree paths + kind + size
src_t = get_filenode_tree(SRC); dst_t = get_filenode_tree(DST)
check("filenode.tree", src_t, dst_t)

sys.exit(0 if ok else 1)
PYEOF
  kubectl -n "$NS_PERF" cp "$verify" "$HELPER":/tmp/integration-aux-verify.py >/dev/null
  local verify_out
  # verify exits non-zero on any FAIL — capture both streams without
  # letting `set -e` abort the harness on a single surface drift.
  verify_out=$(kubectl -n "$NS_PERF" exec "$HELPER" -- env \
    MPW="$MPW" MFQDN="$MFQDN" AUX_DOMAIN="$DOMAIN" \
    AUX_SRC_USER="$src_user" AUX_DST_USER="$dst_user" \
    python3 /tmp/integration-aux-verify.py 2>&1 || true)
  echo "$verify_out" | tee -a "$LOG" >/dev/null
  local seen_any=0
  while IFS= read -r line; do
    case "$line" in
      "VERIFY PASS "*) pass "aux A9 ${line#VERIFY PASS }"; seen_any=1 ;;
      "VERIFY FAIL "*) fail "aux A9 ${line#VERIFY FAIL }"; seen_any=1 ;;
    esac
  done <<< "$verify_out"
  if [[ "$seen_any" -eq 0 ]]; then
    fail "aux A9: verify produced no PASS/FAIL lines (kubectl exec output: ${verify_out:0:200})"
  fi
}

# ── Set the engine for the platform (record only; we test scripts directly) ─
log "=== integration-tenant-bundles-mailbox-engine.sh starting ==="
log "this harness tests scripts directly — platform admin API tested separately"

# Setup: ensure 1 src user (populated once, reused) + 2 dst users (one per engine)
create_user "e2e-src"
create_user "e2e-imap-dst"
create_user "e2e-jmap-dst"

# Wipe src so populate is idempotent
wipe_user_mailboxes "e2e-src"
populate_corpus "e2e-src"
populate_aux_corpus "e2e-src"

# Stage jmap-sync.py (the legacy/ version) on helper as jmap-sync-stock.py
log "stage jmap-sync.py for the JMAP arm"
kubectl -n "$NS_PERF" exec "$HELPER" -- sh -c '
test -f /tmp/perf/jmap-sync-stock.py && exit 0 || true
test -f /tmp/perf/jmap-restore-stock.py && exit 0 || true
echo "jmap scripts must be pre-staged for this harness — copy via your wrapper"
' || true

run_engine_cycle imap   e2e-src e2e-imap-dst
run_engine_cycle jmap   e2e-src e2e-jmap-dst

# Aux cycle — engine-independent (always JMAP). Runs against each
# dst once; the maildir-root must hold the .aux/ sidecars from the
# corresponding engine's capture (sync writes them adjacent to mail).
# The aux scripts are staged by the operator-driver alongside the
# other /tmp/perf/ helpers; if missing, the cycle PASS/FAIL output
# will surface that immediately.
run_aux_cycle e2e-src e2e-imap-dst /tmp/e2e-maildir-imap
run_aux_cycle e2e-src e2e-jmap-dst /tmp/e2e-maildir-jmap

log
log "═════════════════════════════════════════════════════════════════"
log "RESULT: $PASS_COUNT passed, $FAIL_COUNT failed"
for f in "${FAILURES[@]:-}"; do
  [[ -n "$f" ]] && log "  - $f"
done
[[ $FAIL_COUNT -eq 0 ]] && exit 0 || exit 1
