#!/usr/bin/env bash
# scripts/vm-integration-tests/start.sh — power a stopped run back ON.
#
# Counterpart of stop.sh: starts the run network, then the services VM (DNS,
# Pebble, MinIO, SFTP, Samba — their containers restart on their own), the
# servers, the workers and the runner, waits for SSH on each, and for every
# k3s node to report Ready. Prints the same coordinates run.sh prints, so a
# resumed run is driven exactly like a fresh one.
#
#   start.sh <run-id>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${VMTEST_CONFIG:-$HERE/config.env}"
# shellcheck source=lib/driver.sh
source "$HERE/lib/driver.sh"
# shellcheck source=lib/waitfor.sh
source "$HERE/lib/waitfor.sh"

RUN="${1:?usage: start.sh <run-id>}"
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
# Runs spawned since the services VM got a dnsmasq UNIT and a MinIO volume need
# nothing here; older ones started dnsmasq from a one-shot cloud-init command,
# so after a stop it is gone — and with it every lookup CoreDNS forwards (pods
# then cannot resolve anything, Traefik never passes its plugin-registry init).
ensure_services() {
  local svc="$1"
  _vssh "$svc" "systemctl is-active --quiet vmtest-dnsmasq 2>/dev/null || pgrep -x dnsmasq >/dev/null || \
    /usr/sbin/dnsmasq --listen-address=127.0.0.1,${svc} --bind-interfaces --no-resolv \
      --server=/${APEX}/127.0.0.1#5300 --server=${VMTEST_UPSTREAM_DNS:-1.1.1.1}" \
    || { echo "  could not start DNS on the services VM" >&2; return 1; }
  # MinIO (S3 backup target): recreate it if the container is gone. Needs the
  # run's saved credentials; without them, say so instead of guessing.
  if ! _vssh "$svc" "docker inspect minio >/dev/null 2>&1"; then
    if [[ -r "$STATE_FILE" ]]; then
      # shellcheck source=/dev/null
      if ( source "$STATE_FILE"
        _vssh "$svc" "mkdir -p /var/lib/minio && docker run -d --name minio --restart=always --network host \
          -v /var/lib/minio:/data -e MINIO_ROOT_USER=$(printf %q "$VMTEST_MINIO_USER") \
          -e MINIO_ROOT_PASSWORD=$(printf %q "$VMTEST_MINIO_PW") minio/minio:latest server /data --console-address :9001 >/dev/null \
          && for i in \$(seq 1 30); do docker run --rm --network host --entrypoint sh minio/mc:latest -c \
             'mc alias set l http://127.0.0.1:9000 $(printf %q "$VMTEST_MINIO_USER") $(printf %q "$VMTEST_MINIO_PW") && mc mb -p l/$(printf %q "$VMTEST_MINIO_BUCKET")' >/dev/null 2>&1 && break || sleep 2; done" ); then
        echo "  services VM: MinIO container recreated"
      else
        echo "  WARN: could not recreate MinIO on the services VM — S3 backup suites will fail" >&2
      fi
    else
      echo "  WARN: MinIO container missing and no saved state (${STATE_FILE}) — S3 backup suites will fail" >&2
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
if [[ -n "${IP[$S1]:-}" ]]; then
  wait_k3s_ready "${IP[$S1]}" 600 || { echo "k3s did not report every node Ready" >&2; exit 1; }
fi

echo "VMTEST_CP_IP=${IP[$S1]:-}"
echo "VMTEST_RUNNER_IP=${IP[vmt-${RUN}-runner]:-}"
echo "VMTEST_APEX=${APEX}"
echo "VMTEST_SSH_KEY=${VMTEST_SSH_KEY}"
echo "run ${RUN} started. Stop again with: $HERE/stop.sh ${RUN}"
