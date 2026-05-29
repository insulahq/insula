# Traefik local-plugin image for the Coraza WAF middleware.
#
# Background: an earlier attempt vendored the Go source of
# github.com/hatsat32/coraza-traefik and let Yaegi (Traefik's embedded
# Go interpreter) load it. That failed because Coraza's internal/
# corazawaf package imports the `unsafe` stdlib package, which Yaegi
# does not implement. Smoke-tested against Traefik v3.7.1 on 2026-05-14:
#   ERR Plugins are disabled because an error has occurred.
#   error="... import \"unsafe\" error: unable to find source related
#   to: \"unsafe\""
#
# The WASM build path avoids the `unsafe` constraint: Coraza compiles
# (via TinyGo) to a self-contained WebAssembly module that conforms to
# the http-wasm ABI. Traefik v3 supports loading WASM plugins natively
# when the plugin's .traefik.yml declares `runtime: wasm`.
#
# This Dockerfile bakes the pre-built coraza-http-wasm.wasm binary
# (from corazawaf/coraza-http-wasm GitHub releases) into a tiny
# busybox image. The Traefik DaemonSet runs it as an initContainer
# that stages /plugins-local/src/<moduleName>/ onto a shared emptyDir
# volume, which the main Traefik container then mounts.
#
# Build:  docker build -t ghcr.io/insulahq/insula/traefik-plugin-coraza:<tag> docker/traefik-plugin-coraza/
# Push:   docker push ghcr.io/insulahq/insula/traefik-plugin-coraza:<tag>
# Update: bump TRAEFIK_PLUGIN_CORAZA_IMAGE + CORAZA_WASM_VERSION in scripts/bootstrap.sh.

# ─── Builder: download + verify WASM binary ──────────────────────────
FROM alpine:3.19 AS download
ARG CORAZA_WASM_VERSION=v0.3.0
RUN apk add --no-cache curl unzip
WORKDIR /staging
RUN curl -fsSL "https://github.com/corazawaf/coraza-http-wasm/releases/download/${CORAZA_WASM_VERSION}/coraza-http-wasm-${CORAZA_WASM_VERSION}.zip" \
      -o coraza-http-wasm.zip \
 && unzip coraza-http-wasm.zip \
 && rm coraza-http-wasm.zip \
 && test -s coraza-http-wasm.wasm \
 && ls -la coraza-http-wasm.wasm

# ─── Runtime: busybox + WASM payload ─────────────────────────────────
FROM busybox:1.37

# Stage the plugin tree at the path Traefik expects to find local
# plugins (/plugins-local/src/<moduleName>/). The same path appears
# in the Traefik DaemonSet's `--experimental.localPlugins.coraza.
# moduleName=phoenix-platform/traefik-plugin-coraza` flag.
COPY plugin/.traefik.yml /plugins-local/src/phoenix-platform/traefik-plugin-coraza/.traefik.yml
COPY --from=download /staging/coraza-http-wasm.wasm /plugins-local/src/phoenix-platform/traefik-plugin-coraza/plugin.wasm

# When run as an initContainer, copy the plugin tree onto the shared
# emptyDir (mounted at /shared). The Traefik container then mounts the
# same emptyDir at /plugins-local and loads the plugin.
ENTRYPOINT ["/bin/sh", "-c", "set -e; mkdir -p /shared/src; cp -R /plugins-local/src/* /shared/src/; echo \"staged Coraza WASM plugin ($(wc -c < /shared/src/phoenix-platform/traefik-plugin-coraza/plugin.wasm) bytes)\""]
