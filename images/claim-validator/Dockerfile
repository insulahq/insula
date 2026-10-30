# Route sign-in gate sidecar — applies each protected route's policy (allow
# lists, claim rules, identity headers) in front of the tenant's oauth2-proxy.
# Tiny Node image, no runtime deps beyond the standard library.
#
# See server.mjs for the semantics (policy file format, fail-closed rules).

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4

WORKDIR /app

# Package fixes published after the base image was built (an image is only
# rebuilt when its sources change): take them at build time.
RUN apk upgrade --no-cache

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
