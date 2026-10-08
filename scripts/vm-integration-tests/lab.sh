#!/usr/bin/env bash
# scripts/vm-integration-tests/lab.sh — the retained local VM lab: local DEV, local
# staging and the services VM they share. Design: docs/development/LOCAL_VM_LAB.md.
#
#   lab.sh up svc            networks + the services VM (DNS, ACME CA, backup targets, apt cache)
#   lab.sh up dev            the local DEV cluster: create it, or start it if it exists
#   lab.sh up stg            the local staging cluster (production mode at LAB_STG_RELEASE_TAG)
#   lab.sh down dev|stg      stop it (VMs, OS and platform kept)
#   lab.sh down svc          stop the services VM (refused while a lab cluster runs)
#   lab.sh status            VMs, addresses, services, caches, host headroom
#   lab.sh ca-root           print the lab CA root certificate (import it once on your devices)
#
# Settings: lab.env (git-ignored; template lab.example.env), plus config.env for the
# shared driver settings. Override the paths with LAB_CONFIG / VMTEST_CONFIG.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034  # used by lib/lab-cluster.sh (bootstrap.sh, admin-password-reset.sh)
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=/dev/null
source "${VMTEST_CONFIG:-$HERE/config.env}"
LAB_CONFIG="${LAB_CONFIG:-$HERE/lab.env}"
[[ -r "$LAB_CONFIG" ]] || { echo "lab: ${LAB_CONFIG} not found — copy lab.example.env to it" >&2; exit 2; }
# shellcheck source=/dev/null
source "$LAB_CONFIG"
for _lib in os-registry driver waitfor log-gate join-invariance mirrors lab-net lab-state lab-svc lab-cluster lab-install; do
  # shellcheck source=/dev/null
  source "$HERE/lib/${_lib}.sh"
done

# Local scratch (cloud-init seeds, libvirt XML) in a private directory, removed on exit.
VMTEST_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/insula-lab.XXXXXX")"
export VMTEST_TMP_DIR
trap 'rm -rf "$VMTEST_TMP_DIR"' EXIT
[[ -f "$VMTEST_SSH_KEY" ]] || ssh-keygen -t ed25519 -N '' -f "$VMTEST_SSH_KEY" -q

usage() { sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

# lab_svc_check — prove each service answers on the services VM (not just "container up").
lab_svc_check() {
  local ip; ip="$(lab_svc_ip)"
  echo "── services on ${LAB_SVC_VM} (${ip}) ──"
  _vssh "$ip" "bash -s" <<CHECK
ok() { printf '  %-14s %s\n' "\$1" "\$2"; }
r=\$(getent hosts ca.${LAB_APEX} | awk '{print \$1}')
[ "\$r" = "${ip}" ] && ok dns "ca.${LAB_APEX} → \$r" || ok dns "FAIL (ca.${LAB_APEX} → '\$r')"
if curl -sf --cacert /var/lib/lab/step/certs/root_ca.crt https://ca.${LAB_APEX}/acme/acme/directory | jq -e .newOrder >/dev/null; then
  ok acme-ca "directory answers, TLS verifies against the lab root"
else ok acme-ca FAIL; fi
c=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9000/); [ "\$c" = 403 ] && ok s3 "answers (anonymous 403)" || ok s3 "FAIL (HTTP \$c)"
c=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3142/acng-report.html); [ "\$c" = 200 ] && ok apt-cache "answers" || ok apt-cache "FAIL (HTTP \$c)"
for n in sftp samba; do [ "\$(docker inspect -f '{{.State.Running}}' \$n 2>/dev/null)" = true ] && ok \$n running || ok \$n FAIL; done
CHECK
}

lab_status() {
  local d st
  echo "── lab VMs ──"
  while read -r d; do
    [[ -n "$d" ]] || continue
    st="$(VIRSH domstate "$d" 2>/dev/null || echo '?')"
    printf '  %-16s %s\n' "$d" "$st"
  done < <(VIRSH list --all --name 2>/dev/null | grep '^lab-' | sort)
  if [[ "$(VIRSH domstate "$LAB_SVC_VM" 2>/dev/null || true)" == running ]]; then lab_svc_check || true; fi
  echo "── registry mirrors (${VMTEST_REGISTRY_MIRROR:-none}) ──"
  if [[ -n "${VMTEST_REGISTRY_MIRROR:-}" ]]; then
    mirror_probe | sed 's/^/  /' || echo "  WARNING: lab nodes fall back to the upstream registries for the mirrors marked DOWN"
  fi
  echo "── host ──"
  on_host "free -m | awk '/^Mem:/{printf \"  memory available: %d MB\n\", \$7}'; \
           df -h '${VMTEST_DISK_DIR}' | awk 'NR==2{printf \"  VM disk space: %s free of %s\n\", \$4, \$2}'"
}

case "${1:-} ${2:-}" in
  "up svc")   ensure_fast_disk; ensure_ksm; lab_svc_ensure; lab_svc_check ;;
  "up dev")   ensure_fast_disk; ensure_ksm; lab_svc_ensure; lab_cluster_up dev ;;
  "up stg")   ensure_fast_disk; ensure_ksm; lab_svc_ensure; lab_cluster_up stg ;;
  "down dev") lab_cluster_down dev ;;
  "down stg") lab_cluster_down stg ;;
  "down svc")
    # Capture, then match: `virsh … | grep -q` races under pipefail.
    _running="$(VIRSH list --name 2>/dev/null || true)"
    if grep -q '^lab-\(dev\|stg\)-' <<<"$_running"; then
      echo "lab: a lab cluster is still running — it resolves names and orders certificates through ${LAB_SVC_VM}; stop it first" >&2
      exit 1
    fi
    VIRSH shutdown "$LAB_SVC_VM" >/dev/null && echo "${LAB_SVC_VM} shutting down" ;;
  "status "*) lab_status ;;
  "ca-root "*) lab_ca_root ;;
  *) usage ;;
esac
