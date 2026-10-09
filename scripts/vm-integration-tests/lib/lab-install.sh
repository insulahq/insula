#!/usr/bin/env bash
# scripts/vm-integration-tests/lib/lab-install.sh — installing a lab cluster.
#
# The install a real operator does, on the lab's VMs: bootstrap.sh run verbatim —
# from THIS checkout for DEV, from a checkout of the cluster's RELEASE TAG for
# staging (production's version, so staging starts exactly where production is) —
# the first server creating the cluster, further servers joining it, then the
# lab-specific steps (lab CA for Stalwart, a known admin password, the services
# VM bound as DNS provider and backup target, staging's release-candidate opt-in).
#
# Requires the other lab libs and lib/{log-gate,join-invariance,mirrors}.sh. Uses the
# CL_* settings of lab_cluster_def.

# lab_release_checkout <tag> — a pristine copy of the release (git archive, so no
# worktree and no local edits), cached. Its bootstrap.sh copies its own lib/ and
# platform/ to the node in --remote mode, so the whole tree is needed.
lab_release_checkout() {
  local tag="$1" dir
  dir="${LAB_CACHE_DIR:-$HOME/.cache/insula-lab}/rel-${tag}"
  if [[ ! -f "$dir/scripts/bootstrap.sh" ]]; then
    git -C "$REPO" rev-parse -q --verify "refs/tags/${tag}" >/dev/null \
      || git -C "$REPO" fetch -q origin "refs/tags/${tag}:refs/tags/${tag}" \
      || { echo "lab: release tag ${tag} not found" >&2; return 1; }
    rm -rf "${dir}.tmp"; mkdir -p "${dir}.tmp"
    git -C "$REPO" archive "$tag" | tar x -C "${dir}.tmp" || { rm -rf "${dir}.tmp"; return 1; }
    mv "${dir}.tmp" "$dir"
  fi
  # The checkout must BE that release (a release install refuses a mismatched tree).
  [[ "$(tr -d '[:space:]' < "$dir/platform/VERSION")" == "${tag#v}" ]] \
    || { echo "lab: ${dir} is not ${tag} (platform/VERSION disagrees)" >&2; return 1; }
  printf '%s' "$dir"
}

# _lab_bootstrap_sh — the bootstrap.sh this cluster installs with.
_lab_bootstrap_sh() {
  if [[ -n "${CL_RELEASE_TAG:-}" ]]; then
    printf '%s/scripts/bootstrap.sh' "$(lab_release_checkout "$CL_RELEASE_TAG")"
  else
    printf '%s/scripts/bootstrap.sh' "$REPO"
  fi
}

# _lab_run_bootstrap <vm> <ip> <args…> — run bootstrap.sh against a node and judge the
# run by its exit code AND its transcript (lib/log-gate.sh).
_lab_run_bootstrap() {
  local vm="$1" ip="$2" rc=0 gate=0 bs extra=()
  shift 2
  bs="$(_lab_bootstrap_sh)" || return 1
  # shellcheck disable=SC2206
  [[ -n "${LAB_BOOTSTRAP_EXTRA_ARGS:-}" ]] && extra=(${LAB_BOOTSTRAP_EXTRA_ARGS})
  "$bs" --remote "$ip" --ssh-key "$VMTEST_SSH_KEY" "$@" ${extra[@]+"${extra[@]}"} || rc=$?
  log_gate_fetch_and_scan "$ip" "$vm" || gate=$?
  (( rc == 0 )) || { echo "lab: bootstrap of ${vm} exited ${rc}" >&2; return "$rc"; }
  (( gate != 1 )) || { echo "lab: ${vm} installed with output that indicates a script defect (above)" >&2; return 1; }
}

# _lab_bootstrap_create <vm> <ip> — CREATE the cluster on its first server: the lab CA as
# the ACME server (platform + Stalwart) and as an extra trusted root, the cluster's own
# subnet as the trusted network; staging pinned to its release.
_lab_bootstrap_create() {
  local vm="$1" ip="$2" release=()
  [[ -n "${CL_RELEASE_TAG:-}" ]] && release=(--release-tag "$CL_RELEASE_TAG")
  echo "── creating the ${CL_NAME} cluster on ${vm} @ ${ip}: --env ${CL_ENV}${CL_RELEASE_TAG:+ --release-tag ${CL_RELEASE_TAG}} ──" >&2
  _lab_run_bootstrap "$vm" "$ip" --domain "$CL_APEX" --env "$CL_ENV" ${release[@]+"${release[@]}"} \
    --acme-email "admin@${CL_APEX}" --acme-server "$(lab_acme_directory)" \
    --acme-ca /etc/insula-lab/ca.pem --trust-ca /etc/insula-lab/ca.pem \
    --stalwart-acme-directory "$(lab_acme_directory)" --cluster-network-cidr "${CL_PREFIX}.0/24"
}

# _lab_bootstrap_join <vm> <ip> <role> <first-server-ip> <token> — JOIN a node. Node-scoped
# flags only (bootstrap.sh refuses cluster-scoped ones on a join), and the join must leave
# the cluster as it found it (lib/join-invariance.sh).
_lab_bootstrap_join() {
  local vm="$1" ip="$2" role="$3" s1="$4" token="$5" before
  echo "── joining ${vm} @ ${ip} as ${role} ──" >&2
  before="$(join_snapshot "$s1")"
  _lab_run_bootstrap "$vm" "$ip" --join-as "$role" --server "$s1" --token "$token" \
    --cluster-network-cidr "${CL_PREFIX}.0/24" || return 1
  join_assert_unchanged "${role} join ${vm}" "$before" "$(join_snapshot "$s1")" || return 1
  join_node_hygiene "$ip" "$role" || return 1
}

# _lab_post_install <ip> — what bootstrap does not do for a private CA.
_lab_post_install() {
  local ip="$1" pw
  # Stalwart orders the mail certificate from the lab CA, which it trusts through the
  # stalwart-extra-ca Secret. bootstrap.sh --trust-ca seeds it before Stalwart starts; a
  # bootstrap that predates that leaves it out — then create it, restart Stalwart to
  # rebuild its trust store, and restart platform-api: only its start-up re-creates the
  # ACME provider the install's own Stalwart configure could not. (On a release whose
  # overlay lacks the stalwart-extra-ca-trust component the Secret waits, unmounted,
  # for the upgrade that brings it.)
  _vssh "$ip" "K='k3s kubectl'; \$K -n mail get secret stalwart-extra-ca >/dev/null 2>&1 && exit 0; \
      echo '  stalwart-extra-ca missing (older bootstrap) — adding it, restarting Stalwart and platform-api' >&2; \
      \$K -n mail create secret generic stalwart-extra-ca --from-file=trust-ca.crt=/etc/insula-lab/ca.pem && \
      \$K -n mail delete pod -l app=stalwart-mail >/dev/null && \
      \$K -n mail rollout status deploy/stalwart-mail --timeout=300s >/dev/null && \
      \$K -n platform delete pod -l app=platform-api >/dev/null && \
      \$K -n platform rollout status deploy/platform-api --timeout=300s >/dev/null" \
    || echo "  WARN: could not give Stalwart the lab CA — the mail certificate stays self-signed" >&2
  # A known admin password, kept in the lab state (0600) — never printed.
  pw="$(lab_state_secret "LAB_${CL_NAME^^}_ADMIN_PASSWORD" 24)"
  scp -q -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$REPO/scripts/admin-password-reset.sh" "root@${ip}:/tmp/admin-password-reset.sh"
  # Without --password the script reads it (twice) from stdin — kept off every command line.
  _vssh "$ip" "bash /tmp/admin-password-reset.sh --email $(printf %q "admin@${CL_APEX}") >/dev/null 2>&1; rc=\$?; rm -f /tmp/admin-password-reset.sh; exit \$rc" \
    <<<"$(printf '%s\n%s' "$pw" "$pw")" || echo "  WARN: admin password reset failed on ${ip}" >&2
}

# _lab_register <ip> — bind the services VM to the platform through its own API: the
# svc PowerDNS as the DNS provider group (so the platform's DNS write path runs against
# a real server) and the svc S3 as the backup target for every class. Same scripts the
# throw-away tier uses; run ON the node, which resolves lab names through the services
# VM and trusts the lab CA — the path the cluster itself uses.
_lab_register() {
  local ip="$1" svc pw s3_user s3_pw f
  svc="$(lab_svc_ip)"
  pw="$(lab_state_secret "LAB_${CL_NAME^^}_ADMIN_PASSWORD" 24)"
  s3_user="lab$(lab_state_secret LAB_S3_USER_SUFFIX 16)"; s3_pw="$(lab_state_secret LAB_S3_PW)"
  for f in setup-dns-provider.sh setup-backup-targets.sh; do
    scp -q -i "$VMTEST_SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "$HERE/$f" "root@${ip}:/tmp/$f"
  done
  # Credentials travel on stdin, not the command line (the remote ps would show them).
  _vssh "$ip" "set -a; . /dev/stdin; set +a; bash /tmp/setup-dns-provider.sh; bash /tmp/setup-backup-targets.sh; \
    rm -f /tmp/setup-dns-provider.sh /tmp/setup-backup-targets.sh" <<ENV
ADMIN_HOST=$(printf %q "https://admin.${CL_APEX}")
ADMIN_EMAIL=$(printf %q "admin@${CL_APEX}")
ADMIN_PASSWORD=$(printf %q "$pw")
VMTEST_APEX=$(printf %q "$CL_APEX")
VMTEST_DNS_IP=$(printf %q "$svc")
VMTEST_PDNS_API_KEY=$(printf %q "$(lab_state_secret LAB_PDNS_API_KEY)")
VMTEST_DNS_NS_HOSTNAMES=$(printf %q "ns1.${LAB_APEX}")
BACKUP_S3_ENDPOINT=$(printf %q "http://s3.${CL_APEX}:9000")
BACKUP_S3_BUCKET=$(printf %q "${CL_NAME}-backups")
BACKUP_S3_ACCESS_KEY=$(printf %q "$s3_user")
BACKUP_S3_SECRET_KEY=$(printf %q "$s3_pw")
ENV
}

# _lab_prerelease_optin <ip> — staging: release candidates show up as available updates
# (auto_update_include_prereleases), applied the way production applies a release —
# by an operator's upgrade, not automatically (autoUpdate stays off).
_lab_prerelease_optin() {
  local ip="$1" pw
  pw="$(lab_state_secret "LAB_${CL_NAME^^}_ADMIN_PASSWORD" 24)"
  _vssh "$ip" "bash -s" <<OPTIN || echo "  WARN: could not opt ${CL_NAME} into release candidates" >&2
set -e
A=https://admin.${CL_APEX}/api/v1
T=\$(curl -sf -X POST \$A/auth/login -H 'Content-Type: application/json' --data-binary @- <<'J' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
{"email":"admin@${CL_APEX}","password":"${pw}"}
J
)
[ -n "\$T" ]
curl -sf -X PUT \$A/admin/platform/update-settings -H "Authorization: Bearer \$T" -H 'Content-Type: application/json' \
  --data '{"autoUpdate":false,"includePrereleases":true}' >/dev/null
echo "  release candidates: opted in (applied by an operator's upgrade, not automatically)"
OPTIN
}

# _lab_wipe — remove a half-installed platform from every node, keep the OS: the same
# destroy-cluster.sh an operator runs before re-bootstrapping. It deletes /etc/rancher,
# so the registry mirrors are written back before k3s is installed again.
_lab_wipe() {
  local inv="${VMTEST_TMP_DIR}/inventory-${CL_NAME}.txt" entry vm host
  : > "$inv"
  for entry in "${CL_NODES[@]}"; do read -r vm host <<<"$entry"; echo "${vm} ${CL_PREFIX}.${host}" >> "$inv"; done
  "$REPO/scripts/destroy-cluster.sh" --inventory "$inv" --ssh-key "$VMTEST_SSH_KEY" --confirm >&2 \
    || { echo "lab: could not wipe the ${CL_NAME} nodes" >&2; return 1; }
  if [[ -n "${VMTEST_REGISTRY_MIRROR:-}" ]]; then
    for entry in "${CL_NODES[@]}"; do
      read -r vm host <<<"$entry"
      registry_mirrors_yaml | _vssh "${CL_PREFIX}.${host}" "mkdir -p /etc/rancher/k3s && cat > /etc/rancher/k3s/registries.yaml" \
        || { echo "lab: could not restore the registry mirrors on ${vm}" >&2; return 1; }
    done
  fi
}

# lab_install_cluster — the whole install on the cluster's (running, reachable) VMs.
lab_install_cluster() {
  local entry vm host ip s1vm s1 token
  read -r s1vm host <<<"${CL_NODES[0]}"; s1="${CL_PREFIX}.${host}"
  _lab_bootstrap_create "$s1vm" "$s1" || return 1
  wait_k3s_ready "$s1" 600 >&2 || return 1
  if (( ${#CL_NODES[@]} > 1 )); then
    token="$(_vssh "$s1" "cat /var/lib/rancher/k3s/server/node-token")" || return 1
    for entry in "${CL_NODES[@]:1}"; do
      read -r vm host <<<"$entry"; ip="${CL_PREFIX}.${host}"
      _lab_bootstrap_join "$vm" "$ip" server "$s1" "$token" || return 1
    done
    wait_k3s_ready "$s1" 600 >&2 || return 1
  fi
  _lab_post_install "$s1"
  lab_state_set "LAB_${CL_NAME^^}_INSTALLED" 1
  _lab_register "$s1"
  [[ "$CL_ENV" != production ]] || _lab_prerelease_optin "$s1"
}
