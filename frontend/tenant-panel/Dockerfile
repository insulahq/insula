# syntax=docker/dockerfile:1.7

# ─── deps: install from the LOCKFILE, in the real workspace layout ──────────
#
# WHY (2026-08-06): this image used to run `npm install` from package.json with
# NO lockfile in the build context, so every build re-resolved `^` ranges against
# the live registry and package-lock.json did not govern what shipped — the exact
# gap the 2026-08 keyv/@adminide-stack hijack-and-republish wave exploits.
# `npm ci` installs the locked tree or fails.
#
# glibc (slim), NOT alpine/musl: package-lock.json is generated on glibc, so it
# records @rolldown/binding-linux-x64-gnu and no musl variant. The previous
# `npm install` hid that by re-resolving on alpine and quietly picking the musl
# binding — the very non-reproducibility this change removes. The RUNTIME image
# below is untouched (nginx:alpine); only static assets cross the boundary.
FROM node:22-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/api-contracts/package.json packages/api-contracts/
COPY packages/ui-restore-cart/package.json packages/ui-restore-cart/
COPY backend/package.json backend/
COPY frontend/admin-panel/package.json frontend/admin-panel/
COPY frontend/tenant-panel/package.json frontend/tenant-panel/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --include-workspace-root \
           --workspace @insula/tenant-panel \
           --workspace @insula/ui-restore-cart \
           --workspace @insula/api-contracts \
           --ignore-scripts --prefer-offline --no-audit --no-fund
# The old build had to `rm -rf packages/ui-restore-cart/node_modules/react*`:
# a second React copy made Vite bundle two dispatchers and /backups/restore died
# on "Cannot read properties of null (reading 'useState')". A workspaces install
# hoists ONE react to the root, so the duplicate cannot arise — asserted here
# because that failure is a runtime crash on one page, not a build error.
RUN test ! -e packages/ui-restore-cart/node_modules/react \
    && test ! -e frontend/tenant-panel/node_modules/react \
    || { echo "ERROR: react was NOT hoisted — a duplicate copy would crash /backups/restore"; exit 1; }

# ─── builder: shared contracts → shared UI → panel ─────────────────────────
#
# The workspace layout matches the repo, so every "@insula/*": "*" reference
# resolves natively; the flattened layout's three `sed` rewrites are gone.
FROM deps AS builder
# --build --force: a stale tsbuildinfo restored from a layer cache otherwise
# makes tsc emit ZERO files while exiting 0 (feedback_api_contracts_build_force).
COPY packages/api-contracts/ packages/api-contracts/
RUN npx tsc --build --force packages/api-contracts
COPY packages/ui-restore-cart/ packages/ui-restore-cart/
RUN npx tsc --build --force packages/ui-restore-cart
COPY frontend/tenant-panel/index.html frontend/tenant-panel/tsconfig.json frontend/tenant-panel/vite.config.ts frontend/tenant-panel/postcss.config.js frontend/tenant-panel/
COPY frontend/tenant-panel/src/ frontend/tenant-panel/src/
COPY frontend/tenant-panel/public/ frontend/tenant-panel/public/
RUN cd frontend/tenant-panel && npx vite build

FROM nginx:1.27-alpine
COPY --from=builder /repo/frontend/tenant-panel/dist/ /usr/share/nginx/html/
# Nginx config template — BACKEND_HOST/BACKEND_PORT substituted at startup
COPY frontend/tenant-panel/nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY frontend/tenant-panel/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/tenant-panel/config.template.js /usr/share/nginx/html/config.template.js
COPY frontend/security-headers.conf /etc/nginx/security-headers.conf
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Runtime config defaults (same-origin API, k8s service DNS for proxy backend)
ENV API_URL=""
ENV BACKEND_HOST="platform-api.platform.svc.cluster.local"
ENV BACKEND_PORT="3000"

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
