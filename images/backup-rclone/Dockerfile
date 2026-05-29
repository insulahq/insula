# backup-rclone — universal backup mediator image.
#
# R-X19 (2026-05-21): rclone serve s3 unified architecture.
# Single binary handles all four upstream types (S3, SFTP, CIFS,
# Local-PVC) via rclone's native userspace clients — no FUSE,
# no kernel mounts, no CAP_SYS_ADMIN. The image previously
# carried versitygw + sshfs + cifs-utils + nfs-utils + fuse3
# for the R-X17 versitygw + kernel-mount architecture; those
# are no longer needed and have been removed (~80 MiB shrink).
#
# Used in two roles in the platform:
#
#  (1) backup-rclone-shim DaemonSet — runs `rclone serve s3` on every
#      node, fronting all backup callers (postgres barman-cloud, k3s
#      etcd snapshot CronJob, restic CronJobs, rclone-push jobs).
#      Per-class buckets translate via rclone's native backend
#      adapters (no kernel mount layer).
#
#  (2) one-shot CronJob clients (etcd-snap-via-shim, restic wrappers,
#      tenant-bundle uploader, secrets-bundle uploader) — invoked as
#      `rclone copy` / `rclone sync` from inline command, talking S3
#      to the shim's ClusterIP.
#
# DESIGN GOALS:
#   - Small (~20 MiB compressed) — alpine base + static rclone +
#     zstd + minimal runtime libs
#   - Pinned by digest in Flux; rclone version controlled here
#   - tini as PID 1 for proper signal handling
#   - No shell in the running image where avoidable; busybox sh kept
#     for one-shot CronJobs that need to wire `pgrep` / `find` etc.
#   - Non-root by default (uid 65534 / nobody) — pod runs fully
#     unprivileged in R-X19 (no longer requires CAP_SYS_ADMIN)
#   - Works on amd64 + arm64 (multi-arch GitHub Actions build)
#
# RCLONE VERSION:
#   1.74.1 — pinned. SHA256 verified against the official release
#   manifest. Bump requires re-running scripts/rclone-shim-eval/ to
#   confirm performance + stability profile is unchanged.

# ---- stage 1: download + verify rclone binary ------------------------
# alpine digest pinned (mutable :3.20 tag would let a re-tag inject a
# different base layer; the digest is the trust anchor).
FROM --platform=$BUILDPLATFORM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS rclone-fetch

ARG TARGETARCH
ARG RCLONE_RELEASE=1.74.1

# Real checksums from https://downloads.rclone.org/v1.74.1/SHA256SUMS
# DO NOT EDIT without re-pinning to the actual SHA from the upstream
# SHA256SUMS file. ENFORCED at build time; an unexpected binary aborts
# the build.
ARG RCLONE_SHA256_AMD64=67df3059a6233b6e32e604bcd637654bb294ff86291b65ede77123e94818d911
ARG RCLONE_SHA256_ARM64=c816ed0e568de4dd1bba1a4d0cd47523d3dd54337dd5fde73f1b068857ecf877

RUN apk add --no-cache curl unzip ca-certificates

WORKDIR /work
RUN set -eux; \
    # TARGETARCH is injected by `docker buildx` for multi-arch builds.
    # For plain `docker build` (local smoke), fall back to `uname -m`.
    ARCH="${TARGETARCH:-}"; \
    if [ -z "$ARCH" ]; then \
      case "$(uname -m)" in \
        x86_64) ARCH=amd64 ;; \
        aarch64|arm64) ARCH=arm64 ;; \
        *) echo "unsupported uname -m: $(uname -m)"; exit 1 ;; \
      esac; \
    fi; \
    case "$ARCH" in \
      amd64) EXPECTED_SHA="$RCLONE_SHA256_AMD64" ;; \
      arm64) EXPECTED_SHA="$RCLONE_SHA256_ARM64" ;; \
      *) echo "unsupported arch: $ARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o rclone.zip \
        "https://downloads.rclone.org/v${RCLONE_RELEASE}/rclone-v${RCLONE_RELEASE}-linux-${ARCH}.zip"; \
    # ENFORCE checksum — abort if the upstream CDN was compromised or
    # BGP-hijacked. Flux's digest pin downstream protects the OUTPUT
    # image but not the binary fetched DURING build.
    echo "${EXPECTED_SHA}  rclone.zip" | sha256sum -c -; \
    unzip -q rclone.zip; \
    mv rclone-v${RCLONE_RELEASE}-linux-${ARCH}/rclone /usr/local/bin/rclone; \
    chmod +x /usr/local/bin/rclone; \
    /usr/local/bin/rclone version

# ---- stage 2: runtime image ------------------------------------------
# alpine pinned by digest (same trust-anchor argument as stage 1).
FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc

# Install runtime essentials. R-X19 dropped kernel-mount helpers
# (sshfs, cifs-utils, nfs-utils, fuse3) and versitygw — all backend
# protocols now go through rclone's native userspace clients.
#
#   - tini: PID-1 signal handling
#   - ca-certificates: TLS to S3/HTTPS endpoints
#   - zstd: compression for etcd snapshots + tenant-bundle artefacts
#   - openssh-client: rclone's sftp backend uses ssh known_hosts /
#                     ssh-agent integration for some setups
#   - tzdata: log timestamps in local time when configured
#   - procps: pgrep for liveness probe in the shim role
RUN apk add --no-cache \
        tini \
        ca-certificates \
        zstd \
        openssh-client \
        tzdata \
        procps \
    && update-ca-certificates

# Bring the verified rclone binary across from the fetch stage.
COPY --from=rclone-fetch /usr/local/bin/rclone /usr/local/bin/rclone

# Runtime directory layout (R-X19):
#   /etc/rclone-credentials/upstream.env  — operator-configured params
#                                            (Secret, mounted by DS)
#   /etc/rclone/ssh-keys/upstream.pem     — SFTP key (Secret, when used)
#   /var/cache/rclone-shim/                — rclone --vfs-cache-mode cache
#                                            (emptyDir, 1.5 GiB cap)
#   /var/run/backup-rclone/                — tmpfs scratch (rclone
#                                            --temp-dir for CronJob role)
RUN mkdir -p /etc/rclone/ssh-keys /var/cache/rclone-shim /var/run/backup-rclone \
    && chown -R 65534:65534 /etc/rclone /var/cache/rclone-shim /var/run/backup-rclone

# Default USER is non-root. The shim DaemonSet runs fully unprivileged
# in R-X19: runAsUser=65534, drop ALL caps, readOnlyRootFilesystem=true.
USER 65534:65534

# tini handles SIGTERM → SIGTERM-to-children, no zombie reaping issues.
# The default ENTRYPOINT is tini; clients (CronJob commands) pass full
# `rclone …` invocations.
ENTRYPOINT ["/sbin/tini", "--"]

# Default to printing rclone version. The shim DaemonSet overrides with:
#   command: ["/bin/sh", "/etc/rclone-static/launcher.sh"]
# CronJob clients (etcd-snap, age-bundle uploader, etc.) override with:
#   command: ["rclone", "copy", ...]
CMD ["/usr/local/bin/rclone", "version"]

# Image metadata for runtime inspection + Flux reconciliation.
LABEL org.opencontainers.image.title="backup-rclone"
LABEL org.opencontainers.image.description="R-X19 backup mediator (rclone serve s3 + rclone client; no kernel mounts)"
LABEL org.opencontainers.image.source="https://github.com/insulahq/insula"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="Insula"
LABEL platform.example.test/role="backup-rclone-shim"
LABEL platform.example.test/rclone-version="1.74.1"
