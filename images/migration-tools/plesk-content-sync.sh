#!/bin/bash
# Content leg (wired up in a later PR): rsync a Plesk vhost docroot into the
# tenant PVC, where an apache-php deployment serves it. We copy the FILES
# only (including .htaccess, which apache-php's Apache honors) — the Plesk
# <VirtualHost> config is NOT translated: routing/SSL is the platform's
# ingress, and any custom global Apache directives are surfaced for manual
# review by the backend, not applied here.
#
# Env:
#   PLESK_HOST PLESK_PORT PLESK_USER  — the source box (ssh).
#   SRC_PATH                          — remote docroot, e.g.
#                                       /var/www/vhosts/<domain>/httpdocs
#   DEST_PATH                         — local mount under the tenant PVC.
# Files: /etc/plesk-key/id_rsa        — ssh key to the Plesk box.
set -uo pipefail

: "${PLESK_HOST:?}" "${PLESK_PORT:=22}" "${PLESK_USER:=root}" "${SRC_PATH:?}" "${DEST_PATH:?}"
KEY=/etc/plesk-key/id_rsa
[ -r "$KEY" ] || { echo "FATAL: missing ssh key mount" >&2; exit 2; }

mkdir -p "$DEST_PATH"
# -a archive (perms/times/symlinks), --no-owner/--no-group (the tenant PVC
# is a single uid), trailing slash on SRC copies CONTENTS into DEST. No
# --delete: never destroy whatever is already in the docroot.
RSH="ssh -i $KEY -p ${PLESK_PORT} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20"
echo "===CONTENTSYNC-BEGIN==="
if rsync -a --no-owner --no-group --info=stats2 -e "$RSH" \
     "${PLESK_USER}@${PLESK_HOST}:${SRC_PATH%/}/" "${DEST_PATH%/}/"; then
  echo "CONTENTRESULT ok synced ${SRC_PATH} -> ${DEST_PATH}"
else
  echo "CONTENTRESULT fail rsync-error"
fi
echo "===CONTENTSYNC-END==="
