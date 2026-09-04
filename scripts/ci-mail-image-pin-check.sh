#!/usr/bin/env bash
# ci-mail-image-pin-check.sh — the Stalwart and stalwart-cli pins are written in
# more than one place; assert they agree.
#
# WHY THIS EXISTS
# ---------------
# `archive.ts` already carries the scar: "the constant it replaces sat at
# v0.16.5 while the server ran v0.16.14 — eleven releases of silent drift,
# because nothing forced the two to move together." A unit test was added, but
# it asserts the RESOLVER's behaviour against a literal in its own file — so all
# three copies could still march off in different directions and every test
# would stay green. Nothing compared the files. Now something does.
#
# Checked here:
#   1. Every `stalwartlabs/stalwart:<tag>` reference in k8s/ and backend/src
#      names the SAME tag. That covers the Deployment, the extra-CA component
#      patch and the archive-Job fallback.
#   2. The stalwart-cli version + sha256 in the backend constant match the ones
#      the Job script verifies against. A version bumped without its hash would
#      make the Job download the new archive, fail its own sha256 comparison and
#      exit 1 — a self-inflicted outage that only shows up when the Job runs.
#
# Deliberately NOT checked:
#   * dated provenance comments ("verified live on v0.16.16") — those record
#     what was true when someone tested it, not a pin;
#   * *.test.ts fixtures — archive-image.test.ts feeds the resolver v0.99.0 and
#     v0.1.0 on purpose, to prove it reads the live Deployment rather than
#     returning its literal. Treating those as pins made the first draft of this
#     guard fail on a correct tree, which is worse than no guard: the first
#     person to see it would delete it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0
note() { echo "  $*"; }

# ── 1. Stalwart image tag agreement ──────────────────────────────────────────
# Only real image references: a `image: …` line in YAML, or a quoted literal in
# TypeScript. Comments are excluded by requiring the reference to be preceded by
# `image: ` or a quote.
mapfile -t refs < <(
  grep -rhoE --exclude='*.test.ts' \
    "(image: *|['\"])docker\.io/stalwartlabs/stalwart:v[0-9]+\.[0-9]+\.[0-9]+" \
    k8s backend/src 2>/dev/null \
  | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -u
)
if [ "${#refs[@]}" -eq 0 ]; then
  echo "mail-pin-check: FAIL — no stalwart image reference found; did the path move?"
  exit 1
fi
if [ "${#refs[@]}" -gt 1 ]; then
  echo "mail-pin-check: FAIL — stalwart image pinned to more than one version:"
  printf '  %s\n' "${refs[@]}"
  echo "  Every copy must move together. Locations:"
  grep -rnE --exclude='*.test.ts' "(image: *|['\"])docker\.io/stalwartlabs/stalwart:v" k8s backend/src 2>/dev/null | sed 's/^/    /'
  fail=1
else
  note "stalwart image: ${refs[0]} (consistent across k8s/ + backend/src)"
fi

# ── 2. stalwart-cli version + sha agreement ──────────────────────────────────
TS=backend/src/modules/mail-admin/blob-store-cli-version.ts
JOB=k8s/overlays/development/stalwart-throttle-override-job.yaml

ts_ver=$(grep -oE "STALWART_CLI_VERSION = '[^']+'" "$TS" | grep -oE "v[0-9.]+" || true)
ts_sha=$(grep -oE "STALWART_CLI_SHA256 = '[0-9a-f]{64}'" "$TS" | grep -oE '[0-9a-f]{64}' || true)
job_ver=$(grep -oE 'CLI_VERSION="v[0-9.]+"' "$JOB" | grep -oE 'v[0-9.]+' || true)
job_sha=$(grep -oE 'CLI_SHA256="[0-9a-f]{64}"' "$JOB" | grep -oE '[0-9a-f]{64}' || true)

for v in "$ts_ver" "$ts_sha" "$job_ver" "$job_sha"; do
  if [ -z "$v" ]; then
    echo "mail-pin-check: FAIL — could not read one of the stalwart-cli pins."
    echo "  ts=$ts_ver/$ts_sha  job=$job_ver/$job_sha"
    exit 1
  fi
done

if [ "$ts_ver" != "$job_ver" ]; then
  echo "mail-pin-check: FAIL — stalwart-cli version mismatch: $TS=$ts_ver vs $JOB=$job_ver"
  fail=1
fi
if [ "$ts_sha" != "$job_sha" ]; then
  echo "mail-pin-check: FAIL — stalwart-cli sha256 mismatch between $TS and $JOB."
  echo "  A version bumped without its hash makes the Job exit 1 on its own check."
  fail=1
fi
[ "$fail" -eq 0 ] && note "stalwart-cli: $ts_ver (version + sha256 agree across both pins)"

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "ci-mail-image-pin-check: OK"
