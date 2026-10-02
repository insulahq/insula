#!/usr/bin/env bash
# scripts/vm-integration-tests/start.sh — power a stopped run back ON.
#
# Counterpart of stop.sh: starts the run network, then the services VM (DNS,
# Pebble, S3, SFTP, Samba — their containers restart on their own), the
# servers, the workers and the runner, waits for SSH on each, and for every
# k3s node to report Ready. Prints the same coordinates run.sh prints, so a
# resumed run is driven exactly like a fresh one.
#
#   start.sh <run-id>                   wait for every k3s node Ready
#   start.sh <run-id> --no-k3s-wait     VMs + services only (rebootstrap.sh: the
#                                       platform is about to be wiped, and after a
#                                       failed install there may be no k3s at all)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${VMTEST_CONFIG:-$HERE/config.env}"
# shellcheck source=lib/driver.sh
source "$HERE/lib/driver.sh"
# shellcheck source=lib/waitfor.sh
source "$HERE/lib/waitfor.sh"

RUN="${1:?usage: start.sh <run-id> [--no-k3s-wait]}"
WAIT_K3S=1
[[ "${2:-}" == "--no-k3s-wait" ]] && WAIT_K3S=0
NET="insula-test-${RUN}"

mapfile -t ALL < <(VIRSH list --all --name 2>/dev/null | grep "^vmt-${RUN}-" | sort)
(( ${#ALL[@]} > 0 )) || { echo "no VMs for run ${RUN} (torn down? spawn a new run)" >&2; exit 1; }

# Capture, then match: `virsh … | grep -q` under pipefail races (grep exits on the
# first match, virsh takes SIGPIPE, the pipeline reports failure).
net_info="$(VIRSH net-info "$NET" 2>/dev/null || true)"
if ! [[ "$net_info" =~ Active:[[:space:]]+yes ]]; then
  VIRSH net-start "$NET" >/dev/null || { echo "could not start network ${NET}" >&2; exit 1; }
  echo "  network ${NET} started"
fi

ordered=()
for d in "${ALL[@]}"; do [[ "$d" == *-svc ]] && ordered+=("$d"); done
for d in $(printf '%s\n' "${ALL[@]}" | grep -E -- '-s[0-9]+$' | sort); do ordered+=("$d"); done
for d in "${ALL[@]}"; do [[ "$d" == *-w[0-9]* ]] && ordered+=("$d"); done
for d in "${ALL[@]}"; do [[ "$d" == *-runner ]] && ordered+=("$d"); done

# shellcheck disable=SC2059 # the template IS the format (config.env), as in run.sh
APEX="$(printf "$VMTEST_APEX_TMPL" "$RUN")"
STATE_FILE="${VMTEST_STATE_DIR:-$HOME/.cache/insula-vmtest}/run-${RUN}.env"

# ensure_services <svc-ip> — what a reboot of the services VM must bring back.
# Runs spawned since the services VM got a dnsmasq UNIT and the versitygw S3 target need
# nothing here; older ones started dnsmasq from a one-shot cloud-init command,
# so after a stop it is gone — and with it every lookup CoreDNS forwards (pods
# then cannot resolve anything, Traefik never passes its plugin-registry init).
ensure_services() {
  local svc="$1"
  _vssh "$svc" "systemctl is-active --quiet vmtest-dnsmasq 2>/dev/null || pgrep -x dnsmasq >/dev/null || \
    /usr/sbin/dnsmasq --listen-address=127.0.0.1,${svc} --bind-interfaces --no-resolv \
      --server=/${APEX}/127.0.0.1#5300 --server=${VMTEST_UPSTREAM_DNS:-1.1.1.1}" \
    || { echo "  could not start DNS on the services VM" >&2; return 1; }
  # S3 backup target (versitygw; MinIO on runs before it was replaced — its
  # images no longer pull, so a missing MinIO is replaced, not recreated).
  # Needs the run's saved credentials; without them, say so instead of guessing.
  if ! _vssh "$svc" "docker inspect s3 >/dev/null 2>&1 || docker inspect minio >/dev/null 2>&1"; then
    if [[ -r "$STATE_FILE" ]]; then
      # shellcheck source=/dev/null
      if ( source "$STATE_FILE"
        _vssh "$svc" "mkdir -p /var/lib/s3 && docker run -d --name s3 --restart=always --network host \
          -v /var/lib/s3:/data -e ROOT_ACCESS_KEY_ID=$(printf %q "$VMTEST_MINIO_USER") \
          -e ROOT_SECRET_ACCESS_KEY=$(printf %q "$VMTEST_MINIO_PW") versity/versitygw:v1.8.0 --port :9000 posix /data >/dev/null \
          && for i in \$(seq 1 30); do docker run --rm --network host rclone/rclone:1.74.1 mkdir :s3:$(printf %q "$VMTEST_MINIO_BUCKET") \
             --s3-provider Other --s3-endpoint http://127.0.0.1:9000 --s3-access-key-id $(printf %q "$VMTEST_MINIO_USER") \
             --s3-secret-access-key $(printf %q "$VMTEST_MINIO_PW") >/dev/null 2>&1 && break || sleep 2; done" ); then
        echo "  services VM: S3 backup target (versitygw) started"
      else
        echo "  WARN: could not start the S3 backup target on the services VM — S3 backup suites will fail" >&2
      fi
    else
      echo "  WARN: S3 backup target missing and no saved state (${STATE_FILE}) — S3 backup suites will fail" >&2
    fi
  fi
}

echo "== start run ${RUN}: ${ordered[*]}"
declare -A IP
for d in "${ordered[@]}"; do
  [[ "$(VIRSH domstate "$d" 2>/dev/null)" == running ]] || VIRSH start "$d" >/dev/null
  ip=""
  for _ in $(seq 1 75); do ip=$(vm_ip "$d" "$RUN"); [[ -n "$ip" ]] && break; sleep 4; done
  [[ -n "$ip" ]] || { echo "no lease for $d after 5 min" >&2; exit 1; }
  IP[$d]="$ip"
  wait_ssh "$ip" 300 || exit 1
  # The services VM answers DNS for every node — have it serving before they boot.
  if [[ "$d" == *-svc ]]; then ensure_services "$ip" || exit 1; fi
done

S1="vmt-${RUN}-s1"
if [[ "$WAIT_K3S" == "1" && -n "${IP[$S1]:-}" ]]; then
  wait_k3s_ready "${IP[$S1]}" 600 || { echo "k3s did not report every node Ready" >&2; exit 1; }
fi

echo "VMTEST_CP_IP=${IP[$S1]:-}"
echo "VMTEST_RUNNER_IP=${IP[vmt-${RUN}-runner]:-}"
echo "VMTEST_APEX=${APEX}"
echo "VMTEST_SSH_KEY=${VMTEST_SSH_KEY}"
echo "run ${RUN} started. Stop again with: $HERE/stop.sh ${RUN}"
