# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS builder

WORKDIR /app

# Build shared API contracts first.
# --build --force prevents stale tsbuildinfo from a Docker layer cache
# from producing zero output when src changed but the buildinfo wasn't
# invalidated (see feedback_api_contracts_build_force).
COPY packages/api-contracts/ ./packages/api-contracts/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd packages/api-contracts && npm install --ignore-scripts --prefer-offline --no-audit --no-fund && npx tsc --build --force

# Build backend
COPY backend/package.json backend/tsconfig.json ./
RUN sed -i 's|"@k8s-hosting/api-contracts": "\*"|"@k8s-hosting/api-contracts": "file:./packages/api-contracts"|' package.json
# Fix tsconfig reference path for Docker flat layout
RUN sed -i 's|\.\./packages/api-contracts|./packages/api-contracts|' tsconfig.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --ignore-scripts --prefer-offline --no-audit --no-fund --legacy-peer-deps
COPY backend/src/ src/
RUN npx tsc

FROM node:22-alpine

# openssl is used by the mtls-providers module to generate self-signed
# CAs and sign user certs (cert-ops.ts). Alpine's node image doesn't
# include it by default. Pin nothing — track the alpine track so we
# get security fixes.
#
# age is used by modules/system-backup for the secrets-bundle export
# pipeline (tar + age -r <recipient>). Matches the on-host bundle
# format created by scripts/bootstrap.sh and decoded by `make
# secrets-restore`. age is a tiny static Go binary shipped in the
# alpine community repo.
# pg_dump must be >= the highest CNPG server version we dump FROM
# (newer clients can dump from older servers; older clients refuse
# newer servers with 'aborting because of server version mismatch').
# As of 2026-05-07 both CNPG clusters (platform postgres-18, mail
# mail-pg-18) run cnpg postgresql:18.3-minimal-trixie → pin to v18.
#
# Bump procedure for the next major: bump CNPG cluster imageName
# first so all servers reach the new floor, then bump this pin.
# Same shape as 16→17→18 over April-May 2026.
# restic is used by modules/tenant-bundles (ADR-036, Phase 1+) — spawned
# as a subprocess from restic-driver.ts to write per-tenant restic repos
# to S3/SFTP. The wire stream from a tenant capture Job to
# /api/v1/internal/bundles/.../restic-stream is piped straight into
# `restic backup --stdin` running on this platform-api pod. Hard
# dependency for any incremental tenant bundle.
#
# openssh-client is required because restic's `sftp:` backend invokes
# `ssh` (not its own SFTP client) to reach the storage box. Without
# this, SFTP-target backups fail with "exec: ssh: executable not
# found in $PATH". S3-target backups don't need it. Caught from
# staging 2026-05-10.
RUN apk add --no-cache openssl age postgresql18-client restic openssh-client

WORKDIR /app

COPY --from=builder /app/packages/api-contracts/ ./packages/api-contracts/
COPY backend/package.json ./
RUN sed -i 's|"@k8s-hosting/api-contracts": "\*"|"@k8s-hosting/api-contracts": "file:./packages/api-contracts"|' package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund --legacy-peer-deps

COPY --from=builder /app/dist/ dist/
COPY backend/src/db/migrations/ dist/db/migrations/
COPY backend/docker-entrypoint.sh ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost:3000/api/v1/healthz || exit 1

ENTRYPOINT ["sh", "docker-entrypoint.sh"]
