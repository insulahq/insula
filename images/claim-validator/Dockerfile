# Claim Validator sidecar — wraps the per-client oauth2-proxy with
# arbitrary OIDC claim policy enforcement. Tiny Node image, zero
# runtime deps beyond the standard library.
#
# See server.mjs for the validator semantics (operators, rule file
# format, sidecar lifecycle).

FROM node:22-alpine3.20@sha256:2289fb1fba0f4633b08ec47b94a89c7e20b829fc5679f9b7b298eaa2f1ed8b7e

WORKDIR /app

COPY server.mjs ./server.mjs

# Run as non-root. uid/gid 65532 matches the distroless / oauth2-proxy
# convention so a shared volume mount has compatible perms by default.
RUN addgroup -S -g 65532 validator && \
    adduser -S -u 65532 -G validator validator
USER 65532:65532

# /etc/claim-rules/rules.json is mounted by the platform-api at deploy
# time (ConfigMap volume). The file watcher in server.mjs picks up
# rule changes without a pod restart.
ENV PORT=4181
EXPOSE 4181

ENTRYPOINT ["node", "/app/server.mjs"]
