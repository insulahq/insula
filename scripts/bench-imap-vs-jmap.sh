#!/usr/bin/env bash
#
# bench-imap-vs-jmap.sh — comprehensive head-to-head benchmark of the
# IMAP and JMAP per-tenant mailbox backup engines.
#
# Captures per engine, for capture AND restore:
#   * Wall time (seconds)
#   * Throughput (msgs/sec)
#   * Helper pod RSS peak (client-side memory, via `/usr/bin/time -v`)
#   * Stalwart pod RSS peak (server-side memory, /proc/1/status sampler)
#   * Bytes on wire (from sync.py summary's bytes_on_wire field — IMAP
#     reports 0 due to a known buffered-read bug; we report tarball
#     compressed size as a stand-in for IMAP)
#   * Maildir tarball compressed size (from `du -sb`)
#   * Restored mailbox size from `STATUS Inbox (MESSAGES SIZE)` —
#     post-restore on the destination user
#
# Designed for testing.example.test (single-node test cluster
# with `mailperf-bench.net` test domain + e2e-src/e2e-imap-dst/
# e2e-jmap-dst users already created by the L1 harness).
#
# Env knobs:
#   CORPUS_SIZE   default 3000 — number of mixed-size msgs to seed
#   WORKERS       default 4    — parallel workers for both engines
#   STALWART_NS   default mail
#   HELPER_NS     default export-perf
#
# Run from operator workstation:
#   scp bench-imap-vs-jmap.sh root@testing:/tmp/bench.sh
#   ssh root@testing 'bash /tmp/bench.sh' | tee bench-result.md

set -euo pipefail

CORPUS_SIZE="${CORPUS_SIZE:-3000}"
WORKERS="${WORKERS:-4}"
STALWART_NS="${STALWART_NS:-mail}"
HELPER_NS="${HELPER_NS:-export-perf}"
HELPER="${HELPER:-export-perf-helper}"
DOMAIN="${DOMAIN:-mailperf-bench.net}"
DOMAIN_ID="${DOMAIN_ID:-c}"
SRC_USER="e2e-src"
IMAP_DST="e2e-imap-dst"
JMAP_DST="e2e-jmap-dst"

MFQDN=$(cat /tmp/mfqdn)
MPW=$(cat /tmp/mpw)
APW=$(cat /tmp/apw)

# ── helpers ─────────────────────────────────────────────────────────────────

log()  { printf '[%(%H:%M:%S)T] %s\n' -1 "$*" >&2; }

# Get Stalwart pod name (refreshes each call — pod can rotate)
stalwart_pod() {
  kubectl -n "$STALWART_NS" get pods -l app=stalwart-mail \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null
}

# Sample Stalwart's VmRSS (in KB) — read from /proc/1/status.
stalwart_rss_kb() {
  local pod=$1
  kubectl -n "$STALWART_NS" exec "$pod" -- \
    awk '/^VmRSS:/{print $2}' /proc/1/status 2>/dev/null || echo 0
}

# Background sampler — writes max RSS observed to $1.
start_sampler() {
  local out_file=$1 pod=$2 pid_file=$3
  (
    local max=0
    while true; do
      local v=$(stalwart_rss_kb "$pod" 2>/dev/null || echo 0)
      v=${v//[^0-9]/}
      [ -z "$v" ] && v=0
      [ "$v" -gt "$max" ] && max=$v
      echo "$max" > "$out_file"
      sleep 0.5
    done
  ) &
  echo $! > "$pid_file"
}

stop_sampler() {
  local pid_file=$1
  local pid=$(cat "$pid_file" 2>/dev/null || echo "")
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  rm -f "$pid_file"
}

# Wipe a user's mailboxes (between cycles, fair comparison).
wipe_user() {
  local user=$1
  kubectl -n "$HELPER_NS" exec "$HELPER" -- env MPW="$MPW" python3 -c "
import os, sys
sys.path.insert(0, '/tmp/perf')
from imap_client import ImapClient
with ImapClient('stalwart-mail.${STALWART_NS}.svc.cluster.local', 993, verify_tls=False) as c:
    c.login('${user}@${DOMAIN}%${MFQDN}', os.environ['MPW'])
    c.enable('UTF8=ACCEPT')
    for f in c.list_folders():
        if '\\\\Noselect' in f.flags: continue
        try:
            st = c.select(f.name, readonly=False)
            if st.get('EXISTS', 0) > 0:
                c.store_deleted('1:*')
                c.expunge()
        except Exception as e:
            print(f'wipe {f.name!r}: {e}')
" 2>&1 | head -3
}

# STATUS Inbox (MESSAGES SIZE) — returns "msgcount sizebytes"
folder_status() {
  local user=$1
  kubectl -n "$HELPER_NS" exec "$HELPER" -- env MPW="$MPW" python3 -c "
import os, sys
sys.path.insert(0, '/tmp/perf')
from imap_client import ImapClient
with ImapClient('stalwart-mail.${STALWART_NS}.svc.cluster.local', 993, verify_tls=False) as c:
    c.login('${user}@${DOMAIN}%${MFQDN}', os.environ['MPW'])
    c.enable('UTF8=ACCEPT')
    total_msgs = 0
    total_size = 0
    for f in c.list_folders():
        if '\\\\Noselect' in f.flags: continue
        try:
            resp, untagged = c._cmd('STATUS ' + c._quote_astring(f.name) + ' (MESSAGES SIZE)')
            for u in untagged:
                txt = u.decode('utf-8','replace')
                import re
                m = re.search(r'MESSAGES (\d+)', txt); n = int(m.group(1)) if m else 0
                s = re.search(r'SIZE (\d+)', txt); sz = int(s.group(1)) if s else 0
                total_msgs += n
                total_size += sz
        except Exception:
            pass
    print(f'{total_msgs} {total_size}')
" 2>/dev/null | tail -1
}

# Maildir size via du -sb (bytes).
maildir_bytes() {
  local dir=$1
  kubectl -n "$HELPER_NS" exec "$HELPER" -- sh -c "du -sb '$dir' 2>/dev/null | awk '{print \$1}'"
}

# Format KB → MB.
fmt_mb() { awk -v kb="$1" 'BEGIN{printf "%.1f", kb/1024}'; }
fmt_mb_from_b() { awk -v b="$1" 'BEGIN{printf "%.1f", b/1048576}'; }

# ── setup ───────────────────────────────────────────────────────────────────

log "bench start: CORPUS_SIZE=$CORPUS_SIZE WORKERS=$WORKERS"
log "Stalwart pod: $(stalwart_pod), baseline RSS: $(fmt_mb $(stalwart_rss_kb $(stalwart_pod))) MB"

# Re-populate src to a clean known state (skip if SKIP_POPULATE=1 and src is already at the right size).
if [ "${SKIP_POPULATE:-0}" = "1" ]; then
  log "SKIP_POPULATE=1: reusing existing $SRC_USER corpus"
else
log "wiping + populating $SRC_USER"
wipe_user "$SRC_USER" >/dev/null
kubectl -n "$HELPER_NS" exec "$HELPER" -- env MPW="$MPW" CORPUS_SIZE="$CORPUS_SIZE" python3 -c "
import os, sys, time, random
import requests
JMAP='http://stalwart-mgmt.${STALWART_NS}.svc.cluster.local:8080'
USER='${SRC_USER}@${DOMAIN}'
PW=os.environ['MPW']
random.seed(42)
s = requests.Session(); s.auth = (f'{USER}%${MFQDN}', PW)
sess = s.get(f'{JMAP}/jmap/session').json()
ACCT = sess['primaryAccounts']['urn:ietf:params:jmap:mail']
mb_r = s.post(f'{JMAP}/jmap', json={'using':['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],'methodCalls':[['Mailbox/get',{'accountId':ACCT,'ids':None},'c0']]}).json()
inbox = next(m['id'] for m in mb_r['methodResponses'][0][1]['list'] if m.get('role')=='inbox')
n = int(os.environ['CORPUS_SIZE'])
print(f'seeding {n} msgs', flush=True)
for i in range(n):
    r = random.random()
    sz = 5000 if r<0.6 else (80000 if r<0.9 else 500000)
    body = (b'X'*sz)
    msg = b'From: a@b\r\nTo: '+USER.encode()+b'\r\nSubject: bench '+str(i).encode()+b'\r\nMessage-ID: <bench-'+str(time.time_ns()).encode()+b'@perf.test>\r\nContent-Type: application/octet-stream\r\n\r\n'+body
    up = s.post(f'{JMAP}/jmap/upload/{ACCT}/', data=msg, headers={'Content-Type':'message/rfc822'})
    up.raise_for_status()
    blob = up.json()['blobId']
    imp = s.post(f'{JMAP}/jmap', json={'using':['urn:ietf:params:jmap:core','urn:ietf:params:jmap:mail'],'methodCalls':[['Email/import',{'accountId':ACCT,'emails':{'i':{'blobId':blob,'mailboxIds':{inbox:True},'keywords':{'\\\\\\\\Seen':True}}}},'c0']]}).json()
    if i and i%500==0: print(f'  seeded {i}', flush=True)
print(f'POPULATED {n}')
" 2>&1 | tail -8
fi

read SRC_MSGS SRC_SIZE <<< "$(folder_status $SRC_USER)"
log "source state: $SRC_MSGS msgs, $(fmt_mb_from_b $SRC_SIZE) MB"

# Output table accumulator (build at end)
declare -A R_WALL R_MSGSEC R_BYTES R_TARGZ R_STALW_RSS R_HELPER_RSS R_DST_SIZE

# ── run one engine cycle ────────────────────────────────────────────────────

run_cycle() {
  local engine=$1
  local dst_user
  local cap_script restore_script
  local cap_args restore_args
  local maildir="/tmp/bench-maildir-${engine}"

  case "$engine" in
    imap)
      dst_user="$IMAP_DST"
      cap_script="/tmp/perf/imap-sync.py"
      restore_script="/tmp/perf/imap-restore.py"
      cap_args="--imap-host stalwart-mail.${STALWART_NS}.svc.cluster.local --account-address ${SRC_USER}@${DOMAIN} --master-user $MFQDN --auth-pass-env STALWART_MASTER_PASSWORD --output-dir $maildir"
      restore_args="--imap-host stalwart-mail.${STALWART_NS}.svc.cluster.local --target-address ${dst_user}@${DOMAIN} --source-address ${SRC_USER}@${DOMAIN} --master-user $MFQDN --auth-pass-env STALWART_MASTER_PASSWORD --maildir-root $maildir --mode merge-overwrite --workers $WORKERS"
      ;;
    jmap)
      dst_user="$JMAP_DST"
      cap_script="/tmp/perf/jmap-sync-stock.py"
      restore_script="/tmp/perf/jmap-restore-stock.py"
      cap_args="--endpoint http://stalwart-mgmt.${STALWART_NS}.svc.cluster.local:8080 --account-address ${SRC_USER}@${DOMAIN} --master-user $MFQDN --auth-pass-env STALWART_MASTER_PASSWORD --output-dir $maildir"
      restore_args="--endpoint http://stalwart-mgmt.${STALWART_NS}.svc.cluster.local:8080 --target-address ${dst_user}@${DOMAIN} --source-address ${SRC_USER}@${DOMAIN} --master-user $MFQDN --auth-pass-env STALWART_MASTER_PASSWORD --maildir-root $maildir --mode merge-overwrite --workers $WORKERS"
      ;;
  esac

  log "─── ${engine^^} CYCLE ───"

  # ─── CAPTURE ───
  kubectl -n "$HELPER_NS" exec "$HELPER" -- rm -rf "$maildir"
  log "$engine: ensure pip install resource (for client RSS via Python rusage)"
  log "$engine: starting Stalwart RSS sampler"
  local sampler_out=/tmp/sampler-${engine}-cap.max
  local sampler_pid=/tmp/sampler-${engine}-cap.pid
  rm -f "$sampler_out" "$sampler_pid"
  start_sampler "$sampler_out" "$(stalwart_pod)" "$sampler_pid"

  log "$engine: CAPTURE"
  local t0=$(date +%s.%N)
  # /usr/bin/time -v writes to stderr; capture into a tmp file via 2>>.
  kubectl -n "$HELPER_NS" exec "$HELPER" -- sh -c "
    env STALWART_MASTER_PASSWORD='$MPW' /usr/bin/time -v python3 $cap_script $cap_args 2>/tmp/time.${engine}.cap" \
    > /tmp/sum.${engine}.cap.json 2>&1 || true
  local t1=$(date +%s.%N)
  sleep 1; stop_sampler "$sampler_pid"
  local cap_wall=$(echo "$t1 - $t0" | bc -l)
  local cap_stalw_rss=$(cat "$sampler_out" 2>/dev/null || echo 0)
  local cap_helper_rss=$(kubectl -n "$HELPER_NS" exec "$HELPER" -- awk '/Maximum resident set size/{print $NF}' /tmp/time.${engine}.cap 2>/dev/null || echo 0)
  local cap_fetched cap_bytes cap_targz
  # The python summary JSON lives on the TESTING HOST in /tmp/sum.*.json
  # (the outer kubectl's stdout redirect), NOT inside the helper pod.
  cap_fetched=$(python3 -c "
import json
val = 0
for line in open('/tmp/sum.${engine}.cap.json').read().splitlines():
    line = line.strip()
    if line.startswith('{') and line.endswith('}'):
        try:
            val = int(json.loads(line).get('fetched', 0)); break
        except Exception:
            pass
print(val)
" 2>/dev/null || echo 0)
  cap_bytes=$(python3 -c "
import json
val = 0
for line in open('/tmp/sum.${engine}.cap.json').read().splitlines():
    line = line.strip()
    if line.startswith('{') and line.endswith('}'):
        try:
            val = int(json.loads(line).get('bytes_on_wire', 0)); break
        except Exception:
            pass
print(val)
" 2>/dev/null || echo 0)
  cap_targz=$(kubectl -n "$HELPER_NS" exec "$HELPER" -- sh -c "tar -C '$maildir' -czf - . 2>/dev/null | wc -c" || echo 0)
  log "$engine cap: ${cap_wall}s, ${cap_fetched} msgs, helper RSS $(fmt_mb $cap_helper_rss) MB, stalwart RSS $(fmt_mb $cap_stalw_rss) MB"

  # ─── RESTORE ───
  wipe_user "$dst_user" >/dev/null
  sampler_out=/tmp/sampler-${engine}-rst.max
  sampler_pid=/tmp/sampler-${engine}-rst.pid
  rm -f "$sampler_out" "$sampler_pid"
  start_sampler "$sampler_out" "$(stalwart_pod)" "$sampler_pid"

  log "$engine: RESTORE workers=$WORKERS"
  t0=$(date +%s.%N)
  kubectl -n "$HELPER_NS" exec "$HELPER" -- sh -c "
    env STALWART_MASTER_PASSWORD='$MPW' /usr/bin/time -v python3 $restore_script $restore_args 2>/tmp/time.${engine}.rst" \
    > /tmp/sum.${engine}.rst.json 2>&1 || true
  t1=$(date +%s.%N)
  sleep 1; stop_sampler "$sampler_pid"
  local rst_wall=$(echo "$t1 - $t0" | bc -l)
  local rst_stalw_rss=$(cat "$sampler_out" 2>/dev/null || echo 0)
  local rst_helper_rss=$(kubectl -n "$HELPER_NS" exec "$HELPER" -- awk '/Maximum resident set size/{print $NF}' /tmp/time.${engine}.rst 2>/dev/null || echo 0)
  local rst_imported=$(python3 -c "
import json
val = 0
for line in open('/tmp/sum.${engine}.rst.json').read().splitlines():
    line = line.strip()
    if line.startswith('{') and line.endswith('}'):
        try:
            val = int(json.loads(line).get('imported', 0)); break
        except Exception:
            pass
print(val)
" 2>/dev/null || echo 0)
  read dst_msgs dst_size <<< "$(folder_status $dst_user)"
  log "$engine rst: ${rst_wall}s, $rst_imported imported, dst now $dst_msgs msgs / $(fmt_mb_from_b $dst_size) MB"

  # Save for the table
  R_WALL[${engine}.cap]=$cap_wall;        R_WALL[${engine}.rst]=$rst_wall
  R_MSGSEC[${engine}.cap]=$(awk -v n=$cap_fetched -v w=$cap_wall 'BEGIN{printf "%.1f", n/w}')
  R_MSGSEC[${engine}.rst]=$(awk -v n=$rst_imported -v w=$rst_wall 'BEGIN{printf "%.1f", n/w}')
  R_BYTES[${engine}.cap]=$cap_bytes
  R_TARGZ[${engine}.cap]=$cap_targz
  R_STALW_RSS[${engine}.cap]=$cap_stalw_rss
  R_STALW_RSS[${engine}.rst]=$rst_stalw_rss
  R_HELPER_RSS[${engine}.cap]=$cap_helper_rss
  R_HELPER_RSS[${engine}.rst]=$rst_helper_rss
  R_DST_SIZE[${engine}]=$dst_size
}

run_cycle imap
run_cycle jmap

# ── report ─────────────────────────────────────────────────────────────────

echo
echo "════════════════════════════════════════════════════════════════════════"
echo "BENCHMARK RESULT — IMAP vs JMAP — CORPUS=$CORPUS_SIZE WORKERS=$WORKERS"
echo "Source: $SRC_USER ($SRC_MSGS msgs, $(fmt_mb_from_b $SRC_SIZE) MB stored)"
echo "Stalwart pod baseline RSS recorded as VmRSS of /proc/1/status."
echo "════════════════════════════════════════════════════════════════════════"
echo
printf "%-30s | %-15s | %-15s | %-10s\n" "Metric" "IMAP" "JMAP" "IMAP win?"
printf -- "--------------------------------+-----------------+-----------------+----------\n"
for k in cap.wall cap.msgsec rst.wall rst.msgsec cap.bytes cap.targz cap.stalw_rss rst.stalw_rss cap.helper_rss rst.helper_rss; do
  case "$k" in
    cap.wall)   label="Capture wall (s)";          imap_v=${R_WALL[imap.cap]};       jmap_v=${R_WALL[jmap.cap]};       lower_better=1 ;;
    cap.msgsec) label="Capture msg/s";             imap_v=${R_MSGSEC[imap.cap]};     jmap_v=${R_MSGSEC[jmap.cap]};     lower_better=0 ;;
    rst.wall)   label="Restore wall (s)";          imap_v=${R_WALL[imap.rst]};       jmap_v=${R_WALL[jmap.rst]};       lower_better=1 ;;
    rst.msgsec) label="Restore msg/s";             imap_v=${R_MSGSEC[imap.rst]};     jmap_v=${R_MSGSEC[jmap.rst]};     lower_better=0 ;;
    cap.bytes)  label="Bytes on wire (capture)";   imap_v="$(fmt_mb_from_b ${R_BYTES[imap.cap]:-0}) MB"; jmap_v="$(fmt_mb_from_b ${R_BYTES[jmap.cap]:-0}) MB"; lower_better=1 ;;
    cap.targz)  label="Tarball gz (capture, MB)";  imap_v="$(fmt_mb_from_b ${R_TARGZ[imap.cap]:-0}) MB"; jmap_v="$(fmt_mb_from_b ${R_TARGZ[jmap.cap]:-0}) MB"; lower_better=1 ;;
    cap.stalw_rss)  label="Stalwart RSS peak — cap"; imap_v="$(fmt_mb ${R_STALW_RSS[imap.cap]:-0}) MB"; jmap_v="$(fmt_mb ${R_STALW_RSS[jmap.cap]:-0}) MB"; lower_better=1 ;;
    rst.stalw_rss)  label="Stalwart RSS peak — rst"; imap_v="$(fmt_mb ${R_STALW_RSS[imap.rst]:-0}) MB"; jmap_v="$(fmt_mb ${R_STALW_RSS[jmap.rst]:-0}) MB"; lower_better=1 ;;
    cap.helper_rss) label="Helper RSS peak — cap";   imap_v="$(fmt_mb ${R_HELPER_RSS[imap.cap]:-0}) MB"; jmap_v="$(fmt_mb ${R_HELPER_RSS[jmap.cap]:-0}) MB"; lower_better=1 ;;
    rst.helper_rss) label="Helper RSS peak — rst";   imap_v="$(fmt_mb ${R_HELPER_RSS[imap.rst]:-0}) MB"; jmap_v="$(fmt_mb ${R_HELPER_RSS[jmap.rst]:-0}) MB"; lower_better=1 ;;
  esac
  win=""
  num_imap=$(echo "$imap_v" | tr -dc '0-9.')
  num_jmap=$(echo "$jmap_v" | tr -dc '0-9.')
  if [ -n "$num_imap" ] && [ -n "$num_jmap" ] && [ "$num_imap" != "$num_jmap" ]; then
    if [ "$lower_better" = "1" ]; then
      if [ "$(awk -v a="$num_imap" -v b="$num_jmap" 'BEGIN{print (a<b)?"1":"0"}')" = "1" ]; then win="✓"; fi
    else
      if [ "$(awk -v a="$num_imap" -v b="$num_jmap" 'BEGIN{print (a>b)?"1":"0"}')" = "1" ]; then win="✓"; fi
    fi
  fi
  printf "%-30s | %-15s | %-15s | %-10s\n" "$label" "$imap_v" "$jmap_v" "$win"
done
echo
echo "Restored mailbox size on dst (STATUS SIZE):"
echo "  IMAP: $(fmt_mb_from_b ${R_DST_SIZE[imap]:-0}) MB"
echo "  JMAP: $(fmt_mb_from_b ${R_DST_SIZE[jmap]:-0}) MB"
echo
echo "════════════════════════════════════════════════════════════════════════"
