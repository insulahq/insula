#!/usr/bin/env bash
# ci-restic-restore-selinux-check.sh — every `restic restore` leaves the SELinux label out.
#
# restic restores extended attributes exactly. The SELinux label belongs to the
# node a file is written on: the kernel sets one on every new file where SELinux
# is on, and files have none where it is off. So a snapshot taken on a node of
# one kind failed to restore on a node of the other — on a node with SELinux
# restic tries to remove the label the kernel just set, which no process may do;
# on one without, it tries to set one. The data was written, the restore counted
# as failed: a shrink left the tenant stopped, a mail failover from a Debian or
# Ubuntu server to a RHEL-family one had no snapshot it could restore.
#
# Invariant: every line that RUNS `restic … restore` in the platform's sources
# carries `--exclude-xattr security.selinux`, written out or through the
# backend's RESTIC_RESTORE_SKIP_SELINUX_LABEL. (The restore the API runs itself
# builds its arguments as a list; restic-driver.test.ts holds that one.)
#
# Exits non-zero on any violation.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

# Lines that run it: `restic restore <snapshot>` or `restic -r "$REPO" restore <snapshot>`,
# the snapshot being `latest` or a variable. A message that only names the
# command ("restic restore failed") has neither after it.
RUNS='restic( +-r +"\$REPO")? +restore +(latest |["'"'"']*\$)'
FLAG='--exclude-xattr security\.selinux|RESTIC_RESTORE_SKIP_SELINUX_LABEL'

found=0
bad=0
while IFS= read -r hit; do
  file=${hit%%:*}
  rest=${hit#*:}
  line=${rest#*:}
  # Not a command: a comment, or a message that only names one.
  if [[ "$line" =~ ^[[:space:]]*(#|//|\*|/\*) ]]; then continue; fi
  if [[ "$line" =~ ^[[:space:]]*(echo|log|die)[[:space:]] ]]; then continue; fi
  if [[ "$line" =~ ^[[:space:]]*[\'\"\`]?echo[[:space:]] ]]; then continue; fi
  found=$((found + 1))
  if ! grep -Eq -- "$FLAG" <<<"$line"; then
    echo "ci-restic-restore-selinux-check: ${file}:${rest%%:*} runs restic restore without --exclude-xattr security.selinux" >&2
    bad=$((bad + 1))
  fi
done < <(grep -rnE --include='*.ts' --include='*.sh' --include='*.yaml' --include='*.yml' --include='*.py' \
           --exclude='*.test.ts' --exclude='ci-restic-restore-selinux-check.sh' \
           --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=archive \
           -- "$RUNS" backend/src images k8s scripts platform 2>/dev/null || true)

# A guard that matched nothing is checking nothing.
if (( found < 8 )); then
  echo "ci-restic-restore-selinux-check: found only ${found} restic restore command(s); there are 8 — the pattern no longer matches one of them (or one was removed: lower this count with it)" >&2
  exit 1
fi
if (( bad > 0 )); then
  echo "ci-restic-restore-selinux-check: ${bad} of ${found} restic restore command(s) would fail across SELinux and non-SELinux nodes" >&2
  exit 1
fi
echo "ci-restic-restore-selinux-check: OK (${found} restic restore commands, all leave the SELinux label out)"
