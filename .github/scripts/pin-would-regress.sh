#!/usr/bin/env bash
#
# Would writing THIS run's pin move the development pin BACKWARDS?
#
# Exit 0  = yes, it would regress — the caller must skip the pin.
# Exit 1  = no, go ahead.
#
# Why this exists
# ---------------
# `update-development-version` writes whatever its own run built. Its
# race-recovery loop resets onto the new HEAD and RE-APPLIES the same values,
# which is correct when two builds finish in the order they started and wrong
# when they do not.
#
# Observed on 2026-08-30 (four builds on `development`):
#
#     932bd7a  created 11:09:20   finished 12:38:52   <- 90 minutes
#     fe97a90  created 11:29:10   finished 11:31:48
#     36e485f  created 11:59:15   finished 12:01:54
#     9a2a82f  created 12:21:43   finished 12:24:18
#
# The slow one finished LAST and pinned its own, oldest images over the newest
# pin. The DEV cluster silently rolled back three merges — including a fix for
# an unauthenticated request that could OOM the ingress — and nothing reported
# it. `check-pin-lag.sh` noticed afterwards, but by then DEV had been running
# stale code for 25 minutes.
#
# Concurrency groups do not help: they serialise the writes, they do not order
# them by content. The missing check is this one.
#
# How
# ---
# Compare ancestry, not timestamps. If the commit currently pinned is a
# DESCENDANT of the commit this run built, the pin already reflects newer code
# and must not be overwritten.
#
# Fails OPEN: if the pinned sha cannot be resolved (force-push, a hand-written
# pin, a shallow clone that lacks the object), this exits 1 and the pin
# proceeds. A pin that should have been skipped is recoverable — the next build
# corrects it. Refusing to pin at all because we could not read the old value
# would wedge deploys, which is worse.
set -euo pipefail

PIN_FILE="${PIN_FILE:-k8s/overlays/development/platform-version-patch.yaml}"
BUILT_SHA="${BUILT_SHA:-${GITHUB_SHA:-}}"

if [ -z "$BUILT_SHA" ]; then
  echo "pin-would-regress: BUILT_SHA/GITHUB_SHA not set — proceeding" >&2
  exit 1
fi
if [ ! -f "$PIN_FILE" ]; then
  echo "pin-would-regress: $PIN_FILE absent — proceeding (first pin)" >&2
  exit 1
fi

# The pin file carries `version: "<calver>-<short-sha>"`.
pinned_version=$(grep -oE 'version:[[:space:]]*"[^"]*"' "$PIN_FILE" | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
pinned_sha=$(printf '%s' "$pinned_version" | grep -oE '[0-9a-f]{7,40}$' || true)

if [ -z "$pinned_sha" ]; then
  echo "pin-would-regress: no sha in '${pinned_version}' — proceeding" >&2
  exit 1
fi

built_short=$(git rev-parse --short=7 "$BUILT_SHA" 2>/dev/null || printf '%s' "$BUILT_SHA")
if [ "$pinned_sha" = "$built_short" ]; then
  echo "pin-would-regress: already pinned to ${pinned_sha} — proceeding (idempotent re-apply)" >&2
  exit 1
fi

if ! git cat-file -e "${pinned_sha}^{commit}" 2>/dev/null; then
  echo "pin-would-regress: pinned commit ${pinned_sha} not in this clone — proceeding" >&2
  exit 1
fi

# Is what we built an ANCESTOR of what is pinned? Then the pin is newer.
if git merge-base --is-ancestor "$BUILT_SHA" "$pinned_sha" 2>/dev/null; then
  echo "pin-would-regress: development is pinned to ${pinned_sha}, which already contains ${built_short} — SKIPPING to avoid rolling the cluster back" >&2
  exit 0
fi

echo "pin-would-regress: ${built_short} is not an ancestor of pinned ${pinned_sha} — proceeding" >&2
exit 1
