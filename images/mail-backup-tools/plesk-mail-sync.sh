#!/bin/bash
# Plesk migration — mail-data import leg.
#
# For each mailbox: rsync the Plesk Maildir off the source box, reshape
# Maildir++ -> the importer layout, and import into Stalwart over IMAP using
# the SAME optimized engine the tenant-bundle restore uses (imap-restore.py:
# multi-worker, byte-budgeted MULTIAPPEND, master-user proxy auth). Per-mailbox
# scratch is moved into an emptyDir and deleted after each import.
#
# Env:
#   PLESK_HOST PLESK_PORT PLESK_USER   — the source box (ssh).
#   IMAP_HOST IMAP_PORT                — Stalwart IMAP (stalwart-mail.mail.svc:993).
#   STALWART_MASTER_USER               — master principal FQDN (e.g. master@<apex>).
#   STALWART_MASTER_PASSWORD           — master password (Secret-mounted env).
#   MAILBOXES                          — space-separated addresses to import.
#   WORKERS                            — parallel IMAP connections (imap-restore).
#   MODE                               — restore mode (default merge-skip-duplicates).
# Files: /etc/plesk-key/id_rsa         — ssh key to the Plesk box.
#
# Emits one `MAILRESULT <addr> ok|fail <detail>` line per mailbox between the
# sentinels so the backend can mark per-mailbox leg items.
set -uo pipefail

BEGIN='===MAILSYNC-BEGIN==='
END='===MAILSYNC-END==='

: "${PLESK_HOST:?}" "${PLESK_PORT:=22}" "${PLESK_USER:=root}" "${IMAP_HOST:?}" "${IMAP_PORT:=993}" \
  "${STALWART_MASTER_USER:?}" "${MAILBOXES:?}" "${WORKERS:=4}" "${MODE:=merge-skip-duplicates}"
KEY=/etc/plesk-key/id_rsa
[ -r "$KEY" ] || { echo "FATAL: missing ssh key mount" >&2; exit 2; }
[ -n "${STALWART_MASTER_PASSWORD:-}" ] || { echo "FATAL: STALWART_MASTER_PASSWORD not set" >&2; exit 2; }

# Clean the tmpfs scratch on ANY exit (incl. SIGTERM from activeDeadline /
# job delete) — tmpfs leftovers pin node RAM.
trap 'rm -rf /tmp/raw /tmp/reshaped /tmp/rerr /tmp/rsout /tmp/ierr 2>/dev/null' EXIT

# accept-new = trust-on-first-use (same bounded posture as the other migration
# Jobs); host-fingerprint pinning is an ADR-052 follow-up.
RSH="ssh -i $KEY -p ${PLESK_PORT} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20"

# Validate an address before it reaches the remote shell / a path.
valid_addr() { printf '%s' "$1" | grep -Eqx '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+'; }
# Match imap-restore.py's source-address sanitiser so reshape writes where the
# importer reads: <maildir-root>/<safe-addr>/<folder>.
safe_addr() { printf '%s' "$1" | sed 's/[^A-Za-z0-9._@-]/_/g'; }

echo "$BEGIN"
for addr in $MAILBOXES; do
  [ -z "$addr" ] && continue
  if ! valid_addr "$addr"; then echo "MAILRESULT ${addr} fail invalid-address"; continue; fi
  lp="${addr%@*}"; dom="${addr#*@}"
  sa=$(safe_addr "$addr")
  src="/var/qmail/mailnames/${dom}/${lp}/Maildir"
  raw="/tmp/raw/${sa}/Maildir"
  reshaped_addr="/tmp/reshaped/${sa}"
  mkdir -p "$raw" "$reshaped_addr"

  # 1. rsync the Maildir off Plesk (ssh user is root → reads it regardless of
  #    the mailbox's own perms). Live-mailbox exit 24/23 (vanished/changed
  #    files) is acceptable — the import dedups anyway.
  rsync -a --omit-dir-times --no-perms --no-owner --no-group -e "$RSH" \
        "${PLESK_USER}@${PLESK_HOST}:${src}/" "${raw}/" 2>/tmp/rerr
  rc=$?
  if [ "$rc" != "0" ] && [ "$rc" != "24" ] && [ "$rc" != "23" ]; then
    echo "MAILRESULT ${addr} fail rsync-exit-${rc}-$(head -c 80 /tmp/rerr | tr '\n' ' ')"
    rm -rf "/tmp/raw/${sa}" "$reshaped_addr"; continue
  fi

  # 2. reshape Maildir++ -> <reshaped>/<safe-addr>/<folder>/{cur,new}.
  if ! python3 /usr/local/bin/plesk-maildir-reshape.py --src "$raw" --dst "$reshaped_addr" >/tmp/rsout 2>&1; then
    echo "MAILRESULT ${addr} fail reshape-$(head -c 80 /tmp/rsout | tr '\n' ' ')"
    rm -rf "/tmp/raw/${sa}" "$reshaped_addr"; continue
  fi

  # 3. IMAP MULTIAPPEND import via the master-user proxy (multi-worker).
  out=$(python3 /usr/local/bin/imap-restore.py \
        --imap-host "$IMAP_HOST" --imap-port "$IMAP_PORT" \
        --target-address "$addr" --source-address "$addr" \
        --master-user "$STALWART_MASTER_USER" --auth-pass-env STALWART_MASTER_PASSWORD \
        --maildir-root /tmp/reshaped --workers "$WORKERS" --mode "$MODE" 2>/tmp/ierr)
  irc=$?
  if [ "$irc" = "0" ]; then
    imported=$(printf '%s' "$out" | python3 -c "import sys,json; d=json.load(sys.stdin); print('imported=%d skipped=%d failed=%d'%(d.get('imported',0),d.get('skipped',0),d.get('failed',0)))" 2>/dev/null || echo "imported=?")
    echo "MAILRESULT ${addr} ok ${imported}"
  else
    echo "MAILRESULT ${addr} fail imap-restore-exit-${irc}-$(head -c 80 /tmp/ierr | tr '\n' ' ')"
  fi
  rm -rf "/tmp/raw/${sa}" "$reshaped_addr"
done
echo "$END"
rm -f /tmp/rerr /tmp/rsout /tmp/ierr
