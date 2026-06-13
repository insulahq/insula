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
KEY=/etc/plesk-key/id_rsa
[ -r "$KEY" ] || { echo "FATAL: missing ssh key mount" >&2; exit 2; }

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
RSH="ssh -i $KEY -p ${PLESK_PORT} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20"
SSH="ssh -i $KEY -p ${PLESK_PORT} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20 ${PLESK_USER}@${PLESK_HOST}"

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

# --safe-links: refuse symlinks whose target escapes the source tree (a Plesk
# docroot could contain ../../../etc/... links) — copy them as nothing rather
# than faithfully reproducing an escape on the tenant PVC.
if rsync -a --safe-links --no-owner --no-group --info=stats2 -e "$RSH" \
     "${PLESK_USER}@${PLESK_HOST}:${SRC_PATH%/}/" "${DEST_PATH%/}/"; then
  echo "CONTENTRESULT ok synced ${SRC_PATH} -> ${DEST_PATH}"
else
  echo "CONTENTRESULT fail rsync-error"
fi
echo "===CONTENTSYNC-END==="
