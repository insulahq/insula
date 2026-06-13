#!/bin/bash
# Content leg: rsync a Plesk vhost docroot into the tenant PVC, where an
# apache-php / static-apache deployment serves it. We copy the FILES only
# (including .htaccess, which the deployment's Apache honors) — the Plesk
# <VirtualHost> config is NOT translated: routing/SSL is the platform's
# ingress, and any custom global Apache directives are surfaced for manual
# review (the VHOSTREVIEW line below), not applied here.
#
# Env:
#   PLESK_HOST PLESK_PORT PLESK_USER  — the source box (ssh).
#   SRC_PATH                          — remote docroot, e.g.
#                                       /var/www/vhosts/<domain>/httpdocs
#   DEST_PATH                         — local mount under the tenant PVC.
#   VHOST_DOMAIN                      — domain name, to locate the Plesk
#                                       per-domain custom vhost config.
# Files: /etc/plesk-key/id_rsa        — ssh key to the Plesk box.
set -uo pipefail

: "${PLESK_HOST:?}" "${PLESK_PORT:=22}" "${PLESK_USER:=root}" "${SRC_PATH:?}" "${DEST_PATH:?}" "${VHOST_DOMAIN:=}"

# SSH transport: key (-i) or password (sshpass -e, SSHPASS env).
if [ "${PLESK_AUTH_METHOD:-key}" = "password" ]; then
  [ -n "${SSHPASS:-}" ] || { echo "FATAL: SSHPASS not set (password auth)" >&2; exit 2; }
  SSH_BASE="sshpass -e ssh -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -p ${PLESK_PORT}"
else
  KEY=/etc/plesk-key/id_rsa
  [ -r "$KEY" ] || { echo "FATAL: missing ssh key mount" >&2; exit 2; }
  SSH_BASE="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20 -p ${PLESK_PORT}"
fi

# Both SRC_PATH and VHOST_DOMAIN flow into commands that the REMOTE shell on
# the Plesk box evaluates — validate them strictly before any interpolation
# (the backend also validates, this is defence-in-depth). SRC_PATH must be an
# absolute path with no shell metacharacters; VHOST_DOMAIN a bare hostname.
[[ "$SRC_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "FATAL: SRC_PATH not an absolute, safe path" >&2; exit 2; }
[[ "$VHOST_DOMAIN" =~ ^[A-Za-z0-9._-]+$ ]] || VHOST_DOMAIN=''

mkdir -p "$DEST_PATH" || { echo "FATAL: cannot create $DEST_PATH" >&2; exit 2; }
# -a archive (perms/times/symlinks), --no-owner/--no-group (the tenant PVC
# is a single uid), trailing slash on SRC copies CONTENTS into DEST. No
# --delete: never destroy whatever is already in the docroot.
RSH="$SSH_BASE"
SSH="$SSH_BASE ${PLESK_USER}@${PLESK_HOST}"

echo "===CONTENTSYNC-BEGIN==="

# Vhost review signal: Plesk stores operator-added custom Apache directives in
# conf/vhost.conf (and vhost_ssl.conf) under the domain's vhost dir. We DON'T
# translate them (apache-php has no custom-vhost hook + routing is the
# platform's ingress) — we just FLAG which domains have them so the operator
# can reapply manually (as ingress middleware / app config / a runtime change).
if [ -n "$VHOST_DOMAIN" ]; then
  vdir="/var/www/vhosts/${VHOST_DOMAIN}/conf"
  if $SSH "test -s '${vdir}/vhost.conf' || test -s '${vdir}/vhost_ssl.conf'" 2>/dev/null; then
    echo "VHOSTREVIEW ${VHOST_DOMAIN} has-custom-apache-directives"
  elif [ $? -eq 255 ]; then
    # ssh transport failure — don't claim "none" when we couldn't check.
    echo "VHOSTREVIEW ${VHOST_DOMAIN} ssh-unreachable"
  else
    echo "VHOSTREVIEW ${VHOST_DOMAIN} none"
  fi
fi

# -a archive, minus the ownership/dir-time bits we can't (and shouldn't) set on
# the tenant PVC:
#   --no-owner --no-group : the PVC is a single uid; we don't own the source uids
#   --omit-dir-times      : the docroot's root dir is created+owned by the web
#                           deployment's container uid, NOT this Job's uid (65534),
#                           so chtimes on it fails with EPERM and rsync would exit
#                           non-zero even though every FILE copied fine. File mtimes
#                           are still preserved; only directory mtimes are skipped.
#   --no-perms            : likewise, don't try to chmod entries we don't own; new
#                           files land with the umask (0644 → world-readable, which
#                           is what the web server needs).
#   --safe-links          : refuse symlinks whose target escapes the source tree
#                           (a Plesk docroot could contain ../../../etc/... links).
rsync -a --omit-dir-times --no-perms --no-owner --no-group --safe-links --info=stats2 -e "$RSH" \
     "${PLESK_USER}@${PLESK_HOST}:${SRC_PATH%/}/" "${DEST_PATH%/}/"
rc=$?
# rsync exit codes on a LIVE source:
#   0  clean.
#   24 "some source files vanished before they could be transferred" — normal
#      when the site is live (a session/cache/log file rotated mid-copy). The
#      copy is otherwise complete; treat as success.
#   23 "partial transfer due to error" — some files genuinely couldn't be sent;
#      the bulk copied, so don't fail the whole site, but flag it for review.
case "$rc" in
  0)  echo "CONTENTRESULT ok synced ${SRC_PATH} -> ${DEST_PATH}" ;;
  24) echo "CONTENTRESULT ok synced (some files vanished mid-copy — normal for a live site)" ;;
  23) echo "CONTENTRESULT ok synced-with-warnings (rsync 23: a few files were skipped — review)" ;;
  *)  echo "CONTENTRESULT fail rsync exit ${rc}" ;;
esac
echo "===CONTENTSYNC-END==="
