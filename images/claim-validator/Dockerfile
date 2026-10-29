# Route sign-in gate sidecar — applies each protected route's policy (allow
# lists, claim rules, identity headers) in front of the tenant's oauth2-proxy.
# Tiny Node image, no runtime deps beyond the standard library.
#
# See server.mjs for the semantics (policy file format, fail-closed rules).

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

WORKDIR /app

COPY server.mjs ./server.mjs

# Run as non-root. uid/gid 65532 matches the distroless / oauth2-proxy
# convention so a shared volume mount has compatible perms by default.
RUN addgroup -S -g 65532 validator && \
    adduser -S -u 65532 -G validator validator
USER 65532:65532

# /etc/route-gate/policy.json is mounted by platform-api (ConfigMap volume,
# whole directory so updates arrive); server.mjs reloads it on change.
ENV PORT=4181
EXPOSE 4181

ENTRYPOINT ["node", "/app/server.mjs"]
