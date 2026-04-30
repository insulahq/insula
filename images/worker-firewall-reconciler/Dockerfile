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

# debian:trixie-slim ships nftables 1.1.3, matching the version on the
# host (Debian 13 / Linux 6.12). bookworm's 1.0.6 and alpine 3.20's 1.0.9
# both segfault talking to a 6.12 kernel's netfilter through
# CAP_NET_ADMIN — even `nft list ruleset` core-dumps. This is a userspace
# library / kernel-netlink mismatch, not a binary issue. The container
# nft has to be ≥1.1 to negotiate the kernel's set/rule features.
FROM debian:trixie-slim

# nftables — talk to the host netfilter via netlink (CAP_NET_ADMIN).
# kubectl  — official static binary; we don't need an apt repo for one tool.
# bash/jq  — already in debian:trixie-slim.
ARG KUBECTL_VERSION=v1.30.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends nftables jq curl ca-certificates \
 && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      -o /usr/local/bin/kubectl \
 && curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256" \
      | awk '{print $1"  /usr/local/bin/kubectl"}' | sha256sum -c - \
 && chmod +x /usr/local/bin/kubectl \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY reconcile.sh /usr/local/bin/reconcile.sh
RUN chmod +x /usr/local/bin/reconcile.sh

# Reconcile loop runs as PID 1; SIGTERM in reconcile.sh exits cleanly.
ENTRYPOINT ["/usr/local/bin/reconcile.sh"]
