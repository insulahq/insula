#!/usr/bin/env bash
# The ModSecurity plugin inside a REAL Traefik (the interpreter and oxy buffer
# that unit tests cannot reproduce), against a fake ModSecurity that answers 403
# when the URI contains "attack" and 200 otherwise.
#
# Asserts, through Traefik exactly as routes chain it (waf-body-limit → plugin):
#   * the plugin loads as a local plugin from the three ConfigMap files;
#   * a clean POST passes, an attack is blocked — also with `Upgrade: websocket`
#     (upstream v1.6.0 let that header skip the WAF);
#   * a real websocket handshake is still inspected AND upgraded (101);
#   * an `errors` middleware in front replaces the block page (upstream #11);
#   * a body over the cap gets 413;
#   * the sidecar sees the client in X-Forwarded-For (upstream #21);
#   * waf-body-limit's buffer is REUSED, not copied: with the plugin's own spool
#     directory unusable, parallel multi-MiB uploads still succeed.
#
# Needs Docker. Uses `docker cp`, not bind mounts, so it also works where the
# Docker daemon runs on another host.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${PLUGIN_SRC:-$HERE/k8s/base/traefik/plugins/modsecurity}"
# Must match the Traefik that bootstrap's chart (TRAEFIK_CHART_VERSION) deploys.
TRAEFIK_IMAGE="${TRAEFIK_IMAGE:-traefik:v3.7.16}"
NGINX_IMAGE="${NGINX_IMAGE:-nginx:1.27-alpine}"
WHOAMI_IMAGE="${WHOAMI_IMAGE:-traefik/whoami:v1.12.0}"
CURL_IMAGE="${CURL_IMAGE:-curlimages/curl:8.10.1}"
MODULE="$(sed -n 's/^module //p' "$SRC/go.mod")"
pass=0; fail=0
ok(){ echo "  ok: $*"; pass=$((pass+1)); }
no(){ echo "  FAIL: $*"; fail=$((fail+1)); }
command -v docker >/dev/null 2>&1 || { echo "FAIL: docker required"; exit 1; }

TAG="msplug-$$"
NET="$TAG-net"
WORK="$(mktemp -d)"
cleanup() {
  docker rm -f "$TAG-traefik" "$TAG-waf" "$TAG-backend" "$TAG-errors" "$TAG-client" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/plugins-local/src/$MODULE" "$WORK/dyn" "$WORK/waf" "$WORK/errors"
cp "$SRC/modsecurity.go" "$SRC/go.mod" "$SRC/.traefik.yml" "$WORK/plugins-local/src/$MODULE/"
cat > "$WORK/waf/default.conf" <<'EOF'
log_format xff '$http_x_forwarded_for $request';
server { listen 80; client_max_body_size 50m; access_log /var/log/nginx/waf.log xff;
  location / { if ($request_uri ~* attack) { return 403 "WAF-BLOCKED\n"; } return 200 "OK\n"; } }
EOF
cat > "$WORK/errors/default.conf" <<'EOF'
server { listen 80; location / { return 200 "CUSTOM ERROR PAGE\n"; } }
EOF
# The production chain: waf-body-limit (k8s/base/traefik/middlewares-waf-body-limit.yaml)
# right before the plugin. spoolDir points nowhere, so only reuse can pass a large body.
cat > "$WORK/dyn/dyn.yml" <<EOF
http:
  routers:
    site:
      rule: Host(\`site.example.test\`)
      entryPoints: [web]
      middlewares: [waf-body-limit, waf]
      service: backend
    errpages:
      rule: Host(\`errors.example.test\`)
      entryPoints: [web]
      middlewares: [custom-errors, waf-body-limit, waf]
      service: backend
  middlewares:
    waf-body-limit:
      buffering:
        maxRequestBodyBytes: 13107200
        memRequestBodyBytes: 1048576
        maxResponseBodyBytes: 0
    custom-errors:
      errors:
        status: ["403"]
        service: errors
        query: /
    waf:
      plugin:
        modsecurity:
          modSecurityUrl: http://$TAG-waf
          timeoutMillis: 3000
          memBodyBytes: 1024
          spoolDir: /nonexistent
  services:
    backend:
      loadBalancer:
        servers: [{url: "http://$TAG-backend"}]
    errors:
      loadBalancer:
        servers: [{url: "http://$TAG-errors"}]
EOF

docker network create "$NET" >/dev/null
for c in waf errors; do
  docker create --name "$TAG-$c" --network "$NET" "$NGINX_IMAGE" >/dev/null
  docker cp "$WORK/$c/default.conf" "$TAG-$c:/etc/nginx/conf.d/default.conf"
  docker start "$TAG-$c" >/dev/null
done
docker run -d --name "$TAG-backend" --network "$NET" "$WHOAMI_IMAGE" >/dev/null
docker create --name "$TAG-traefik" --network "$NET" "$TRAEFIK_IMAGE" \
  --entryPoints.web.address=:80 \
  --providers.file.directory=/dyn \
  --experimental.localPlugins.modsecurity.moduleName="$MODULE" \
  --log.level=INFO >/dev/null
docker cp "$WORK/plugins-local" "$TAG-traefik:/plugins-local"
docker cp "$WORK/dyn" "$TAG-traefik:/dyn"
docker start "$TAG-traefik" >/dev/null
docker run -d --name "$TAG-client" --network "$NET" --entrypoint sleep "$CURL_IMAGE" 600 >/dev/null

C() { docker exec "$TAG-client" curl -s --http1.1 --max-time 20 "$@"; }
code() { C -o /dev/null -w '%{http_code}' -H 'Host: site.example.test' "$@" || true; }
for _ in $(seq 1 60); do
  [[ "$(code "http://$TAG-traefik/")" == 200 ]] && break
  sleep 1
done

echo "── plugin inside $TRAEFIK_IMAGE ──"
logs="$(docker logs "$TAG-traefik" 2>&1)"
grep -q 'Plugins loaded' <<<"$logs" && ! grep -q 'Plugins are disabled' <<<"$logs" \
  && ok "Traefik loaded the local plugin $MODULE" || no "plugin load: $(grep -i plugin <<<"$logs" | head -3)"
[[ "$(code --data 'a=1' "http://$TAG-traefik/form")" == 200 ]] && ok "clean POST passes" || no "clean POST"
[[ "$(code --data 'a=1' "http://$TAG-traefik/attack")" == 403 ]] && ok "attack blocked" || no "attack not blocked"
[[ "$(code -H 'Upgrade: websocket' --data 'a=1' "http://$TAG-traefik/attack")" == 403 ]] \
  && ok "attack + 'Upgrade: websocket' still blocked (the upstream bypass)" || no "Upgrade header bypassed the WAF"
[[ "$(code -H 'Upgrade: websocket' -H 'Connection: Upgrade' "http://$TAG-traefik/attack")" == 403 ]] \
  && ok "attack + Upgrade + Connection: Upgrade still blocked" || no "upgrade request bypassed the WAF"
# A raw '#' in the request target is not a fragment to Go's server: Traefik
# forwards everything after it, so the sidecar must see it too.
[[ "$(code --request-target '/ok?x=1#attack' "http://$TAG-traefik/")" == 403 ]] \
  && ok "a raw '#' in the target does not hide the rest from the WAF" || no "text after '#' bypassed the WAF"
# In the PATH, Traefik itself refuses a raw '#' (400) before any middleware;
# either way the backend must not get it.
pc="$(code --request-target '/ok#/attack' "http://$TAG-traefik/")"
[[ "$pc" == 400 || "$pc" == 403 ]] && ok "a raw '#' in the path never reaches the backend (HTTP $pc)" \
  || no "path after '#': HTTP $pc, sidecar saw: $(docker exec "$TAG-waf" tail -n 1 /var/log/nginx/waf.log)"
hs="$(code --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "http://$TAG-traefik/echo")"
[[ "$hs" == 101 ]] && docker exec "$TAG-waf" grep -q 'GET /echo ' /var/log/nginx/waf.log \
  && ok "a real websocket handshake is inspected (the sidecar saw it) and upgraded (101)" \
  || no "websocket handshake: $hs, sidecar saw: $(docker exec "$TAG-waf" grep -c '/echo' /var/log/nginx/waf.log)"
page="$(C -H 'Host: errors.example.test' "http://$TAG-traefik/attack" || true)"
[[ "$page" == "CUSTOM ERROR PAGE" ]] && ok "an errors middleware in front serves its own block page" || no "errors page: $page"
head -c $((13107200 + 1)) /dev/zero > "$WORK/over.bin"
docker cp "$WORK/over.bin" "$TAG-client:/tmp/over.bin"
[[ "$(code -H 'Content-Type: application/octet-stream' --data-binary @/tmp/over.bin "http://$TAG-traefik/up")" == 413 ]] \
  && ok "12.5 MiB + 1 byte → 413" || no "oversized body not refused"
ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$TAG-client")"
grep -q "^${ip} " <(docker exec "$TAG-waf" cat /var/log/nginx/waf.log) \
  && ok "the sidecar sees the client ($ip) in X-Forwarded-For" || no "X-Forwarded-For: $(docker exec "$TAG-waf" tail -2 /var/log/nginx/waf.log)"

head -c $((4 * 1048576)) /dev/urandom > "$WORK/body.bin"
docker cp "$WORK/body.bin" "$TAG-client:/tmp/body.bin"
args=()
for i in $(seq 1 8); do args+=(-o /dev/null "http://$TAG-traefik/upload/$i"); done
codes="$(C --parallel --parallel-immediate -H 'Host: site.example.test' -H 'Content-Type: application/octet-stream' \
  --data-binary @/tmp/body.bin -w '%{http_code}\n' "${args[@]}" | sort | uniq -c | tr -s ' ' | tr '\n' ';' || true)"
[[ "$codes" == " 8 200;" ]] && ok "8 parallel 4 MiB uploads pass with the plugin's spool unusable — waf-body-limit's buffer is reused" \
  || no "uploads: $codes $(docker logs "$TAG-traefik" 2>&1 | grep -i 'modsecurity\[' | tail -2)"

echo
echo "traefik modsecurity plugin (live): ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]]
