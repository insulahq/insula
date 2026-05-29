# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS builder

WORKDIR /app

# Build shared API contracts first.
# --build --force prevents stale tsbuildinfo from a Docker layer cache
# from producing zero output when src changed but the buildinfo wasn't
# invalidated (see feedback_api_contracts_build_force). Without --force,
# the admin-panel TS errors on types added in PR #100 (drift,
# lastFailedMigration, MailPortExposureMode) — the source has them but
# the cached dist doesn't.
COPY packages/api-contracts/ ./packages/api-contracts/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd packages/api-contracts && npm install --ignore-scripts --prefer-offline --no-audit --no-fund && npx tsc --build --force

# Build the shared restore-cart UI workspace (packages/ui-restore-cart).
# Depends on api-contracts via a workspace ref ("*") which we rewrite to
# a file: URL pointing at the sibling dir built above. Same --force
# discipline as api-contracts to defeat stale Docker layer-cache
# tsbuildinfo (feedback_api_contracts_build_force).
COPY packages/ui-restore-cart/ ./packages/ui-restore-cart/
RUN sed -i 's|"@insula/api-contracts": "\*"|"@insula/api-contracts": "file:../api-contracts"|' packages/ui-restore-cart/package.json \
    && grep -q '"@insula/api-contracts": "file:../api-contracts"' packages/ui-restore-cart/package.json \
    || { echo "ERROR: sed rewrite of ui-restore-cart api-contracts ref failed — package.json formatting drifted"; exit 1; }
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd packages/ui-restore-cart && npm install --ignore-scripts --prefer-offline --no-audit --no-fund --legacy-peer-deps && npx tsc --build --force

# Build admin panel
COPY frontend/admin-panel/package.json ./package.json
RUN sed -i 's|"@insula/api-contracts": "\*"|"@insula/api-contracts": "file:./packages/api-contracts"|' package.json
RUN sed -i 's|"@insula/ui-restore-cart": "\*"|"@insula/ui-restore-cart": "file:./packages/ui-restore-cart"|' package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --ignore-scripts --prefer-offline --no-audit --no-fund --legacy-peer-deps
COPY frontend/admin-panel/index.html frontend/admin-panel/tsconfig.json frontend/admin-panel/vite.config.ts frontend/admin-panel/postcss.config.js ./
COPY frontend/admin-panel/src/ src/
COPY frontend/admin-panel/public/ public/
RUN npx vite build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist/ /usr/share/nginx/html/
# Nginx config template — BACKEND_HOST/BACKEND_PORT substituted at startup
COPY frontend/admin-panel/nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY frontend/admin-panel/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/admin-panel/config.template.js /usr/share/nginx/html/config.template.js
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Runtime config defaults (same-origin API, k8s service DNS for proxy backend)
ENV API_URL=""
ENV TENANT_PANEL_URL=""
ENV STALWART_ADMIN_URL=""
ENV LONGHORN_URL=""
ENV BACKEND_HOST="platform-api.platform.svc.cluster.local"
ENV BACKEND_PORT="3000"

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
