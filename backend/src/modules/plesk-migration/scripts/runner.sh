# Discovery Job runner (R1 PR 1). Writes the SSH key 0600, ssh's to the
# Plesk box running the read-only remote script, pipes to the assembler.
set -e
# /tmp is an ephemeral emptyDir, but clean the key explicitly per the
# repo /tmp-cleanup rule regardless of how the pod exits.
trap 'rm -f /tmp/id_rsa' EXIT
install -m 600 /etc/plesk-key/id_rsa /tmp/id_rsa
# accept-new trusts the host key on FIRST contact (no protection vs a
# first-connection MITM). Blast radius is bounded: SSH pubkey auth never
# reveals the private key to the host, and the only payload is the
# read-only inventory script whose output is Zod-validated. Pinning the
# host fingerprint at source registration is a tracked follow-up (ADR-052).
ssh -i /tmp/id_rsa \
    -o StrictHostKeyChecking=accept-new \
    -o BatchMode=yes \
    -o ConnectTimeout=20 \
    -p "$PLESK_PORT" "$PLESK_USER@$PLESK_HOST" 'bash -s' < /etc/plesk-scripts/remote-discover.sh \
  | python3 /etc/plesk-scripts/assemble.py
