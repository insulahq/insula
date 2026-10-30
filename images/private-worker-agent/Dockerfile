# syntax=docker/dockerfile:1.7
#
# private-worker-agent
# --------------------
# Single-container home-side agent for the platform "private worker" feature.
# Decodes a base64url JSON token from $PRIVATE_WORKER_TOKEN, renders an
# frpc.toml, and execs frpc to dial a per-client tunnel into the cluster
# over outbound HTTPS/WSS. No persistent volumes; restart-safe.
#
# Pinned to frp v0.71.1 with verified SHA-256 sums from the upstream
# checksums file:
#   https://github.com/fatedier/frp/releases/download/v0.71.1/frp_sha256_checksums.txt
# Bump FRP_VERSION + matching SHA-256s together when upgrading.

FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS frpc-fetch

ARG TARGETARCH
ARG FRP_VERSION=0.71.1
ARG FRP_SHA256_AMD64=1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803
ARG FRP_SHA256_ARM64=8edf590b0c396fa42f9c147121a76af83cfc2002b08f5aef0ea1008c43482019

RUN apk add --no-cache ca-certificates curl tar coreutils

# Resolve the per-arch tarball + expected sha256, download, verify, extract.
# Fail fast if TARGETARCH is unsupported.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) FRP_ARCH=amd64; FRP_SHA256="${FRP_SHA256_AMD64}";; \
      arm64) FRP_ARCH=arm64; FRP_SHA256="${FRP_SHA256_ARM64}";; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1;; \
    esac; \
    TARBALL="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"; \
    URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${TARBALL}"; \
    echo "Downloading ${URL}"; \
    curl -fsSL --retry 3 --retry-delay 2 -o "/tmp/${TARBALL}" "${URL}"; \
    echo "${FRP_SHA256}  /tmp/${TARBALL}" | sha256sum -c -; \
    mkdir -p /tmp/frp; \
    tar -xzf "/tmp/${TARBALL}" -C /tmp/frp --strip-components=1; \
    install -m 0755 /tmp/frp/frpc /usr/local/bin/frpc; \
    /usr/local/bin/frpc --version

# ---------------------------------------------------------------------------
# Runtime image
# ---------------------------------------------------------------------------
FROM alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a

# bash         - entrypoint shell (uses set -euo pipefail, arrays)
# coreutils    - GNU base64 (Alpine's busybox base64 lacks reliable padding handling)
# ca-certificates - validate platform TLS cert
# tini         - PID 1 / signal forwarding so SIGTERM reaches frpc cleanly
# jq           - safe JSON parsing (no shell-eval of token blob)
# curl         - optional, useful for in-container debugging (small)
# Package fixes published after the base image was built (an image is only
# rebuilt when its sources change): take them at build time.
RUN apk upgrade --no-cache \
 && apk add --no-cache \
      bash \
      coreutils \
      ca-certificates \
      tini \
      jq \
      curl \
 && addgroup -S -g 1000 pwagent \
 && adduser -S -u 1000 -G pwagent -h /home/pwagent -s /bin/bash pwagent

COPY --from=frpc-fetch /usr/local/bin/frpc /usr/local/bin/frpc
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/frpc /usr/local/bin/entrypoint.sh

# Writable tmpfs for rendered frpc.toml. /tmp is world-writable in alpine.
USER pwagent
WORKDIR /home/pwagent

# frpc has no `status` subcommand against a config file; the admin port
# is bound to 127.0.0.1:7400 by entrypoint.sh. A TCP probe on that port
# is a sufficient liveness signal: if frpc has crashed, the listener is gone.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD nc -z 127.0.0.1 7400 || exit 1

LABEL org.opencontainers.image.source="https://github.com/insulahq/insula" \
      org.opencontainers.image.title="private-worker-agent" \
      org.opencontainers.image.description="Home agent that dials a private worker tunnel into the platform" \
      org.opencontainers.image.licenses="Apache-2.0"

ENTRYPOINT ["/sbin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
