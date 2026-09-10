#!/usr/bin/env bash
# ci-modsec-rules-parse-check.sh — prove the modsec exclusion rule files
# actually PARSE, by loading them into the real CRS image.
#
# WHY THIS EXISTS
# ---------------
# On 2026-09-09 two separate unparseable rule files reached `development`
# within one hour:
#
#   1. a chained SecRule with no action list at end-of-file, which bleeds into
#      the next-loaded rules file:
#        "Disruptive actions can only be specified by chain starter rules."
#   2. `ctl:responseBodyAccess=Off`, an action that does not exist in
#      ModSecurity v3 at all:
#        "Expecting an action, got: ctl:responseBodyAccess=Off"
#
# Either one makes nginx refuse to start, so every modsec-crs pod
# CrashLoopBackOffs and EVERY WAF'd request 502s. That is an availability
# outage of a security control, caused by a typo, with no test in front of it.
#
# HOW IT CHECKS — and how NOT to
# ------------------------------
# `nginx -t` inside an ad-hoc container is WORTHLESS here. Overriding the
# container command (e.g. `sleep`) skips /docker-entrypoint.sh, which is what
# generates /etc/nginx/conf.d/modsecurity.conf — the file carrying the
# `modsecurity_rules_file` directive. Without it nginx never reads the rules
# and `nginx -t` returns "syntax is ok" for a file that provably crashes the
# real container. That harness passed BOTH bugs above straight through.
#
# So: run the real image with its REAL entrypoint and assert the container is
# still alive after startup. And always control-test with a known-broken file
# — a check that has never failed has not been shown to work.
set -euo pipefail

IMAGE="${MODSEC_IMAGE:-docker.io/owasp/modsecurity-crs:4.28.0-nginx-alpine-202607160307}"
RULES_MOUNT=/etc/modsecurity.d/owasp-crs/rules/REQUEST-900-EXCLUSION-RULES-BEFORE-CRS.conf
BASE_DIR="k8s/base/modsecurity-crs"
WORK=$(mktemp -d)
# `loads()` runs inside $( ), i.e. a SUBSHELL, so a CID assigned in it can never
# reach this scope — a trap reading a shell variable would always see "" and
# clean up nothing. Record the id in a FILE instead, which the subshell and the
# trap both share, so an interrupted run (cancelled job, runner timeout) still
# tears the container down.
CIDFILE="$WORK/cid"
trap 'if [ -s "$CIDFILE" ]; then docker rm -f "$(cat "$CIDFILE")" >/dev/null 2>&1 || true; fi
      if [ -s "$WORK/tag" ]; then docker rmi -f "$(cat "$WORK/tag")" >/dev/null 2>&1 || true; fi
      rm -rf "$WORK"' EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "ci-modsec-rules-parse-check: docker unavailable — SKIPPING (this check is not optional in CI; investigate if you see this there)" >&2
  exit 0
fi

# Render the ConfigMaps and pull out every REQUEST-9xx rules document.
if command -v kubectl >/dev/null 2>&1; then
  kubectl kustomize "$BASE_DIR" > "$WORK/rendered.yaml"
else
  echo "ci-modsec-rules-parse-check: kubectl not found, cannot render kustomize" >&2
  exit 1
fi

# The rules contain Flux postBuild placeholders (`${DOMAIN}` in the host
# guards). `kubectl kustomize` does NOT expand those — Flux does, at apply time
# — so testing the raw render would feed modsec a regex containing `${DOMAIN}`,
# where `$` anchors and `{DOMAIN}` is not a valid quantifier. Substitute a
# representative apex first, so what we parse is what the cluster runs.
SUBST_DOMAIN="${SUBST_DOMAIN:-example.test}"
python3 - "$WORK" "$SUBST_DOMAIN" <<'PY'
import sys, yaml, pathlib, re
work = pathlib.Path(sys.argv[1])
domain = sys.argv[2]
n = 0
placeholders = set()
for doc in yaml.safe_load_all((work / 'rendered.yaml').read_text()):
    if not doc or doc.get('kind') != 'ConfigMap':
        continue
    for key, val in (doc.get('data') or {}).items():
        if key.startswith('REQUEST-9') and key.endswith('.conf'):
            placeholders |= set(re.findall(r'\$\{([A-Z_][A-Z0-9_]*)\}', val))
            val = val.replace('${DOMAIN}', domain)
            (work / key).write_text(val)
            n += 1
            print(f"  rendered {key} ({len(val)} bytes)")
if n == 0:
    sys.exit("ci-modsec-rules-parse-check: rendered NO rule files — the extractor matched nothing, which would make this check vacuous")
# Any placeholder we do not substitute would reach modsec verbatim and could
# silently change a regex's meaning. Fail loudly rather than test a fiction.
unknown = placeholders - {'DOMAIN'}
if unknown:
    sys.exit(f"ci-modsec-rules-parse-check: unsubstituted placeholder(s) {sorted(unknown)} in the rules — "
             "add them here (with a representative value) so the parse test matches what Flux deploys")
PY

# Load one candidate file into the real image; echo "ok" if it stays up.
#
# The file is baked in with `docker build`, NOT bind-mounted. A `-v` mount is
# resolved on the DAEMON's filesystem: with a remote or containerised daemon
# (docker-in-docker, rootless, CI service containers) the host path does not
# exist there, so docker silently creates an empty DIRECTORY at the mount point
# and modsec dies with "input in flex scanner failed" — a FALSE FAILURE on a
# perfectly good rules file. A build context is streamed to the daemon, so it
# works wherever docker does. Verified against a DinD daemon 2026-09-09.
loads() {
  local file="$1" tag="modsec-parsecheck:$$-$RANDOM" ctx
  ctx=$(mktemp -d)
  cp "$file" "$ctx/rules.conf"
  cat > "$ctx/Dockerfile" <<DOCKERFILE
FROM $IMAGE
COPY rules.conf $RULES_MOUNT
DOCKERFILE
  printf '%s' "$tag" > "$WORK/tag"
  if ! docker build -q -t "$tag" "$ctx" >/dev/null 2>&1; then
    rm -rf "$ctx"; echo "no"; return
  fi
  rm -rf "$ctx"
  # No --rm: it deletes the container before `docker logs` can explain WHY.
  CID=$(docker run -d -e BACKEND=http://127.0.0.1:8080 "$tag" 2>/dev/null) || {
    docker rmi -f "$tag" >/dev/null 2>&1; : > "$WORK/tag"; echo "no"; return
  }
  printf '%s' "$CID" > "$CIDFILE"
  local verdict=ok
  # nginx dies within a second or two on a rules error; give it room.
  for _ in $(seq 1 15); do
    sleep 1
    if ! docker inspect -f '{{.State.Running}}' "$CID" 2>/dev/null | grep -q true; then
      docker logs "$CID" 2>&1 | grep -iE "rules error|emerg|expecting an action|chain starter|flex scanner" \
        | head -2 | sed 's/^/       /' >&2 || true
      verdict=no; break
    fi
  done
  docker rm -f "$CID" >/dev/null 2>&1 || true
  docker rmi -f "$tag" >/dev/null 2>&1 || true
  : > "$CIDFILE"; : > "$WORK/tag"
  echo "$verdict"
}

status=0

# POSITIVE control, first: the image's own untouched rules must load. If this
# fails, the harness is broken (bad image, no network, daemon quirk) and every
# FAIL below is a false alarm rather than a bad rules file. Without this, a
# wholly broken harness looks exactly like "all your rules are broken".
printf 'SecComponentSignature "ci-parse-check-positive-control"\n' > "$WORK/positive-control.conf"
if [ "$(loads "$WORK/positive-control.conf")" = ok ]; then
  echo "  PASS  positive control (trivial valid file) loads"
else
  echo "  FAIL  positive control could not load — the HARNESS is broken, not the rules." >&2
  echo "        Check docker, image pull, and daemon locality before trusting any result." >&2
  exit 1
fi

for f in "$WORK"/REQUEST-9*.conf; do
  name=$(basename "$f")
  if [ "$(loads "$f")" = ok ]; then
    echo "  PASS  $name parses and nginx starts"
  else
    echo "  FAIL  $name — modsec refused to load it; nginx would CrashLoopBackOff" >&2
    status=1
  fi
done

# Control: a dangling `chain` at EOF must FAIL to load. If this "passes",
# the harness has no power to fail and every result above is meaningless.
CONTROL="$WORK/control-broken.conf"
first=$(ls "$WORK"/REQUEST-9*.conf | head -1)
cp "$first" "$CONTROL"
cat >> "$CONTROL" <<'BROKEN'

    SecRule REQUEST_URI "@rx /ci-control-should-never-load" \
        "id:9009999,\
         phase:1,\
         pass,\
         chain"
BROKEN
if [ "$(loads "$CONTROL")" = no ]; then
  echo "  PASS  control (dangling chain) correctly REFUSED to load"
else
  echo "  FAIL  control file LOADED — this check cannot detect a broken rule file and is vacuous" >&2
  status=1
fi

[ "$status" -eq 0 ] && echo "ci-modsec-rules-parse-check: OK"
exit "$status"
