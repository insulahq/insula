# Plesk read-only discovery (R1 PR 1). Runs ON the Plesk box via
# `ssh … 'bash -s'`. Emits tab-separated records (no JSON assembly on
# the remote side — avoids shell-escaping arbitrary names). MUTATES
# NOTHING: only `plesk db -Ne` SELECTs, `plesk version`, du/crontab -l.
set -u
emit() { printf '%s\n' "$*"; }
# Validate an identifier is a bare integer / safe name before it is
# interpolated into subsequent SQL — defense in depth: these values come
# from the source's OWN database (e.g. tenant-chosen domain names).
is_int() { printf '%s' "$1" | grep -Eqx '[0-9]+'; }
is_name() { printf '%s' "$1" | grep -Eqx '[A-Za-z0-9._-]+'; }

VER=$(plesk version 2>/dev/null | awk -F': *' '/Product version/{print $2; exit}')
OSV=$(plesk version 2>/dev/null | awk -F': *' '/OS version/{print $2; exit}')
# Health gate: a totally unreachable Plesk DB (wrong SSH user / no plesk
# rights) must FAIL the Job, not return an empty-but-valid inventory.
if [ -z "${VER:-}" ] && ! plesk db -Ne "SELECT 1" >/dev/null 2>&1; then
  echo "FATAL: 'plesk version' empty and 'plesk db' unreachable — SSH user lacks Plesk access?" >&2
  exit 3
fi
emit "META	version	${VER:-}"
emit "META	os	${OSV:-}"

# server-wide password storage mode (distribution of accounts.type)
plesk db -Ne "SELECT type, COUNT(*) FROM accounts GROUP BY type" 2>/dev/null \
  | while IFS=$'\t' read -r t c; do emit "PWMODE	${t}	${c}"; done

# subscriptions = main domains (webspace_id = 0)
plesk db -Ne "SELECT name FROM domains WHERE webspace_id = 0 ORDER BY name" 2>/dev/null \
  | while IFS=$'\t' read -r sub; do
      [ -z "$sub" ] && continue
      is_name "$sub" || continue
      emit "SUB	${sub}"
      SUBID=$(plesk db -Ne "SELECT id FROM domains WHERE name='${sub}'" 2>/dev/null)
      is_int "${SUBID:-}" || continue

      # domains of the subscription (main + addon) with docroot + php handler
      plesk db -Ne "SELECT d.name, h.www_root, h.php_handler_id FROM domains d LEFT JOIN hosting h ON h.dom_id=d.id WHERE d.id=${SUBID} OR d.webspace_id=${SUBID}" 2>/dev/null \
        | while IFS=$'\t' read -r dn root php; do emit "DOMAIN	${sub}	${dn}	${root:-}	${php:-}"; done

      # databases of the subscription
      plesk db -Ne "SELECT db.name, db.type FROM data_bases db WHERE db.dom_id=${SUBID} OR db.dom_id IN (SELECT id FROM domains WHERE webspace_id=${SUBID})" 2>/dev/null \
        | while IFS=$'\t' read -r dbn dbt; do
            SZ=$(du -sb "/var/lib/mysql/${dbn}" 2>/dev/null | awk '{print $1}')
            emit "DB	${sub}	${dbn}	${dbt:-mysql}	${SZ:-}"
          done

      # mailboxes + maildir size per domain
      for dn in $(plesk db -Ne "SELECT name FROM domains WHERE id=${SUBID} OR webspace_id=${SUBID}" 2>/dev/null); do
        is_name "$dn" || continue
        plesk db -Ne "SELECT CONCAT(m.mail_name,'@','${dn}'), a.type, mb.value FROM mail m JOIN domains d ON d.id=m.dom_id LEFT JOIN accounts a ON a.id=m.account_id LEFT JOIN mail_aux mb ON mb.mn_id=m.id AND mb.type='mbox_quota' WHERE d.name='${dn}'" 2>/dev/null \
          | while IFS=$'\t' read -r addr atype quota; do emit "MBOX	${sub}	${addr}	${quota:-}	${atype:-}"; done
        MD="/var/qmail/mailnames/${dn}"
        if [ -d "$MD" ]; then SZ=$(du -sb "$MD" 2>/dev/null | awk '{print $1}'); emit "MAILSIZE	${sub}	${SZ:-}"; fi
      done

      # subscription sysuser + cron line count
      SYSUSER=$(plesk db -Ne "SELECT s.login FROM sys_users s JOIN hosting h ON h.sys_user_id=s.id WHERE h.dom_id=${SUBID}" 2>/dev/null)
      if [ -n "${SYSUSER:-}" ] && is_name "$SYSUSER"; then
        emit "SUBMETA	${sub}	sysuser	${SYSUSER}"
        CN=$(crontab -u "$SYSUSER" -l 2>/dev/null | grep -vcE '^[[:space:]]*(#|$)')
        emit "SUBMETA	${sub}	cron	${CN:-0}"
      fi
    done
emit "DONE"
