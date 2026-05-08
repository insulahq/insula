# peer-firewall-reconciler — always-on set-mode firewall converger.
# Watches Nodes, ClusterTrustedRange, ClusterPendingPeer CRs and
# converges four nft sets on the host: cluster_peers_v{4,6} (peers
# union with non-expired CPP IPs), trusted_ranges_v{4,6} (CTR CIDRs).
#
# Runs hostNetwork: true so the in-container nft binary shares the host
# netfilter ruleset; needs only CAP_NET_ADMIN, no privileged escalation.

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
# Build the entire package (multiple .go files now). Test files are
# excluded automatically by `go build`; -trimpath strips the local
# build path; -s -w strips debug symbols.
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/reconciler ./...

FROM debian:trixie-slim
# Debian 13 trixie matches the host distribution exactly (Tier-1
# supported OS), so the in-container nft binary uses the same
# libnftnl + libmnl as the host nft that wrote the ruleset. Alpine
# 3.20 (nft 1.0.9) and 3.21 (nft 1.1.1) both segfaulted on
# `nft list set` against a host-written 1.1.3 ruleset on staging1
# 2026-05-08 — the netlink dump format had set-element shapes the
# older parsers dereferenced as garbage. trixie-slim ships nft
# 1.1.3 (matches host); image is ~30 MB larger than alpine but
# avoids the version-skew failure mode.
#
# Other supported distros on the host side:
#   Debian 12 bookworm  → nft 1.0.6 (older client/host than
#                          container — backward-compatible)
#   Ubuntu 22.04 jammy   → nft 1.0.2
#   Ubuntu 24.04 noble   → nft 1.0.9
#   RHEL 9 family        → nft 1.0.4
#   Amazon Linux 2023    → nft 1.0.4
# A newer container nft reading older host rulesets is safe; the
# reverse (older container → newer host) is what segfaulted.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nftables ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/reconciler /usr/local/bin/peer-firewall-reconciler
# Runs as root inside the container so nft inherits CAP_NET_ADMIN
# without ambient-cap configuration. The DaemonSet drops all caps
# except NET_ADMIN, so the actual blast radius is identical to a
# non-root + ambient-cap setup.
ENTRYPOINT ["/usr/local/bin/peer-firewall-reconciler"]
