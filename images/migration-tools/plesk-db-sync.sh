#!/bin/bash
# DB leg: stream each Plesk client database straight into the tenant's
# MariaDB. mysqldump runs ON the Plesk box (over ssh), its stdout is piped
# into the LOCAL mariadb client pointed at the tenant DB Service — no
# intermediate file, any size.
#
# Env:
#   PLESK_HOST PLESK_PORT PLESK_USER  — the source box (ssh).
#   DB_HOST                           — tenant MariaDB Service DNS.
#   DB_PORT                           — default 3306.
#   DB_NAMES                          — newline/space-separated db names.
# Files (mounted, read-only):
#   /etc/plesk-key/id_rsa             — ssh key to the Plesk box.
#   /etc/db-creds/root-password       — tenant MariaDB root password.
#
# Emits one `DBRESULT <db> ok|fail <msg>` line per database between the
# sentinels below so the backend can mark per-database leg items. Exits 0
# unless something fatal happens before the per-db loop (so partial results
# are always readable); the backend decides overall status from the lines.
set -uo pipefail

BEGIN='===DBSYNC-BEGIN==='
END='===DBSYNC-END==='

: "${PLESK_HOST:?}" "${PLESK_PORT:=22}" "${PLESK_USER:=root}" "${DB_HOST:?}" "${DB_PORT:=3306}"
ROOTPW_FILE=/etc/db-creds/root-password

is_name() { printf '%s' "$1" | grep -Eqx '[A-Za-z0-9_][A-Za-z0-9_-]*'; }

[ -r "$ROOTPW_FILE" ] || { echo "FATAL: missing db root-password mount" >&2; exit 2; }
ROOTPW=$(cat "$ROOTPW_FILE")

# SSH transport: key (-i) or password (sshpass -e, SSHPASS env). accept-new =
# trust-on-first-use (same bounded posture as the discovery Job);
# host-fingerprint pinning captured at discovery is an ADR-052 follow-up.
if [ "${PLESK_AUTH_METHOD:-key}" = "password" ]; then
  [ -n "${SSHPASS:-}" ] || { echo "FATAL: SSHPASS not set (password auth)" >&2; exit 2; }
  SSH_BASE="sshpass -e ssh -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -p ${PLESK_PORT}"
else
  KEY=/etc/plesk-key/id_rsa
  [ -r "$KEY" ] || { echo "FATAL: missing ssh key mount" >&2; exit 2; }
  SSH_BASE="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20 -p ${PLESK_PORT}"
fi
SSH="$SSH_BASE ${PLESK_USER}@${PLESK_HOST}"

# Fail fast (before the sentinel block) if we can't even reach the box —
# that's a setup error, not a per-database failure.
if ! $SSH 'echo ok' >/dev/null 2>&1; then
  echo "FATAL: cannot ssh ${PLESK_USER}@${PLESK_HOST}:${PLESK_PORT}" >&2
  exit 3
fi

echo "$BEGIN"
for db in $DB_NAMES; do
  [ -z "$db" ] && continue
  if ! is_name "$db"; then
    echo "DBRESULT ${db} fail invalid-database-name"
    continue
  fi
  # mysqldump on the Plesk box as the Plesk MySQL admin ('admin', whose
  # password is /etc/psa/.psa.shadow — root-readable). MYSQL_PWD keeps it
  # out of argv (it IS briefly visible in /proc/<pid>/environ on the Plesk
  # box, readable only by root there — acceptable for an operator-owned box).
  # --single-transaction = consistent InnoDB snapshot without locking;
  # --no-tablespaces avoids needing the PROCESS privilege.
  # --add-drop-table makes RE-IMPORT idempotent: this leg is retryable, and
  # without DROP TABLE a re-run would CREATE-IF-NOT-EXISTS (skip) then INSERT
  # again → DUPLICATE ROWS. DROP+CREATE+INSERT is clean on every run (matches
  # Plesk's own backup tooling).
  # printf %q shell-quotes the (already allowlist-validated) db name as
  # defence-in-depth for the remote shell evaluation.
  db_q=$(printf '%q' "$db")
  remote="MYSQL_PWD=\$(cat /etc/psa/.psa.shadow) exec mysqldump --single-transaction --quick --no-tablespaces --routines --triggers --add-drop-table -uadmin -- ${db_q}"
  if $SSH "$remote" 2>/tmp/dumperr | MYSQL_PWD="$ROOTPW" mariadb --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" -uroot "$db" 2>/tmp/imperr; then
    echo "DBRESULT ${db} ok imported"
  else
    msg=$(head -c 200 /tmp/dumperr /tmp/imperr 2>/dev/null | tr '\n' ' ' | tr -d '\r')
    echo "DBRESULT ${db} fail ${msg:-dump-or-import-error}"
  fi
done
echo "$END"
rm -f /tmp/dumperr /tmp/imperr
