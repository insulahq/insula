#!/usr/bin/env bash
# destroy-cluster.sh — DESTRUCTIVE: wipes K8s/Calico/Longhorn state on
# every node listed in $INVENTORY. Preserves NetBird identity (so
# wt0 IPs stay stable across the rebuild) and doesn't touch user
# data outside the cluster (no /etc/passwd, no /home).
#
# Use cases:
#   - Fresh re-bootstrap after debugging session drift
#   - Disaster recovery test (followed by bootstrap.sh on each node)
#
# Inventory format ($INVENTORY, default ~/k8s-staging/servers.txt):
#   <hostname> <public-ipv4> [<public-ipv6>]
# Lines without a public-ipv4 are skipped.
#
# Usage:
#   ./scripts/destroy-cluster.sh                # dry-run (prints what it would do)
#   ./scripts/destroy-cluster.sh --confirm      # actually wipe
#   INVENTORY=/path/to/file ./scripts/destroy-cluster.sh --confirm
set -uo pipefail

SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
INVENTORY="${INVENTORY:-$HOME/k8s-staging/servers.txt}"
CONFIRM=0
SSH_USER="${SSH_USER:-root}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm) CONFIRM=1; shift ;;
    --inventory) INVENTORY="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -25; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -r "$INVENTORY" ]]; then
  echo "inventory not readable: $INVENTORY" >&2
  exit 2
fi
if [[ ! -r "$SSH_KEY" ]]; then
  echo "ssh key not readable: $SSH_KEY" >&2
  exit 2
fi

# parse inventory: hostname <space> ipv4 (skip blank, comments, headers)
NODES=()
while IFS= read -r line; do
  line="${line%%#*}"
  [[ -z "${line// /}" ]] && continue
  read -r host ipv4 _rest <<< "$line"
  # accept only when ipv4 looks like an IPv4 address
  if [[ "$ipv4" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NODES+=("$host=$ipv4")
  fi
done < "$INVENTORY"

if [[ ${#NODES[@]} -eq 0 ]]; then
  echo "no nodes parsed from $INVENTORY" >&2
  exit 2
fi

echo "destroy-cluster.sh — target nodes:"
for n in "${NODES[@]}"; do
  printf '  %s\n' "$n"
done
echo "ssh key: $SSH_KEY"
echo "ssh user: $SSH_USER"
if [[ $CONFIRM -eq 0 ]]; then
  echo
  echo "DRY RUN — re-run with --confirm to actually wipe."
  exit 0
fi

# the wipe payload — runs on each node in parallel
read -r -d '' WIPE_SCRIPT <<'PAYLOAD' || true
set -uo pipefail
echo "[$(hostname)] starting wipe at $(date -u +%FT%TZ)"

# Capture pre-wipe NetBird state for sanity post-wipe
WTBEFORE=$(ip -4 -o addr show wt0 2>/dev/null | awk '{print $4}' | head -1)
echo "[$(hostname)] wt0 before: ${WTBEFORE:-none}"

# Uninstall k3s the proper way FIRST (server & agent variants). This
# stops the service, removes the /usr/local/bin/k3s binary, deletes the
# systemd unit, and runs k3s-killall.sh — a genuine clean slate.
#
# Why this matters (regression fixed 2026-05-31): the old code only
# `systemctl stop`ped k3s and rm-rf'd /var/lib/rancher, leaving the k3s
# binary + systemd unit behind. On the next bootstrap, bootstrap.sh's
# "k3s already installed → skip install" path then skipped straight to
# `kubectl apply` Calico WITHOUT the API server ever starting (the unit
# was stopped, data dir empty) → "dial tcp [::1]:8080: connect:
# connection refused" → bootstrap exit 1. Running the uninstaller forces
# bootstrap to do a real fresh install that actually starts k3s.
#
# The uninstaller flushes iptables/networking — NetBird's wt0 is
# re-established by the `systemctl restart netbird` at the end of this
# payload (its identity in /var/lib/netbird/ is never touched).
for u in /usr/local/bin/k3s-uninstall.sh /usr/local/bin/k3s-agent-uninstall.sh; do
  if [[ -x "$u" ]]; then
    echo "[$(hostname)] running $u"
    "$u" 2>&1 | tail -3 || true
  fi
done
# Fallback for nodes where the uninstaller is absent (partial install):
systemctl stop k3s 2>/dev/null || true
systemctl stop k3s-agent 2>/dev/null || true
sleep 2

# Tear down Calico tunnels + workload veths
ip link delete vxlan.calico 2>/dev/null || true
ip link delete tunl0 2>/dev/null || true
ip link delete wireguard.cali 2>/dev/null || true
for v in $(ip -br link show 2>/dev/null | awk '/^cali[0-9a-f]/ {print $1}' | cut -d@ -f1); do
  ip link delete "$v" 2>/dev/null || true
done

# Flush all iptables rules + nftables fallback + conntrack
iptables -F 2>/dev/null || true
iptables -t nat -F 2>/dev/null || true
iptables -t mangle -F 2>/dev/null || true
iptables -t raw -F 2>/dev/null || true
iptables -X 2>/dev/null || true
ip6tables -F 2>/dev/null || true
ip6tables -t nat -F 2>/dev/null || true
ip6tables -X 2>/dev/null || true
nft flush ruleset 2>/dev/null || true
conntrack -F 2>/dev/null || true

# Lazy-unmount any lingering kubelet pod mounts first, so the rm below
# doesn't hit "Device or resource busy" and silently leave PVC subpath
# data behind (observed: a "fresh" re-bootstrap came up on stale CNPG
# PGDATA → wrong/old database name → platform-api crash-loop).
for m in $(awk '$2 ~ "/var/lib/kubelet" {print $2}' /proc/mounts 2>/dev/null | sort -r); do
  umount -l "$m" 2>/dev/null || true
done

# ── Log out Longhorn's iSCSI sessions ────────────────────────────────
# MUST run after the unmounts above (a session whose block device still
# backs a mount refuses to log out) and before /var/lib/longhorn is
# removed.
#
# Nothing else does this. k3s-uninstall.sh knows nothing about Longhorn,
# and Longhorn's own logout lives in the CSI plugin's NodeUnstageVolume,
# which is never called when the whole cluster is torn down underneath
# it. The kernel sessions therefore SURVIVE the wipe — and survive the
# re-bootstrap too, because the host is not rebooted. Each orphan then
# retries login ~1/s forever against whatever now owns the old portal IP,
# which answers "target not found":
#
#   iscsid: connection281:0 login rejected: initiator error - target not found (02/03)
#   kernel:  connection281:0: detected conn error (1020)
#
# Measured on a VM that had been wiped and re-bootstrapped repeatedly:
# 44 sessions against 4 live volumes (41 orphans), ~3100 kernel messages
# per MINUTE on an idle cluster, 51 scsi_eh threads, iscsid at 17h
# cumulative CPU. It compounds with every wipe cycle. A cluster that is
# merely USED does not accumulate these — a 47-day node with real tenant
# churn showed 17 sessions for 17 volumes — so this is purely teardown
# hygiene, not a runtime leak.
#
# Scoped to Longhorn's IQN prefix on purpose: a node may legitimately
# have other iSCSI sessions (an external SAN holding operator data), and
# `iscsiadm -m session -u` with no filter would log those out too.
LH_IQN_PREFIX="iqn.2019-10.io.longhorn:"
if command -v iscsiadm >/dev/null 2>&1; then
  _lh_before=$(iscsiadm -m session 2>/dev/null | grep -cF "$LH_IQN_PREFIX")
  _lh_out=0
  # "tcp: [281] 10.42.0.5:3260,1 iqn.2019-10.io.longhorn:pvc-… (non-flash)"
  while IFS='|' read -r _sid _iqn; do
    [[ -z "$_sid" ]] && continue
    iscsiadm -m session -r "$_sid" -u >/dev/null 2>&1 && _lh_out=$((_lh_out + 1))
    # Drop any persisted node record so it cannot auto-login on next boot.
    iscsiadm -m node -T "$_iqn" -o delete >/dev/null 2>&1 || true
  done < <(iscsiadm -m session 2>/dev/null \
             | sed -nE "s#^[a-z]+: \[([0-9]+)\] [^ ]+ (${LH_IQN_PREFIX}[^ ]+).*#\1|\2#p")
  _lh_after=$(iscsiadm -m session 2>/dev/null | grep -cF "$LH_IQN_PREFIX")
  echo "[$(hostname)] longhorn iscsi sessions: ${_lh_before} before, ${_lh_out} logged out, ${_lh_after} remaining"
  if [[ "${_lh_after:-0}" -gt 0 ]]; then
    # Not fatal — the wipe must still finish — but say it plainly, because
    # the leftovers survive into the next install and only a reboot clears
    # a session whose device is still held.
    echo "[$(hostname)] WARNING: ${_lh_after} longhorn iscsi session(s) would NOT log out (device still held?) — reboot this node before re-bootstrapping"
  fi
else
  echo "[$(hostname)] iscsiadm not present — skipping longhorn iscsi logout"
fi

# Wipe K8s + Calico + Longhorn state directories
rm -rf /var/lib/rancher /etc/rancher
rm -rf /var/lib/calico /etc/cni /var/run/calico
rm -rf /var/lib/longhorn /opt/longhorn
rm -rf /var/lib/kubelet /etc/kubernetes
# Persisted volume data + the platform install dir. These were the gap
# behind a "fresh" re-bootstrap coming up on STALE data:
#   - /opt/local-path-provisioner (+ /opt/local-path,
#     /var/lib/rancher/k3s/storage): the default StorageClass backing
#     CNPG system-db (and any local-path PVC) on single-node. Left
#     behind, CNPG re-detects the existing PGDATA and SKIPS initdb,
#     resurrecting the prior database (e.g. a pre-rename DB name).
#   - /opt/insula (legacy /opt/k8s-hosting-platform): the platform
#     checkout bootstrap.sh deploys; a copy from an earlier git rev
#     otherwise survives the wipe.
rm -rf /opt/local-path-provisioner /opt/local-path /var/lib/rancher/k3s/storage
rm -rf /opt/insula /opt/k8s-hosting-platform

# kill any lingering containerd/k3s processes (defensive)
pkill -9 -f containerd-shim 2>/dev/null || true
pkill -9 -f k3s 2>/dev/null || true

# Confirm NetBird identity survived (its config lives in /var/lib/netbird/, untouched)
systemctl restart netbird 2>/dev/null || systemctl start netbird 2>/dev/null || true
sleep 5
WTAFTER=$(ip -4 -o addr show wt0 2>/dev/null | awk '{print $4}' | head -1)
echo "[$(hostname)] wt0 after: ${WTAFTER:-none}"
if [[ -z "$WTAFTER" ]]; then
  echo "[$(hostname)] WARN: wt0 missing post-wipe — NetBird needs manual recovery"
  exit 3
fi
if [[ "$WTBEFORE" != "$WTAFTER" ]]; then
  echo "[$(hostname)] WARN: wt0 IP changed ${WTBEFORE} → ${WTAFTER} (peers will re-converge)"
fi

echo "[$(hostname)] wipe complete at $(date -u +%FT%TZ)"
PAYLOAD

LOG_DIR="/tmp/destroy-cluster-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$LOG_DIR"
echo "logs: $LOG_DIR"
echo "wiping ${#NODES[@]} nodes in parallel..."
echo

PIDS=()
for nh in "${NODES[@]}"; do
  host="${nh%=*}"
  ip="${nh#*=}"
  (
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      "$SSH_USER@$ip" "bash -s" <<<"$WIPE_SCRIPT" \
      > "$LOG_DIR/${host}.log" 2>&1
    rc=$?
    echo "[$host] exit=$rc"
  ) &
  PIDS+=($!)
done

# Wait for all
fail=0
for p in "${PIDS[@]}"; do
  if ! wait "$p"; then fail=$((fail+1)); fi
done

echo
if [[ $fail -eq 0 ]]; then
  echo "all nodes wiped (logs in $LOG_DIR)"
  exit 0
else
  echo "$fail node(s) failed to wipe cleanly — inspect $LOG_DIR/*.log"
  exit 1
fi
