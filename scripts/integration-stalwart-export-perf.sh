#!/usr/bin/env bash
# integration-stalwart-export-perf.sh
#
# Measures FULL-MAILBOX export/import throughput for two paths Stalwart
# exposes today, on a single-node test cluster:
#
#   JMAP  — per-account, what `tenant-bundles/components/mailboxes.ts`
#           uses (Email/changes + Email/get + Blob/get → Maildir → tar)
#   CLI   — whole-server `stalwart -e/-i` (only LZ4 dump format the
#           current Stalwart 0.16 binary supports)
#
# Pure-protocol measurement — bypasses the platform-api orchestration
# layer entirely. Creates one test domain + one mailbox directly via
# Stalwart `urn:stalwart:jmap` Principal/set, populates N messages
# directly via `Email/import`, then times each path.
#
# DESTRUCTIVE on the target Stalwart: wipes principals + data dir.
# Only run against a clean/test Stalwart. testing.phoenix-host.net OK.
#
# Phases:
#   P0 setup    — auth via Stalwart admin creds, probe accountId
#   P1 provision — create test domain + bench user via JMAP Principal/set
#   P2 populate  — N messages, mixed sizes (60% 5KB / 30% 80KB / 10% 500KB)
#   P3 measure   — A) JMAP export (time + bytes + msgs/sec)
#                  B) CLI -e Path A (scale-to-0, one-shot pod) [skipped if --no-cli]
#                  C) JMAP import into a second fresh account
#                  D) CLI -i Path A (scale-to-0, wipe DataStore, -i) [skipped if --no-cli]
#   P4 report    — markdown to /tmp/export-perf-report.md
#
# Designed to run ON the testing node (kubectl in PATH).

set -euo pipefail

NS_MAIL="${NS_MAIL:-mail}"
NS_PERF="${NS_PERF:-export-perf}"
MSG_COUNT="${MSG_COUNT:-1000}"
LOG="${LOG:-/tmp/export-perf.log}"
REPORT="${REPORT:-/tmp/export-perf-report.md}"
RESULTS="${RESULTS:-/tmp/export-perf-results}"
SKIP_CLI="${SKIP_CLI:-0}"

DOMAIN="${DOMAIN:-mailperf-bench.net}"
USER_LOCAL="${USER_LOCAL:-bench}"
USER2_LOCAL="${USER2_LOCAL:-bench-restore}"

HELPER_POD="export-perf-helper"
HELPER_IMAGE="python:3.12-alpine"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
die() { log "FAIL: $*"; exit 1; }

# ─── helper pod (long-lived, has python+curl) ────────────────────────────────
ensure_ns() {
  kubectl get ns "$NS_PERF" >/dev/null 2>&1 || kubectl create ns "$NS_PERF" >/dev/null
  kubectl -n "$NS_PERF" delete pod "$HELPER_POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    kubectl -n "$NS_PERF" get pod "$HELPER_POD" >/dev/null 2>&1 || break
    sleep 1
  done
  kubectl -n "$NS_PERF" run "$HELPER_POD" \
    --image="$HELPER_IMAGE" --restart=Never \
    --overrides='{"spec":{"containers":[{"name":"helper","image":"'"$HELPER_IMAGE"'","command":["sh","-c","apk add --no-cache curl jq >/dev/null 2>&1; pip install --quiet --no-warn-script-location requests 2>/dev/null; sleep 86400"],"resources":{"requests":{"memory":"128Mi","cpu":"100m"},"limits":{"memory":"512Mi","cpu":"1000m"}}}]}}' \
    >/dev/null
  for _ in $(seq 1 90); do
    [[ "$(kubectl -n "$NS_PERF" get pod "$HELPER_POD" -o jsonpath='{.status.phase}' 2>/dev/null)" == "Running" ]] && {
      for _ in $(seq 1 60); do
        kubectl -n "$NS_PERF" exec "$HELPER_POD" -- python3 -c 'import requests' >/dev/null 2>&1 && return 0
        sleep 1
      done
      die "helper pod up but python3+requests not ready"
    }
    sleep 2
  done
  die "helper pod did not reach Running in 180s"
}

helper_run() {
  kubectl -n "$NS_PERF" exec -i "$HELPER_POD" -- "$@"
}

# ─── Stalwart admin auth ────────────────────────────────────────────────────
ADMIN_USER=""
ADMIN_PASS=""
STALWART_URL="http://stalwart-mgmt.mail.svc.cluster.local:8080"
ADMIN_ACCOUNT_ID=""

p0_setup() {
  log "P0: ensuring helper pod"
  ensure_ns

  log "P0: reading Stalwart admin credentials"
  ADMIN_USER="admin"
  ADMIN_PASS=$(kubectl -n "$NS_MAIL" get secret stalwart-admin-creds -o jsonpath='{.data.adminPassword}' | base64 -d)
  [[ -n "$ADMIN_PASS" ]] || die "no admin password"

  log "P0: probing JMAP session"
  local sess
  sess=$(helper_run curl -s -u "${ADMIN_USER}:${ADMIN_PASS}" "${STALWART_URL}/jmap/session")
  ADMIN_ACCOUNT_ID=$(echo "$sess" | jq -r '.primaryAccounts."urn:ietf:params:jmap:mail" // empty')
  [[ -n "$ADMIN_ACCOUNT_ID" ]] || die "no admin accountId in session: $sess"
  log "P0: admin accountId=$ADMIN_ACCOUNT_ID"
}

# ─── P1 provision ────────────────────────────────────────────────────────────
USER_PASS=""
USER_ACCOUNT_ID=""
USER2_PASS=""
USER2_ACCOUNT_ID=""

jmap_call() {
  # $1 = JSON body. Use -s (no -f) so we see Stalwart's error body.
  helper_run curl -s -u "${ADMIN_USER}:${ADMIN_PASS}" \
    -X POST -H 'Content-Type: application/json' \
    -d "$1" "${STALWART_URL}/jmap"
}

# Stalwart 0.16 uses its own `urn:stalwart:jmap` capability and the
# `x:Domain/*` + `x:Account/*` methods. Standard JMAP `Principal/*` is
# NOT implemented (returns notRequest).
create_domain() {
  local name="$1"
  local body
  body=$(jq -n --arg aid "$ADMIN_ACCOUNT_ID" --arg n "$name" '{
    using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
    methodCalls: [["x:Domain/set", {accountId: $aid, create: {"d1": {name: $n}}}, "c0"]]
  }')
  jmap_call "$body"
}

create_account() {
  # $1 = local part (e.g. "bench"), $2 = password, $3 = domain ID
  local local_part="$1" pass="$2" dom_id="$3"
  local body
  body=$(jq -n --arg aid "$ADMIN_ACCOUNT_ID" --arg lp "$local_part" --arg pw "$pass" --arg did "$dom_id" '{
    using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
    methodCalls: [["x:Account/set", {
      accountId: $aid,
      create: {
        "u1": {
          "@type": "User",
          name: $lp,
          domainId: $did,
          credentials: { "0": { "@type": "Password", secret: $pw, allowedIps: {}, expiresAt: null } }
        }
      }
    }, "c0"]]
  }')
  jmap_call "$body"
}

p1_provision() {
  log "P1: creating test domain $DOMAIN"
  local r
  r=$(create_domain "$DOMAIN" || true)
  local domain_id
  domain_id=$(echo "$r" | jq -r '.methodResponses[0][1].created.d1.id // empty')
  if [[ -z "$domain_id" ]]; then
    # might already exist — query it
    local nc
    nc=$(echo "$r" | jq -r '.methodResponses[0][1].notCreated.d1.type // empty')
    case "$nc" in
      alreadyExists|primaryKeyViolation) ;;
      *) die "domain create failed: $r" ;;
    esac
    domain_id=$(echo "$r" | jq -r '.methodResponses[0][1].notCreated.d1.objectId.id // empty')
    if [[ -z "$domain_id" ]]; then
      log "P1: domain exists but id not in response, querying"
      local qbody
      qbody=$(jq -n --arg aid "$ADMIN_ACCOUNT_ID" --arg n "$DOMAIN" '{
        using: ["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
        methodCalls: [["x:Domain/query", {accountId: $aid, filter: {name: $n}}, "c0"]]
      }')
      domain_id=$(jmap_call "$qbody" | jq -r '.methodResponses[0][1].ids[0] // empty')
    fi
    [[ -n "$domain_id" ]] || die "could not resolve existing domain id"
  fi
  log "P1: domain_id=$domain_id"

  USER_PASS="BenchP4ss!$(date +%s)"
  USER2_PASS="${USER_PASS}_R"

  ensure_account() {
    # $1 local part, $2 password
    local lp="$1" pw="$2" resp ok_id
    resp=$(create_account "$lp" "$pw" "$domain_id" || true)
    ok_id=$(echo "$resp" | jq -r '.methodResponses[0][1].created.u1.id // empty')
    if [[ -z "$ok_id" ]]; then
      local nc
      nc=$(echo "$resp" | jq -r '.methodResponses[0][1].notCreated.u1.type // empty')
      case "$nc" in
        primaryKeyViolation|alreadyExists)
          log "P1: account $lp already exists — resetting password"
          # Look up existing id
          local existing_id
          existing_id=$(echo "$resp" | jq -r '.methodResponses[0][1].notCreated.u1.objectId.id // empty')
          if [[ -z "$existing_id" ]]; then
            local qbody
            qbody=$(jq -n --arg aid "$ADMIN_ACCOUNT_ID" --arg lp "$lp" '{
              using: ["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
              methodCalls: [["x:Account/query", {accountId: $aid, filter: {name: $lp}}, "c0"]]
            }')
            existing_id=$(jmap_call "$qbody" | jq -r '.methodResponses[0][1].ids[0] // empty')
          fi
          [[ -n "$existing_id" ]] || die "can not resolve existing account $lp"
          # Reset password so the populator can auth as this user.
          local upd
          upd=$(jq -n --arg aid "$ADMIN_ACCOUNT_ID" --arg id "$existing_id" --arg pw "$pw" '{
            using: ["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
            methodCalls: [["x:Account/set", {
              accountId: $aid,
              update: { ($id): { credentials: { "0": { "@type": "Password", secret: $pw, allowedIps: {}, expiresAt: null } } } }
            }, "c0"]]
          }')
          jmap_call "$upd" | jq -e '.methodResponses[0][1].updated // .methodResponses[0][1].notUpdated' >/dev/null
          ;;
        *) die "create $lp failed: $resp" ;;
      esac
    fi
  }

  log "P1: ensure bench user ${USER_LOCAL}@${DOMAIN}"
  ensure_account "${USER_LOCAL}" "$USER_PASS"

  log "P1: ensure restore user ${USER2_LOCAL}@${DOMAIN}"
  ensure_account "${USER2_LOCAL}" "$USER2_PASS"

  log "P1: probing accountId for ${USER_LOCAL}@${DOMAIN}"
  USER_ACCOUNT_ID=$(helper_run curl -sf -u "${USER_LOCAL}@${DOMAIN}:${USER_PASS}" "${STALWART_URL}/jmap/session" \
    | jq -r '.primaryAccounts."urn:ietf:params:jmap:mail"')
  [[ -n "$USER_ACCOUNT_ID" && "$USER_ACCOUNT_ID" != "null" ]] || die "no accountId for bench user"
  log "P1: bench user accountId=$USER_ACCOUNT_ID"

  log "P1: probing accountId for ${USER2_LOCAL}@${DOMAIN}"
  USER2_ACCOUNT_ID=$(helper_run curl -sf -u "${USER2_LOCAL}@${DOMAIN}:${USER2_PASS}" "${STALWART_URL}/jmap/session" \
    | jq -r '.primaryAccounts."urn:ietf:params:jmap:mail"')
  [[ -n "$USER2_ACCOUNT_ID" && "$USER2_ACCOUNT_ID" != "null" ]] || die "no accountId for restore user"
  log "P1: restore user accountId=$USER2_ACCOUNT_ID"
}

# ─── P2 populate (Python in helper pod) ──────────────────────────────────────
#
# We POST a 5KB / 80KB / 500KB body to /jmap/upload/{accountId}/, capture
# the returned blobId, then call Email/import on the bench user to commit
# the message into Inbox. Repeat MSG_COUNT times.
p2_populate() {
  log "P2: writing populator script into helper pod"
  helper_run sh -c "mkdir -p /tmp/perf && cat > /tmp/perf/populate.py <<'PYEOF'
import os, sys, time, json, random, base64
import requests
from email.message import EmailMessage
from email.utils import formatdate

USER, PASS, ACCT, STALWART, COUNT = sys.argv[1:6]
COUNT = int(COUNT)
s = requests.Session()
s.auth = (USER, PASS)

# Mailbox/get → find Inbox
r = s.post(f'{STALWART}/jmap', json={
    'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
    'methodCalls': [['Mailbox/get', {'accountId': ACCT, 'ids': None}, 'c0']]
}).json()
mboxes = r['methodResponses'][0][1]['list']
inbox = next((m['id'] for m in mboxes if m.get('role') == 'inbox'), None)
if not inbox:
    print('NO_INBOX', mboxes); sys.exit(1)
print(f'inbox={inbox} existing_mailboxes={len(mboxes)}')

# Size distribution: 60% 5KB, 30% 80KB, 10% 500KB
def make_msg(i):
    r = random.random()
    if r < 0.6: sz = 5_000
    elif r < 0.9: sz = 80_000
    else: sz = 500_000
    body = ('Lorem ipsum dolor sit amet. ' * (sz // 28))[:sz]
    msg = EmailMessage()
    msg['From'] = 'sender@example.org'
    msg['To'] = f'{USER}'
    msg['Subject'] = f'Perf test message {i:05d} (size~{sz})'
    msg['Date'] = formatdate(time.time() - random.randint(0, 86400*30), localtime=True)
    msg['Message-ID'] = f'<perf-{i:05d}-{int(time.time())}@perf.test>'
    msg.set_content(body)
    return bytes(msg)

t0 = time.time()
total_bytes = 0
for i in range(COUNT):
    raw = make_msg(i)
    total_bytes += len(raw)
    # Blob/upload
    up = s.post(f'{STALWART}/jmap/upload/{ACCT}/',
                headers={'Content-Type': 'message/rfc822'},
                data=raw)
    up.raise_for_status()
    blob = up.json()
    blob_id = blob['blobId']
    # Email/import
    imp = s.post(f'{STALWART}/jmap', json={
        'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
        'methodCalls': [['Email/import', {
            'accountId': ACCT,
            'emails': {
                f'm{i}': {
                    'blobId': blob_id,
                    'mailboxIds': {inbox: True},
                    'keywords': {'\\\\Seen': True},
                }
            }
        }, 'c0']]
    })
    imp.raise_for_status()
    j = imp.json()
    if 'created' not in j['methodResponses'][0][1] or not j['methodResponses'][0][1]['created']:
        nc = j['methodResponses'][0][1].get('notCreated', {})
        print(f'NOT_CREATED at i={i}: {nc}'); sys.exit(1)
    if i > 0 and i % 100 == 0:
        elapsed = time.time() - t0
        rate = i / elapsed
        mbs = total_bytes / 1024 / 1024 / elapsed
        print(f'i={i} elapsed={elapsed:.1f}s rate={rate:.1f}msg/s {mbs:.1f}MB/s', flush=True)

elapsed = time.time() - t0
print(f'DONE i={COUNT} elapsed={elapsed:.2f}s rate={COUNT/elapsed:.1f}msg/s total_bytes={total_bytes} ({total_bytes/1024/1024:.1f}MB)')
PYEOF
"

  log "P2: populating $MSG_COUNT messages into ${USER_LOCAL}@${DOMAIN}"
  local t0 t1
  t0=$(date +%s)
  helper_run python3 /tmp/perf/populate.py \
    "${USER_LOCAL}@${DOMAIN}" "$USER_PASS" "$USER_ACCOUNT_ID" \
    "$STALWART_URL" "$MSG_COUNT" 2>&1 | tee -a "$LOG"
  t1=$(date +%s)
  log "P2: populate took $((t1-t0))s"
}

# ─── P3.A JMAP export ────────────────────────────────────────────────────────
#
# Mirrors the same JMAP loop that platform's `jmap-sync.py` uses:
# Email/query (all ids) → Email/get (blobIds + receivedAt + mailbox)
# → Blob/get (bodies) → write a Maildir tree → tar+gzip.
#
JMAP_EXPORT_WALL=""
JMAP_EXPORT_OUTPUT_BYTES=""
JMAP_EXPORT_BYTES_ON_WIRE=""
JMAP_EXPORT_MSG_COUNT=""

p3a_jmap_export() {
  log "P3.A: JMAP export of ${USER_LOCAL}@${DOMAIN}"
  helper_run sh -c "cat > /tmp/perf/jmap_export.py <<'PYEOF'
import os, sys, time, json, tarfile, io, hashlib, requests

USER, PASS, ACCT, STALWART, OUT = sys.argv[1:6]
s = requests.Session()
s.auth = (USER, PASS)
bytes_on_wire = 0

def post(body):
    global bytes_on_wire
    r = s.post(f'{STALWART}/jmap', json=body)
    bytes_on_wire += len(r.content)
    r.raise_for_status()
    return r.json()

t0 = time.time()

# 1) Mailbox/get → so we know mailbox path per id
r = post({
    'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
    'methodCalls': [['Mailbox/get', {'accountId': ACCT, 'ids': None}, 'c0']]
})
mboxes = {m['id']: m for m in r['methodResponses'][0][1]['list']}

# 2) Email/query — get ALL email ids
all_ids = []
position = 0
while True:
    r = post({
        'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
        'methodCalls': [['Email/query', {
            'accountId': ACCT,
            'position': position,
            'limit': 256,
            'calculateTotal': True
        }, 'c0']]
    })
    resp = r['methodResponses'][0][1]
    all_ids.extend(resp['ids'])
    position += len(resp['ids'])
    if position >= resp.get('total', position) or not resp['ids']:
        break

count = len(all_ids)
print(f'found {count} messages', flush=True)

# 3) tar.gz of Maildir tree as we stream bodies.
buf = io.BytesIO()
tar = tarfile.open(fileobj=buf, mode='w:gz', compresslevel=6)

# 4) Email/get in batches → blobId + mailboxIds. Then Blob/get.
BATCH = 100
done = 0
for i in range(0, count, BATCH):
    batch_ids = all_ids[i:i+BATCH]
    r = post({
        'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
        'methodCalls': [['Email/get', {
            'accountId': ACCT,
            'ids': batch_ids,
            'properties': ['id','blobId','mailboxIds','receivedAt','size']
        }, 'c0']]
    })
    emails = r['methodResponses'][0][1]['list']
    for em in emails:
        # Fetch blob via /jmap/download/{accountId}/{blobId}
        bl = s.get(f\"{STALWART}/jmap/download/{ACCT}/{em['blobId']}/email.eml\")
        bytes_on_wire += len(bl.content)
        if bl.status_code != 200:
            print(f'BLOB FAIL {em[\"id\"]} status={bl.status_code}'); sys.exit(1)
        # Maildir path: <mailbox>/cur/<id>:2,
        mbx_id = next(iter(em['mailboxIds']))
        mbx_name = mboxes.get(mbx_id, {}).get('name', 'INBOX')
        ti = tarfile.TarInfo(name=f'{mbx_name}/cur/{em[\"id\"]}.eml')
        ti.size = len(bl.content)
        ti.mtime = int(time.time())
        tar.addfile(ti, io.BytesIO(bl.content))
        done += 1
    print(f'exported {done}/{count}', flush=True)

tar.close()
with open(OUT, 'wb') as f:
    f.write(buf.getvalue())

elapsed = time.time() - t0
out_bytes = os.path.getsize(OUT)
result = {
    'msg_count': count,
    'elapsed_seconds': round(elapsed, 3),
    'output_bytes': out_bytes,
    'bytes_on_wire': bytes_on_wire,
    'rate_msg_per_sec': round(count / elapsed, 2),
    'output_mb_per_sec': round(out_bytes / 1024 / 1024 / elapsed, 2),
}
print('RESULT_JSON=' + json.dumps(result))
PYEOF
"
  local out_file="/tmp/perf/jmap-export.tar.gz"
  helper_run sh -c "rm -f $out_file"
  local result
  result=$(helper_run python3 /tmp/perf/jmap_export.py \
    "${USER_LOCAL}@${DOMAIN}" "$USER_PASS" "$USER_ACCOUNT_ID" \
    "$STALWART_URL" "$out_file" 2>&1 | tee -a "$LOG" | grep -E '^RESULT_JSON=' | sed 's/^RESULT_JSON=//')
  [[ -n "$result" ]] || die "P3.A: no result line"
  JMAP_EXPORT_WALL=$(echo "$result" | jq -r '.elapsed_seconds')
  JMAP_EXPORT_OUTPUT_BYTES=$(echo "$result" | jq -r '.output_bytes')
  JMAP_EXPORT_BYTES_ON_WIRE=$(echo "$result" | jq -r '.bytes_on_wire')
  JMAP_EXPORT_MSG_COUNT=$(echo "$result" | jq -r '.msg_count')
  echo "$result" > "$RESULTS/jmap-export.json"
  log "P3.A: wall=${JMAP_EXPORT_WALL}s msgs=${JMAP_EXPORT_MSG_COUNT} out=${JMAP_EXPORT_OUTPUT_BYTES}B wire=${JMAP_EXPORT_BYTES_ON_WIRE}B"
}

# ─── P3.B CLI -e Path A (scale-to-0, direct RocksDB read) ────────────────────
CLI_EXPORT_WALL=""
CLI_EXPORT_OUTPUT_BYTES=""

p3b_cli_export_path_a() {
  log "P3.B: CLI -e Path A (scale-to-0 + one-shot pod)"
  local replicas
  replicas=$(kubectl -n "$NS_MAIL" get deploy stalwart-mail -o jsonpath='{.spec.replicas}')
  log "P3.B: current Stalwart replicas=$replicas; scaling to 0"
  kubectl -n "$NS_MAIL" scale deploy stalwart-mail --replicas=0 >/dev/null
  for _ in $(seq 1 60); do
    [[ "$(kubectl -n "$NS_MAIL" get pod -l app=stalwart-mail --no-headers 2>/dev/null | wc -l)" == "0" ]] && break
    sleep 1
  done

  # Find the data PVC name from the live Stalwart deployment.
  local pvc_name image
  pvc_name=$(kubectl -n "$NS_MAIL" get deploy stalwart-mail -o jsonpath='{.spec.template.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}')
  image=$(kubectl -n "$NS_MAIL" get deploy stalwart-mail -o jsonpath='{.spec.template.spec.containers[0].image}')
  log "P3.B: pvc=$pvc_name image=$image"

  # One-shot pod.
  kubectl -n "$NS_MAIL" delete pod cli-export-once --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
  cat <<YAML | kubectl -n "$NS_MAIL" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: cli-export-once }
spec:
  restartPolicy: Never
  volumes:
  - name: data
    persistentVolumeClaim: { claimName: ${pvc_name} }
  - name: config
    configMap: { name: stalwart-config }
  - name: out
    emptyDir: {}
  containers:
  - name: cli
    image: ${image}
    command: ["sh","-c"]
    args:
    - |
      set -e
      START=\$(date +%s.%N)
      /usr/local/bin/stalwart -c /etc/stalwart/config.json -e /out/export.lz4
      END=\$(date +%s.%N)
      # Stalwart 0.16 creates a DIRECTORY at /out/export.lz4 with per-subspace files.
      SZ=\$(du -sb /out/export.lz4 | cut -f1)
      WALL=\$(echo "\$START \$END" | awk '{printf "%.3f", \$2 - \$1}')
      echo "CLI_EXPORT_RESULT_JSON={\"wall_seconds\":\$WALL,\"output_bytes\":\$SZ}"
    volumeMounts:
    - { name: data, mountPath: /var/lib/stalwart/data }
    - { name: config, mountPath: /etc/stalwart }
    - { name: out, mountPath: /out }
YAML

  # Wait for completion
  local deadline=$(( $(date +%s) + 300 ))
  while :; do
    local phase
    phase=$(kubectl -n "$NS_MAIL" get pod cli-export-once -o jsonpath='{.status.phase}' 2>/dev/null)
    case "$phase" in
      Succeeded) break ;;
      Failed)
        kubectl -n "$NS_MAIL" logs cli-export-once | tee -a "$LOG"
        die "CLI export pod failed"
        ;;
    esac
    [[ $(date +%s) -gt $deadline ]] && {
      kubectl -n "$NS_MAIL" logs cli-export-once | tee -a "$LOG"
      die "CLI export pod timeout"
    }
    sleep 2
  done

  local result
  result=$(kubectl -n "$NS_MAIL" logs cli-export-once | tee -a "$LOG" | grep '^CLI_EXPORT_RESULT_JSON=' | sed 's/^CLI_EXPORT_RESULT_JSON=//')
  [[ -n "$result" ]] || die "P3.B: no result"
  CLI_EXPORT_WALL=$(echo "$result" | jq -r '.wall_seconds')
  CLI_EXPORT_OUTPUT_BYTES=$(echo "$result" | jq -r '.output_bytes')
  echo "$result" > "$RESULTS/cli-export-path-a.json"
  log "P3.B: wall=${CLI_EXPORT_WALL}s out=${CLI_EXPORT_OUTPUT_BYTES}B"

  # Copy the LZ4 out for use by import test
  kubectl -n "$NS_MAIL" cp cli-export-once:/out/export.lz4 /tmp/perf/cli-export.lz4 >/dev/null 2>&1 || \
    kubectl -n "$NS_MAIL" exec cli-export-once -- cat /out/export.lz4 > /tmp/perf/cli-export.lz4 2>/dev/null || true
  kubectl -n "$NS_MAIL" delete pod cli-export-once --wait=false >/dev/null 2>&1 || true

  log "P3.B: restoring Stalwart replicas=$replicas"
  kubectl -n "$NS_MAIL" scale deploy stalwart-mail --replicas="$replicas" >/dev/null
  for _ in $(seq 1 120); do
    local ready
    ready=$(kubectl -n "$NS_MAIL" get pod -l app=stalwart-mail -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null || true)
    [[ "$ready" == "true" ]] && break
    sleep 2
  done
}

# ─── P3.C JMAP import (replay tar.gz into bench-restore) ─────────────────────
JMAP_IMPORT_WALL=""
JMAP_IMPORT_MSG_COUNT=""

p3c_jmap_import() {
  log "P3.C: JMAP import into ${USER2_LOCAL}@${DOMAIN}"
  helper_run sh -c "cat > /tmp/perf/jmap_import.py <<'PYEOF'
import os, sys, time, json, tarfile, io, requests

USER, PASS, ACCT, STALWART, INPUT = sys.argv[1:6]
s = requests.Session()
s.auth = (USER, PASS)

# Get Inbox
r = s.post(f'{STALWART}/jmap', json={
    'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
    'methodCalls': [['Mailbox/get', {'accountId': ACCT, 'ids': None}, 'c0']]
}).json()
mboxes = r['methodResponses'][0][1]['list']
inbox = next((m['id'] for m in mboxes if m.get('role') == 'inbox'), None)
if not inbox:
    print('NO_INBOX'); sys.exit(1)

t0 = time.time()
count = 0
with tarfile.open(INPUT, 'r:gz') as tf:
    for m in tf:
        if not m.isfile() or not m.name.endswith('.eml'):
            continue
        raw = tf.extractfile(m).read()
        # Blob/upload
        up = s.post(f'{STALWART}/jmap/upload/{ACCT}/',
                    headers={'Content-Type': 'message/rfc822'}, data=raw)
        up.raise_for_status()
        blob_id = up.json()['blobId']
        # Email/import
        imp = s.post(f'{STALWART}/jmap', json={
            'using': ['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],
            'methodCalls': [['Email/import', {
                'accountId': ACCT,
                'emails': {f'm{count}': {
                    'blobId': blob_id,
                    'mailboxIds': {inbox: True},
                    'keywords': {'\\\\Seen': True}
                }}
            }, 'c0']]
        }).json()
        if 'created' not in imp['methodResponses'][0][1] or not imp['methodResponses'][0][1]['created']:
            nc = imp['methodResponses'][0][1].get('notCreated', {})
            print(f'NOT_CREATED at i={count}: {nc}'); sys.exit(1)
        count += 1
        if count % 200 == 0:
            print(f'imported {count}', flush=True)

elapsed = time.time() - t0
print(f'RESULT_JSON={{\"msg_count\":{count},\"elapsed_seconds\":{elapsed:.3f},\"rate_msg_per_sec\":{count/elapsed:.2f}}}')
PYEOF
"
  local result
  result=$(helper_run python3 /tmp/perf/jmap_import.py \
    "${USER2_LOCAL}@${DOMAIN}" "$USER2_PASS" "$USER2_ACCOUNT_ID" \
    "$STALWART_URL" "/tmp/perf/jmap-export.tar.gz" 2>&1 | tee -a "$LOG" | grep '^RESULT_JSON=' | sed 's/^RESULT_JSON=//')
  [[ -n "$result" ]] || die "P3.C: no result"
  JMAP_IMPORT_WALL=$(echo "$result" | jq -r '.elapsed_seconds')
  JMAP_IMPORT_MSG_COUNT=$(echo "$result" | jq -r '.msg_count')
  echo "$result" > "$RESULTS/jmap-import.json"
  log "P3.C: wall=${JMAP_IMPORT_WALL}s msgs=${JMAP_IMPORT_MSG_COUNT}"
}

# ─── P3.D CLI -i Path A (scale-to-0, destructive: wipes DataStore) ───────────
CLI_IMPORT_WALL=""
CLI_IMPORT_MSG_COUNT_AFTER=""

p3d_cli_import_path_a() {
  log "P3.D: CLI -i Path A (DESTRUCTIVE — wipes DataStore, replays cli-export.lz4)"
  local replicas
  replicas=$(kubectl -n "$NS_MAIL" get deploy stalwart-mail -o jsonpath='{.spec.replicas}')
  kubectl -n "$NS_MAIL" scale deploy stalwart-mail --replicas=0 >/dev/null
  for _ in $(seq 1 60); do
    [[ "$(kubectl -n "$NS_MAIL" get pod -l app=stalwart-mail --no-headers 2>/dev/null | wc -l)" == "0" ]] && break
    sleep 1
  done

  local pvc_name image
  pvc_name=$(kubectl -n "$NS_MAIL" get deploy stalwart-mail -o jsonpath='{.spec.template.spec.volumes[?(@.persistentVolumeClaim)].persistentVolumeClaim.claimName}')
  image=$(kubectl -n "$NS_MAIL" get deploy stalwart-mail -o jsonpath='{.spec.template.spec.containers[0].image}')

  # Copy the export back into the cluster.
  kubectl -n "$NS_MAIL" delete pod cli-import-once --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || true
  # First stage the export.lz4 dir into a fresh pod's emptyDir, then run -i.
  cat <<YAML | kubectl -n "$NS_MAIL" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: cli-import-once }
spec:
  restartPolicy: Never
  volumes:
  - name: data
    persistentVolumeClaim: { claimName: ${pvc_name} }
  - name: config
    configMap: { name: stalwart-config }
  - name: ex
    emptyDir: {}
  initContainers:
  - name: stage
    image: alpine:3.20
    command: ["sh","-c","mkdir -p /ex/export.lz4 && sleep 999"]
    volumeMounts:
    - { name: ex, mountPath: /ex }
  containers:
  - name: cli
    image: ${image}
    command: ["sh","-c"]
    args:
    - |
      set -e
      ls -la /ex/export.lz4/
      START=\$(date +%s.%N)
      /usr/local/bin/stalwart -c /etc/stalwart/config.json -i /ex/export.lz4
      END=\$(date +%s.%N)
      WALL=\$(echo "\$START \$END" | awk '{printf "%.3f", \$2 - \$1}')
      echo "CLI_IMPORT_RESULT_JSON={\"wall_seconds\":\$WALL}"
    volumeMounts:
    - { name: data, mountPath: /var/lib/stalwart/data }
    - { name: config, mountPath: /etc/stalwart }
    - { name: ex, mountPath: /ex }
YAML

  # Wait for init pod ready (we need to kubectl cp into it).
  for _ in $(seq 1 30); do
    local phase
    phase=$(kubectl -n "$NS_MAIL" get pod cli-import-once -o jsonpath='{.status.initContainerStatuses[0].state.running}' 2>/dev/null)
    [[ -n "$phase" ]] && break
    sleep 1
  done

  # Stage the export.lz4 dir contents.
  log "P3.D: staging /tmp/perf/cli-export.lz4 into pod"
  helper_run sh -c 'tar -C /tmp/perf -czf - cli-export.lz4' \
    | kubectl -n "$NS_MAIL" exec -i cli-import-once -c stage -- sh -c 'tar -C /ex/ -xzf - && mv /ex/cli-export.lz4/* /ex/export.lz4/ 2>/dev/null || cp -r /ex/cli-export.lz4/. /ex/export.lz4/ ; ls /ex/export.lz4/ | head'
  kubectl -n "$NS_MAIL" exec cli-import-once -c stage -- sh -c 'kill 1' >/dev/null 2>&1 || true

  local deadline=$(( $(date +%s) + 300 ))
  while :; do
    local phase
    phase=$(kubectl -n "$NS_MAIL" get pod cli-import-once -o jsonpath='{.status.phase}' 2>/dev/null)
    case "$phase" in Succeeded) break ;; Failed) kubectl -n "$NS_MAIL" logs cli-import-once -c cli | tee -a "$LOG"; die "CLI import failed" ;; esac
    [[ $(date +%s) -gt $deadline ]] && { kubectl -n "$NS_MAIL" logs cli-import-once -c cli | tee -a "$LOG"; die "CLI import timeout"; }
    sleep 2
  done
  local result
  result=$(kubectl -n "$NS_MAIL" logs cli-import-once -c cli | tee -a "$LOG" | grep '^CLI_IMPORT_RESULT_JSON=' | sed 's/^CLI_IMPORT_RESULT_JSON=//')
  CLI_IMPORT_WALL=$(echo "$result" | jq -r '.wall_seconds')
  echo "$result" > "$RESULTS/cli-import-path-a.json"
  kubectl -n "$NS_MAIL" delete pod cli-import-once --wait=false >/dev/null 2>&1 || true

  log "P3.D: wall=${CLI_IMPORT_WALL}s"

  kubectl -n "$NS_MAIL" scale deploy stalwart-mail --replicas="$replicas" >/dev/null
  for _ in $(seq 1 120); do
    local ready
    ready=$(kubectl -n "$NS_MAIL" get pod -l app=stalwart-mail -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null || true)
    [[ "$ready" == "true" ]] && break
    sleep 2
  done

  # Verify msg count after restore (Stalwart now contains the imported data).
  # bench user was destroyed by -i (it empties the DataStore); the LZ4 import
  # re-creates the bench principal AND its messages. We have to re-reset the
  # password to keep the test repeatable (the LZ4 dump contains the hashed
  # password from when we exported).
  sleep 5
  CLI_IMPORT_MSG_COUNT_AFTER=$(helper_run curl -s -u "${ADMIN_USER}:${ADMIN_PASS}" -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/query\",{\"accountId\":\"${USER_ACCOUNT_ID}\",\"limit\":1,\"calculateTotal\":true},\"c0\"]]}" \
    "$STALWART_URL/jmap" | jq -r '.methodResponses[0][1].total // 0')
  log "P3.D: post-import msg count (bench user): $CLI_IMPORT_MSG_COUNT_AFTER"
}

# ─── P3.E IMAP export (FETCH 1:* BODY.PEEK[]) ────────────────────────────────
IMAP_EXPORT_WALL=""
IMAP_EXPORT_MSG_COUNT=""
IMAP_EXPORT_BYTES_ON_WIRE=""
IMAP_EXPORT_OUTPUT_BYTES=""

p3e_imap_export() {
  log "P3.E: IMAP export (FETCH 1:* BODY.PEEK[]) for ${USER_LOCAL}@${DOMAIN}"
  local master_fqdn master_pass
  master_fqdn=$(kubectl -n "$NS_MAIL" get secret roundcube-secrets -o jsonpath='{.data.STALWART_MASTER_USER}' | base64 -d)
  master_pass=$(kubectl -n "$NS_MAIL" get secret roundcube-secrets -o jsonpath='{.data.STALWART_MASTER_PASSWORD}' | base64 -d)
  helper_run sh -c "cat > /tmp/perf/imap_export.py <<'PYEOF'
import sys, time, ssl, json, tarfile, io
import imaplib

USER, MASTER_FQ, PASS, OUT = sys.argv[1:5]
HOST = 'stalwart-mail.mail.svc.cluster.local'
PORT = 993

# Master-user proxy auth: <addr>%<master>
login = f'{USER}%{MASTER_FQ}'

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
imaplib._MAXLINE = 100_000_000  # raise default 10MB cap to fit fetch responses

bytes_on_wire = 0
class CountingSock:
    def __init__(self, inner): self.inner = inner; self.read = 0
    def __getattr__(self, n): return getattr(self.inner, n)

t0 = time.time()
M = imaplib.IMAP4_SSL(HOST, PORT, ssl_context=ctx)

# Hook to count bytes by wrapping the recv side. imaplib uses sock for reads.
orig_recv = M.sock.recv
def counted_recv(n):
    global bytes_on_wire
    b = orig_recv(n)
    bytes_on_wire += len(b)
    return b
M.sock.recv = counted_recv

typ, _ = M.login(login, PASS)
assert typ == 'OK', f'LOGIN failed: {typ}'

M.select('Inbox', readonly=True)
typ, data = M.uid('SEARCH', None, 'ALL')
assert typ == 'OK', f'SEARCH failed: {typ}'
uids = data[0].split()
count = len(uids)
print(f'found {count} messages via IMAP', flush=True)

# Tar.gz output, one .eml per msg
buf = io.BytesIO()
tar = tarfile.open(fileobj=buf, mode='w:gz', compresslevel=6)

BATCH = 100
done = 0
for i in range(0, count, BATCH):
    batch_uids = b','.join(uids[i:i+BATCH])
    typ, data = M.uid('FETCH', batch_uids, '(BODY.PEEK[])')
    assert typ == 'OK', f'FETCH failed at i={i}: {typ}'
    # imaplib parses each FETCH response as: ('UID 123 BODY[] {N}', body), then ')'
    for chunk in data:
        if isinstance(chunk, tuple) and len(chunk) == 2:
            header_bytes, body_bytes = chunk
            # Find UID in header
            ti_name = f'msg-{done:05d}.eml'
            ti = tarfile.TarInfo(name=f'Inbox/cur/{ti_name}')
            ti.size = len(body_bytes)
            ti.mtime = int(time.time())
            tar.addfile(ti, io.BytesIO(body_bytes))
            done += 1
    if done > 0 and (done % 500 == 0 or done == count):
        print(f'exported {done}/{count}', flush=True)

tar.close()
with open(OUT, 'wb') as f:
    f.write(buf.getvalue())

M.logout()
elapsed = time.time() - t0
import os
out_bytes = os.path.getsize(OUT)
print('RESULT_JSON=' + json.dumps({
    'msg_count': count,
    'elapsed_seconds': round(elapsed, 3),
    'output_bytes': out_bytes,
    'bytes_on_wire': bytes_on_wire,
    'rate_msg_per_sec': round(count / elapsed, 2),
    'output_mb_per_sec': round(out_bytes / 1024 / 1024 / elapsed, 2),
}))
PYEOF
"
  local out_file="/tmp/perf/imap-export.tar.gz"
  helper_run sh -c "rm -f $out_file"
  local result
  result=$(helper_run python3 /tmp/perf/imap_export.py \
    "${USER_LOCAL}@${DOMAIN}" "$master_fqdn" "$master_pass" "$out_file" 2>&1 \
    | tee -a "$LOG" | grep '^RESULT_JSON=' | sed 's/^RESULT_JSON=//')
  [[ -n "$result" ]] || die "P3.E: no result"
  IMAP_EXPORT_WALL=$(echo "$result" | jq -r '.elapsed_seconds')
  IMAP_EXPORT_MSG_COUNT=$(echo "$result" | jq -r '.msg_count')
  IMAP_EXPORT_OUTPUT_BYTES=$(echo "$result" | jq -r '.output_bytes')
  IMAP_EXPORT_BYTES_ON_WIRE=$(echo "$result" | jq -r '.bytes_on_wire')
  echo "$result" > "$RESULTS/imap-export.json"
  log "P3.E: wall=${IMAP_EXPORT_WALL}s msgs=${IMAP_EXPORT_MSG_COUNT} out=${IMAP_EXPORT_OUTPUT_BYTES}B wire=${IMAP_EXPORT_BYTES_ON_WIRE}B"

  # Note: imaplib never logged out cleanly above if it crashed — best-effort here.
  true
}

# ─── P3.F IMAP import (APPEND loop + MULTIAPPEND batch) ──────────────────────
#
# Stalwart 0.16 advertises MULTIAPPEND + LITERAL+ post-auth — so two passes:
#   F.1  per-msg APPEND  (naïve baseline; what imaplib.append does)
#   F.2  MULTIAPPEND batches of 50 via raw protocol — the realistic upper bound
#
IMAP_IMPORT_NAIVE_WALL=""
IMAP_IMPORT_NAIVE_MSG_COUNT=""
IMAP_IMPORT_MULTIAPPEND_WALL=""
IMAP_IMPORT_MULTIAPPEND_MSG_COUNT=""

p3f_imap_import() {
  log "P3.F: IMAP import (APPEND + MULTIAPPEND) into ${USER2_LOCAL}@${DOMAIN}"
  local master_fqdn master_pass
  master_fqdn=$(kubectl -n "$NS_MAIL" get secret roundcube-secrets -o jsonpath='{.data.STALWART_MASTER_USER}' | base64 -d)
  master_pass=$(kubectl -n "$NS_MAIL" get secret roundcube-secrets -o jsonpath='{.data.STALWART_MASTER_PASSWORD}' | base64 -d)

  helper_run sh -c "cat > /tmp/perf/imap_import.py <<'PYEOF'
import sys, time, ssl, json, tarfile, io, socket
import imaplib

USER, MASTER_FQ, PASS, TARGZ, MODE = sys.argv[1:6]
HOST = 'stalwart-mail.mail.svc.cluster.local'
PORT = 993

login = f'{USER}%{MASTER_FQ}'
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
imaplib._MAXLINE = 100_000_000

# Pre-load all messages from tar into memory so we measure JUST the send side.
messages = []
with tarfile.open(TARGZ, 'r:gz') as tf:
    for m in tf:
        if m.isfile() and m.name.endswith('.eml'):
            messages.append(tf.extractfile(m).read())
print(f'loaded {len(messages)} messages from tar', flush=True)

if MODE == 'naive':
    # F.1 — per-message APPEND via imaplib (one round-trip per msg).
    t0 = time.time()
    M = imaplib.IMAP4_SSL(HOST, PORT, ssl_context=ctx)
    typ, _ = M.login(login, PASS); assert typ == 'OK'
    count = 0
    for raw in messages:
        typ, _ = M.append('Inbox', '(\\\\Seen)', None, raw)
        if typ != 'OK':
            print(f'APPEND failed at i={count}'); sys.exit(1)
        count += 1
        if count % 500 == 0:
            print(f'naive APPEND {count}/{len(messages)}', flush=True)
    M.logout()
    elapsed = time.time() - t0
    print('RESULT_JSON=' + json.dumps({
        'mode': 'naive',
        'msg_count': count,
        'elapsed_seconds': round(elapsed, 3),
        'rate_msg_per_sec': round(count / elapsed, 2),
    }))

elif MODE == 'multiappend':
    # F.2 — raw protocol MULTIAPPEND with LITERAL+.
    # Send: APPEND Inbox (\\Seen) {N+}\r\n<N bytes> {N+}\r\n<N bytes> ... \r\n
    # Stalwart accepts MULTIAPPEND on a single tag.
    t0 = time.time()
    BATCH = 50
    sock = socket.create_connection((HOST, PORT), timeout=120)
    sock = ctx.wrap_socket(sock, server_hostname=HOST)
    f = sock.makefile('rwb', buffering=0)

    def readline():
        return f.readline()
    def send(s):
        if isinstance(s, str): s = s.encode()
        sock.sendall(s)

    # Server greeting
    readline()
    # LOGIN with SASL not needed — plain LOGIN works post-TLS
    send(f'a1 LOGIN {login} {PASS}\r\n')
    line = readline()
    while not line.startswith(b'a1 '):
        line = readline()
    assert b'OK' in line, f'LOGIN failed: {line!r}'

    tag_n = 2
    count = 0
    for i in range(0, len(messages), BATCH):
        batch = messages[i:i+BATCH]
        tag = f'a{tag_n}'.encode()
        tag_n += 1
        # First literal in the APPEND
        parts = [tag, b' APPEND Inbox (\\\\Seen) ']
        for idx, raw in enumerate(batch):
            if idx > 0:
                # space + the next mailbox already implied by MULTIAPPEND — actually
                # MULTIAPPEND just concats more flag-list + literal pairs.
                parts.append(b' (\\\\Seen) ')
            parts.append(f'{{{len(raw)}+}}\r\n'.encode())
            parts.append(raw)
        parts.append(b'\r\n')
        send(b''.join(parts))
        # Read until tagged response
        while True:
            line = readline()
            if not line:
                print('connection closed mid-batch'); sys.exit(1)
            if line.startswith(tag + b' '):
                if b'OK' not in line:
                    print(f'MULTIAPPEND failed batch {i}: {line!r}'); sys.exit(1)
                break
        count += len(batch)
        if count % 500 == 0:
            print(f'multiappend {count}/{len(messages)}', flush=True)
    send(b'aX LOGOUT\r\n')
    try: sock.close()
    except: pass
    elapsed = time.time() - t0
    print('RESULT_JSON=' + json.dumps({
        'mode': 'multiappend',
        'batch_size': BATCH,
        'msg_count': count,
        'elapsed_seconds': round(elapsed, 3),
        'rate_msg_per_sec': round(count / elapsed, 2),
    }))
PYEOF
"

  log "P3.F.1: naive APPEND loop"
  local r1
  r1=$(helper_run python3 /tmp/perf/imap_import.py \
    "${USER2_LOCAL}@${DOMAIN}" "$master_fqdn" "$master_pass" \
    "/tmp/perf/imap-export.tar.gz" "naive" 2>&1 | tee -a "$LOG" | grep '^RESULT_JSON=' | sed 's/^RESULT_JSON=//')
  [[ -n "$r1" ]] || die "P3.F.1: no result"
  IMAP_IMPORT_NAIVE_WALL=$(echo "$r1" | jq -r '.elapsed_seconds')
  IMAP_IMPORT_NAIVE_MSG_COUNT=$(echo "$r1" | jq -r '.msg_count')
  echo "$r1" > "$RESULTS/imap-import-naive.json"
  log "P3.F.1: wall=${IMAP_IMPORT_NAIVE_WALL}s msgs=${IMAP_IMPORT_NAIVE_MSG_COUNT}"

  log "P3.F.2: MULTIAPPEND batch=50 with LITERAL+"
  local r2
  r2=$(helper_run python3 /tmp/perf/imap_import.py \
    "${USER2_LOCAL}@${DOMAIN}" "$master_fqdn" "$master_pass" \
    "/tmp/perf/imap-export.tar.gz" "multiappend" 2>&1 | tee -a "$LOG" | grep '^RESULT_JSON=' | sed 's/^RESULT_JSON=//')
  [[ -n "$r2" ]] || die "P3.F.2: no result"
  IMAP_IMPORT_MULTIAPPEND_WALL=$(echo "$r2" | jq -r '.elapsed_seconds')
  IMAP_IMPORT_MULTIAPPEND_MSG_COUNT=$(echo "$r2" | jq -r '.msg_count')
  echo "$r2" > "$RESULTS/imap-import-multiappend.json"
  log "P3.F.2: wall=${IMAP_IMPORT_MULTIAPPEND_WALL}s msgs=${IMAP_IMPORT_MULTIAPPEND_MSG_COUNT}"
}

# ─── P4 report ───────────────────────────────────────────────────────────────
p4_report() {
  log "P4: writing report to $REPORT"
  : > "$REPORT"
  {
    echo "# Stalwart full-mailbox export — JMAP vs CLI"
    echo
    echo "**Cluster:** $(kubectl get nodes -o jsonpath='{.items[0].metadata.name}') (single-node)"
    echo "**Date:** $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "**Population:** ${MSG_COUNT} requested, ${JMAP_EXPORT_MSG_COUNT:-?} observed at export time"
    echo "**Account:** ${USER_LOCAL}@${DOMAIN}"
    echo
    echo "Stalwart 0.16 has no per-account CLI export — \`stalwart -e\` is whole-server."
    echo "Comparison is therefore: **per-account JMAP** vs **whole-server CLI**, against"
    echo "a Stalwart populated with effectively one account's worth of data (plus the"
    echo "default platform admin/mail-admin principals)."
    echo
    echo "## Results"
    echo
    printf '| path | wall time (s) | output bytes | output MB | msgs/sec | MB/sec |\n'
    printf '|---|---:|---:|---:|---:|---:|\n'
    fmt() { LC_ALL=C printf '%.2f' "$1"; }
    if [[ -n "$JMAP_EXPORT_WALL" ]]; then
      printf '| JMAP export per-account | %s | %s | %s | %s | %s |\n' \
        "$JMAP_EXPORT_WALL" "$JMAP_EXPORT_OUTPUT_BYTES" \
        "$(fmt "$(echo "$JMAP_EXPORT_OUTPUT_BYTES / 1048576" | bc -l)")" \
        "$(fmt "$(echo "$JMAP_EXPORT_MSG_COUNT / $JMAP_EXPORT_WALL" | bc -l)")" \
        "$(fmt "$(echo "$JMAP_EXPORT_OUTPUT_BYTES / 1048576 / $JMAP_EXPORT_WALL" | bc -l)")"
    fi
    if [[ -n "$CLI_EXPORT_WALL" ]]; then
      printf '| CLI `-e` Path A export | %s | %s | %s | %s | %s |\n' \
        "$CLI_EXPORT_WALL" "$CLI_EXPORT_OUTPUT_BYTES" \
        "$(fmt "$(echo "$CLI_EXPORT_OUTPUT_BYTES / 1048576" | bc -l)")" \
        "$(fmt "$(echo "$JMAP_EXPORT_MSG_COUNT / $CLI_EXPORT_WALL" | bc -l)")" \
        "$(fmt "$(echo "$CLI_EXPORT_OUTPUT_BYTES / 1048576 / $CLI_EXPORT_WALL" | bc -l)")"
    fi
    if [[ -n "$JMAP_IMPORT_WALL" ]]; then
      printf '| JMAP import per-account | %s | — | — | %s | — |\n' \
        "$JMAP_IMPORT_WALL" \
        "$(fmt "$(echo "$JMAP_IMPORT_MSG_COUNT / $JMAP_IMPORT_WALL" | bc -l)")"
    fi
    if [[ -n "$CLI_IMPORT_WALL" ]]; then
      printf '| CLI `-i` Path A import | %s | — | — | %s | — |\n' \
        "$CLI_IMPORT_WALL" \
        "$(fmt "$(echo "$JMAP_EXPORT_MSG_COUNT / $CLI_IMPORT_WALL" | bc -l)")"
    fi
    if [[ -n "$IMAP_EXPORT_WALL" ]]; then
      printf '| IMAP export (FETCH 1:* BODY[]) | %s | %s | %s | %s | %s |\n' \
        "$IMAP_EXPORT_WALL" "$IMAP_EXPORT_OUTPUT_BYTES" \
        "$(fmt "$(echo "$IMAP_EXPORT_OUTPUT_BYTES / 1048576" | bc -l)")" \
        "$(fmt "$(echo "$IMAP_EXPORT_MSG_COUNT / $IMAP_EXPORT_WALL" | bc -l)")" \
        "$(fmt "$(echo "$IMAP_EXPORT_OUTPUT_BYTES / 1048576 / $IMAP_EXPORT_WALL" | bc -l)")"
    fi
    if [[ -n "$IMAP_IMPORT_NAIVE_WALL" ]]; then
      printf '| IMAP import naive APPEND | %s | — | — | %s | — |\n' \
        "$IMAP_IMPORT_NAIVE_WALL" \
        "$(fmt "$(echo "$IMAP_IMPORT_NAIVE_MSG_COUNT / $IMAP_IMPORT_NAIVE_WALL" | bc -l)")"
    fi
    if [[ -n "$IMAP_IMPORT_MULTIAPPEND_WALL" ]]; then
      printf '| IMAP import MULTIAPPEND (batch=50) | %s | — | — | %s | — |\n' \
        "$IMAP_IMPORT_MULTIAPPEND_WALL" \
        "$(fmt "$(echo "$IMAP_IMPORT_MULTIAPPEND_MSG_COUNT / $IMAP_IMPORT_MULTIAPPEND_WALL" | bc -l)")"
    fi
    if [[ -n "$IMAP_EXPORT_BYTES_ON_WIRE" ]]; then
      echo
      echo "**Bytes on wire (IMAP export):** $IMAP_EXPORT_BYTES_ON_WIRE (vs compressed $IMAP_EXPORT_OUTPUT_BYTES — $(fmt "$(echo "$IMAP_EXPORT_BYTES_ON_WIRE / $IMAP_EXPORT_OUTPUT_BYTES" | bc -l)")× amplification)"
    fi
    echo
    echo "**Bytes on wire (JMAP export):** $JMAP_EXPORT_BYTES_ON_WIRE  (vs compressed output $JMAP_EXPORT_OUTPUT_BYTES — $(fmt "$(echo "$JMAP_EXPORT_BYTES_ON_WIRE / $JMAP_EXPORT_OUTPUT_BYTES" | bc -l)")× wire amplification)"
    [[ -n "$CLI_IMPORT_MSG_COUNT_AFTER" ]] && echo -e "\n**Post CLI-import msg count (bench user):** $CLI_IMPORT_MSG_COUNT_AFTER (expected ~$JMAP_EXPORT_MSG_COUNT)"
    echo
    echo "## Caveats"
    echo
    echo "- JMAP exports a per-account view (Maildir-shape, tar.gz). CLI exports the whole"
    echo "  server as an LZ4 logical dump. Output sizes are NOT directly comparable — only"
    echo "  wall time + msgs/sec are."
    echo "- CLI Path A required scaling Stalwart to 0 (downtime equal to the wall-time"
    echo "  plus pod start/stop overhead ~10-15s)."
    echo "- JMAP runs against a live Stalwart, no downtime."
    echo "- Path B (no-downtime via RocksDB secondary checkpoint) adds the checkpoint"
    echo "  overhead on top of Path A's wall time; see archive.ts for the implementation."
  } > "$REPORT"
  cat "$REPORT"
}

# ─── main switch ─────────────────────────────────────────────────────────────
main() {
  for tool in kubectl jq; do
    command -v "$tool" >/dev/null || die "missing tool: $tool"
  done

  : > "$LOG"
  mkdir -p "$RESULTS"
  log "starting (MSG_COUNT=$MSG_COUNT, SKIP_CLI=$SKIP_CLI)"
  p0_setup
  p1_provision
  p2_populate
  p3a_jmap_export
  [[ "$SKIP_CLI" == "1" ]] || p3b_cli_export_path_a
  p3c_jmap_import
  [[ "$SKIP_CLI" == "1" ]] || p3d_cli_import_path_a
  p3e_imap_export
  p3f_imap_import
  p4_report
  log "DONE"
}

main "$@"
