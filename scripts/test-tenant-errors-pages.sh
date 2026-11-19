#!/usr/bin/env bash
# test-tenant-errors-pages.sh — run the tenant error-page service (k8s/base/tenant-errors/)
# in the image its Deployment names and check what each kind of request gets.
#
# Routes' custom error pages ask this service for /{status}.html through
# Traefik's errors middleware (annotation-sync.ts); a tenant's redirect sink
# sends it any path (redirect-sink.ts). The config is a map, a try_files into
# an internal template and sub_filter with variables, none of which a unit
# test sees. Checked here:
#   - /<4xx|5xx>.html is the template with that code, its title and message,
#     and no placeholder left; a query string does not change the code;
#   - a page shipped under a code's name (an operator overlay) wins;
#   - /error.html, the config and any other path are never served as files:
#     the template is internal, and any other path answers 503 with its page;
#   - every response is text/html; charset=utf-8 (healthz: text/plain),
#     Cache-Control: no-store, and the Server header names no version;
#   - nginx -t passes and the error log stays empty.
#
# Files go in with `docker cp`, so it works when the Docker daemon runs on
# another host (bind mounts resolve on the daemon). Needs docker.
set -uo pipefail
ROOT="${1:-$(git rev-parse --show-toplevel)}"
DIR="$ROOT/k8s/base/tenant-errors"
IMAGE="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]]+).*/\1/p' "$DIR/deployment.yaml" | head -1)"
[ -n "$IMAGE" ] || { echo "FAIL: no image in $DIR/deployment.yaml"; exit 1; }

TMP="$(mktemp -d)"
NAMES=()
cleanup() { for n in "${NAMES[@]}"; do docker rm -f "$n" >/dev/null 2>&1; done; rm -rf "$TMP"; }
trap cleanup EXIT

fails=0; checks=0
ok()   { checks=$((checks + 1)); echo "ok   $*"; }
bad()  { checks=$((checks + 1)); fails=$((fails + 1)); echo "FAIL $*"; }

# start <name> [branded-404-file] — a container with the service's files in place.
start() {
  local n="tenant-errors-test-$$-$1"
  NAMES+=("$n")
  docker create --name "$n" "$IMAGE" >/dev/null || return 1
  docker cp "$DIR/content/default.conf" "$n:/etc/nginx/conf.d/default.conf" >/dev/null || return 1
  docker cp "$DIR/content/error.html" "$n:/usr/share/nginx/html/error.html" >/dev/null || return 1
  [ -z "${2:-}" ] || docker cp "$2" "$n:/usr/share/nginx/html/404.html" >/dev/null || return 1
  docker start "$n" >/dev/null || return 1
  local i; for i in $(seq 1 20); do
    docker exec "$n" sh -c 'printf "GET /healthz HTTP/1.0\r\n\r\n" | nc 127.0.0.1 80' 2>/dev/null | grep -q '^HTTP/1.1 200' && break
    sleep 0.5
  done
  echo "$n"
}

# get <container> <path> — sets STATUS, HEADERS, BODY from a raw HTTP/1.0 request.
get() {
  local raw
  raw="$(docker exec "$1" sh -c "printf 'GET $2 HTTP/1.0\r\nHost: example.test\r\n\r\n' | nc 127.0.0.1 80" | tr -d '\r')"
  HEADERS="${raw%%$'\n\n'*}"
  BODY="${raw#*$'\n\n'}"
  STATUS="$(head -1 <<<"$HEADERS" | cut -d' ' -f2)"
}
header() { grep -i -m1 "^$1:" <<<"$HEADERS" | sed -E 's/^[^:]+:[[:space:]]*//'; }
title() { grep -o '<title>[^<]*</title>' <<<"$BODY" | sed 's/<[^>]*>//g'; }

# expect_page <container> <path> <status> <title> [message-fragment]
expect_page() {
  local c="$1" p="$2" st="$3" t="$4" m="${5:-}" why=""
  get "$c" "$p"
  [ "$STATUS" = "$st" ] || why+=" status=$STATUS (want $st);"
  [ "$(title)" = "$t" ] || why+=" title='$(title)' (want '$t');"
  [ -z "$m" ] || grep -qF "$m" <<<"$BODY" || why+=" message missing '$m';"
  ! grep -q '{{' <<<"$BODY" || why+=" placeholder left;"
  [ "$(header Content-Type)" = "text/html; charset=utf-8" ] || why+=" content-type='$(header Content-Type)';"
  [ "$(header Cache-Control)" = "no-store" ] || why+=" cache-control='$(header Cache-Control)';"
  [ "$(header Server)" = "nginx" ] || why+=" server='$(header Server)';"
  if [ -z "$why" ]; then ok "$p -> $st '$t'"; else bad "$p:$why"; fi
}

echo "image: $IMAGE"
C="$(start plain)" || { echo "FAIL: could not start $IMAGE"; exit 1; }
if docker exec "$C" nginx -t >/dev/null 2>&1; then ok "nginx -t"; else bad "nginx -t: $(docker exec "$C" nginx -t 2>&1 | tail -2)"; fi

expect_page "$C" /404.html 200 "404 Page not found" "does not exist or has moved"
expect_page "$C" /403.html 200 "403 Access denied" "do not have permission"
expect_page "$C" /429.html 200 "429 Too many requests" "wait a moment"
expect_page "$C" /500.html 200 "500 Internal server error" "ran into a problem"
expect_page "$C" /502.html 200 "502 Bad gateway" "did not answer properly"
expect_page "$C" /503.html 200 "503 Service unavailable" "temporarily unavailable"
expect_page "$C" /504.html 200 "504 Gateway timeout" "took too long to answer"
expect_page "$C" /418.html 200 "418 Request error" "could not be completed"
expect_page "$C" /599.html 200 "599 Server error" "ran into a problem"
expect_page "$C" "/404.html?from=traefik" 200 "404 Page not found"
# Not a page name: the redirect sink's paths, the config, the template itself.
for p in / /some/page /default.conf /200.html /4040.html /404.htmlx /404.html/x; do
  expect_page "$C" "$p" 503 "503 Service unavailable" "temporarily unavailable"
done
get "$C" /error.html
if [ "$STATUS" = "404" ] && ! grep -q '{{' <<<"$BODY"; then ok "/error.html is internal (404)"; else bad "/error.html served: status $STATUS"; fi
get "$C" /healthz
if [ "$STATUS" = "200" ] && [ "$BODY" = "ok" ] && [ "$(header Content-Type)" = "text/plain; charset=utf-8" ]; then ok "/healthz -> 200 ok"; else bad "/healthz: status $STATUS body '$BODY'"; fi

printf '<!DOCTYPE html><html><head><title>Branded not found</title></head><body><p>Ours</p></body></html>\n' > "$TMP/404.html"
B="$(start branded "$TMP/404.html")" || { echo "FAIL: could not start the branded container"; exit 1; }
get "$B" /404.html
if [ "$STATUS" = "200" ] && [ "$(title)" = "Branded not found" ]; then ok "a shipped 404.html wins over the template"; else bad "shipped 404.html not served: status $STATUS title '$(title)'"; fi
expect_page "$B" /403.html 200 "403 Access denied"

for n in "$C" "$B"; do
  errs="$(docker logs "$n" 2>&1 | grep -E '\[(warn|error|crit|alert|emerg)\]' || true)"
  if [ -z "$errs" ]; then ok "$n: empty error log"; else bad "$n error log: $(head -3 <<<"$errs")"; fi
done

echo "test-tenant-errors-pages: $((checks - fails))/$checks passed"
[ "$fails" -eq 0 ]
