# syntax=docker/dockerfile:1.7

# ─── deps: install from the LOCKFILE, in the real workspace layout ──────────
#
# WHY THIS STAGE EXISTS (2026-08-06)
#   This image used to run `npm install` against backend/package.json with NO
#   lockfile in the build context. That meant every build RE-RESOLVED the `^`
#   ranges against the live registry, so package-lock.json — the file we audit,
#   scan and cross-reference against IOC lists — did not govern what shipped.
#   A version published between two builds landed in the image even when the
#   lockfile pinned a safe one, which is exactly how the 2026-08
#   keyv/@adminide-stack compromise propagated (hijack + republish, no CVE).
#
#   `npm ci` fixes that by construction: it installs the lockfile or fails.
#
#   npm ci refuses to run unless it can see the SAME workspace set the lockfile
#   was generated from, so all five workspace manifests are copied even though
#   only the backend's dependencies are installed. Manifests only — no sources —
#   so this layer stays cached until a dependency actually changes.
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/api-contracts/package.json packages/api-contracts/
COPY packages/ui-restore-cart/package.json packages/ui-restore-cart/
COPY backend/package.json backend/
COPY frontend/admin-panel/package.json frontend/admin-panel/
COPY frontend/tenant-panel/package.json frontend/tenant-panel/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace @insula/backend --include-workspace-root \
           --ignore-scripts --prefer-offline --no-audit --no-fund

# ─── prod-deps: the same install, runtime dependencies only ────────────────
#
# No --legacy-peer-deps. The previous build used it and that silently SKIPPED
# auto-installed peer dependencies, so the image shipped a different tree than
# the lockfile describes — the very thing this restructure exists to stop.
# Consequence worth knowing: typescript (~24MB) arrives as a production-reachable
# peer of cosmiconfig, because that is what package-lock.json says. Re-adding the
# flag does NOT drop it (verified — npm ci installs the locked tree either way),
# so the honest fix is upstream in whichever runtime dep pulls cosmiconfig, not a
# flag that hides the difference.
FROM deps AS prod-deps
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace @insula/backend --include-workspace-root --omit=dev \
           --ignore-scripts --prefer-offline --no-audit --no-fund

# ─── builder: compile shared contracts, then the backend ───────────────────
#
# In the workspace layout backend/ and packages/ are siblings exactly as in the
# repo, so backend/tsconfig.json's `../packages/api-contracts` reference
# resolves as-is. The previous flattened layout needed two `sed` rewrites (of
# package.json and tsconfig.json) to fake that; both are gone.
FROM deps AS builder
COPY packages/api-contracts/ packages/api-contracts/
COPY backend/tsconfig.json backend/
COPY backend/src/ backend/src/
# --build --force: a stale tsbuildinfo restored from a layer cache otherwise
# makes tsc emit ZERO files while exiting 0 (see feedback_api_contracts_build_force).
RUN npx tsc --build --force packages/api-contracts
RUN cd backend && npx tsc

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
# restic is used by modules/tenant-bundles (ADR-047, Phase 1+) — spawned
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
#
# rclone is used by modules/tenant-bundles/rclone-backup-store.ts — spawned
# to READ a FOREIGN backup target of ANY type (S3/SFTP/CIFS) during
# cross-cluster migration + DR-recover, where the shared backup-rclone-shim
# (which is scoped to THIS cluster's class bindings) can't reach the source.
# It's the same rclone the shim uses, but run one-shot against a single
# rendered target so CIFS/SMB sources are readable (the native S3/SSH stores
# can't do SMB). Config is passed via RCLONE_CONFIG_* env, never a file.
RUN apk add --no-cache openssl age postgresql18-client restic openssh-client rclone

WORKDIR /app

# Runtime layout is UNCHANGED from the pre-lockfile version: /app holds dist/,
# node_modules/, package.json and platform/cosign.pub, and the entrypoint runs
# `node dist/…` relative to /app. Only the provenance of node_modules changed.
#
# node_modules is hoisted to the workspace root, and @insula/api-contracts
# inside it is a workspace SYMLINK to ../packages/api-contracts — so the built
# contracts must be copied to the sibling path for that link to resolve.
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/api-contracts/ ./packages/api-contracts/
COPY --from=builder /repo/backend/dist/ dist/
COPY backend/package.json ./
COPY backend/src/db/migrations/ dist/db/migrations/
COPY backend/src/modules/plesk-migration/scripts/ dist/modules/plesk-migration/scripts/
COPY backend/docker-entrypoint.sh ./
# Pinned cosign public key — the trust anchor for the W11 version-poller
# (backend/src/cli/version-poll-job.ts reads /app/platform/cosign.pub). Baked
# from the committed key so it's always in lockstep with the image's release;
# no ConfigMap to drift. Verification is pure Node crypto — no cosign binary.
COPY platform/cosign.pub ./platform/cosign.pub

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost:3000/api/v1/healthz || exit 1

ENTRYPOINT ["sh", "docker-entrypoint.sh"]
