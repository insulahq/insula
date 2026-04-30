# worker-firewall-reconciler — bash + nft + kubectl, runs on every node.
#
# Watches Pods on its own node and converges the host's nft sets
# tenant_ports_tcp / tenant_ports_udp (declared by scripts/bootstrap.sh)
# with the union of:
#   - spec.containers[*].ports[*].hostPort (matching protocol)
#   - metadata.annotations["platform.io/firewall-tcp-ports"] (CSV, ranges OK)
#   - metadata.annotations["platform.io/firewall-udp-ports"] (CSV, ranges OK)
#
# See k8s/base/worker-firewall-reconciler/ for the DaemonSet manifest.

# Debian, not Alpine: alpine's nftables 1.0.9 segfaults on every mutating
# op (`add element`, `add rule`, even `nft -f -`) when it tries to talk to
# the host netfilter through CAP_NET_ADMIN — verified on staging k8s 1.30
# nodes. Debian's nftables is built against glibc and works.
FROM debian:bookworm-slim

# nftables — talk to the host netfilter via netlink (CAP_NET_ADMIN).
# kubectl  — pulled from upstream apt repo; debian's stock package lags.
# bash/jq/coreutils — already in debian:bookworm-slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends nftables jq curl ca-certificates gnupg \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.30/deb/Release.key \
      | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
 && echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /' \
      > /etc/apt/sources.list.d/kubernetes.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends kubectl \
 && apt-get purge -y curl gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY reconcile.sh /usr/local/bin/reconcile.sh
RUN chmod +x /usr/local/bin/reconcile.sh

# Reconcile loop runs as PID 1; SIGTERM in reconcile.sh exits cleanly.
ENTRYPOINT ["/usr/local/bin/reconcile.sh"]
