# Discovery Job runner (R1 PR 1). ssh's to the Plesk box running the read-only
# inventory script, then hands its output to the assembler.
set -e
# /tmp is an ephemeral emptyDir, but clean the key + capture explicitly per the
# repo /tmp-cleanup rule regardless of how the pod exits.
trap 'rm -f /tmp/id_rsa /tmp/discover.out' EXIT
# SSH transport: key (-i) or password (sshpass -e, SSHPASS env).
# accept-new trusts the host key on FIRST contact (no protection vs a
# first-connection MITM). Blast radius is bounded: the only payload is the
# read-only inventory script whose output is Zod-validated. Pinning the
# host fingerprint at source registration is a tracked follow-up (ADR-052).
if [ "${PLESK_AUTH_METHOD:-key}" = "password" ]; then
  : "${SSHPASS:?SSHPASS not set (password auth)}"
  SSH="sshpass -e ssh -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -p $PLESK_PORT"
else
  install -m 600 /etc/plesk-key/id_rsa /tmp/id_rsa
  SSH="ssh -i /tmp/id_rsa -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20 -p $PLESK_PORT"
fi
# Capture the remote output to a file FIRST so the ssh/remote exit code is not
# masked by the assembler pipe. A failed connection (wrong key/password,
# unreachable host) or the remote health-gate (`exit 3` on a non-Plesk box)
# must FAIL discovery VISIBLY, not yield a false empty-but-"completed"
# inventory. The remote's stderr (e.g. "Permission denied", the gate's FATAL)
# flows to the pod log → the discovery's logTail.
if ! $SSH "$PLESK_USER@$PLESK_HOST" 'bash -s' < /etc/plesk-scripts/remote-discover.sh > /tmp/discover.out; then
  echo "FATAL: discovery ssh/remote command failed — wrong credential, unreachable host, or not a Plesk box" >&2
  exit 1
fi
python3 /etc/plesk-scripts/assemble.py < /tmp/discover.out
