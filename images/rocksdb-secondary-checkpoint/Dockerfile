# Multi-stage build for rocksdb-secondary-checkpoint.
#
# librocksdb-sys 0.17.3 statically links librocksdb 10.4.2 + snappy + zlib +
# lz4 + zstd + bz2. The Rust binary still dynamic-links libc, libm,
# libpthread, libdl, libgcc_s, and libstdc++ (the C++ runtime that
# librocksdb's C++ core depends on).
#
# Why distroless/cc-debian12 for runtime:
#   It provides exactly those shared libs and nothing else (~22 MB vs the
#   ~85 MB of debian:trixie-slim). No shell, no apt, no package manager —
#   matches our "smallest feasible image" objective without going to
#   musl-static (which has known RocksDB-on-musl edge cases around atomic
#   intrinsics and we don't want to debug those).
#
# Why bookworm in the build stage:
#   glibc symbol versions matter — a binary built on trixie (glibc 2.41)
#   may require symbols that bookworm-based distroless (glibc 2.36) lacks
#   at runtime. Building on bookworm produces a binary that runs on
#   distroless/cc-debian12.

# ── build stage ────────────────────────────────────────────────────────
# rust:1.95-bookworm is the current stable Rust toolchain (released
# 2026-05-09) on Debian 12 (glibc 2.36). librocksdb-sys 0.17.3+10.4.2
# requires Rust ≥ 1.85; 1.95 satisfies that.
FROM rust:1.95-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS build

# librocksdb-sys compile-time deps. snappy/zlib/lz4/zstd/bz2 are linked in
# statically by the librocksdb-sys build script; we install the -dev headers.
# Apply base-image security updates before installing.
#
# The base is pinned by digest, so its packages are frozen at whatever the
# published image shipped -- and Debian rebuilds that image far less often
# than it publishes security fixes. Bumping the digest does NOT help: the
# pin here already IS the current trixie-slim, and it still carries
# util-linux 2.41-5 while Debian-Security has 2.41.5-0+deb13u1 (the mount
# TOCTOU / SUID nosuid-bypass set, CVE-2026-53612..53615).
#
# Without this line the image ships those CVEs forever. It only surfaced
# because this image is rebuilt rarely: Trivy gates CRITICAL/HIGH with
# ignore-unfixed, so the gate stayed silent on development and fired on the
# first PR that forced a full rebuild.
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends \
      clang \
      libclang-dev \
      cmake \
      g++ \
      make \
      pkg-config \
      libsnappy-dev \
      liblz4-dev \
      libzstd-dev \
      libbz2-dev \
      zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
# NO GLOB on Cargo.lock. It used to read `Cargo.lock*`, and since no lockfile was
# committed the glob matched NOTHING — silently. Every build then re-resolved the
# whole dependency graph against the live crates.io index, so the crates that went
# into a binary which opens the production mail database were whatever existed at
# build time, not what anyone reviewed. A bare `Cargo.lock` makes a missing
# lockfile a hard COPY failure instead of a silent re-resolve.
COPY Cargo.toml Cargo.lock ./
COPY src ./src

# --locked on BOTH: fetch and build must use Cargo.lock exactly as committed and
# fail if it is stale or absent, rather than quietly updating it (which is what
# plain `cargo build` does when Cargo.toml and Cargo.lock disagree). This is the
# Rust equivalent of `npm ci` over `npm install`.
RUN cargo fetch --locked
RUN cargo build --release --locked \
 && strip target/release/rocksdb-secondary-checkpoint

# ── runtime stage ──────────────────────────────────────────────────────
# distroless/cc-debian12 ≈ 22 MB and ships libc, libstdc++, libgcc_s,
# libm, libpthread, libdl — exactly what librocksdb-sys needs and
# nothing else. No shell, no package manager, no shell-injection
# surface; the binary is the only entrypoint.
FROM gcr.io/distroless/cc-debian12@sha256:e8e7ee4b8b106d4c5fde9e422a321b2b8a2d5cca546c97adcce927f3e1d36e36 AS runtime

COPY --from=build /build/target/release/rocksdb-secondary-checkpoint \
                  /usr/local/bin/rocksdb-secondary-checkpoint

ENTRYPOINT ["/usr/local/bin/rocksdb-secondary-checkpoint"]
