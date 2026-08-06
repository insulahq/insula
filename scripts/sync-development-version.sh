#!/usr/bin/env bash
# sync-development-version.sh — after a release is cut, bring `development`'s
# platform/VERSION up to the released version.
#
# WHY: `cut-release.sh` writes platform/VERSION on the `main` worktree (ADR-053:
# releases are cut from `main`), and promotion is one-way `development → main`.
# So the stamp never comes back, and development's VERSION freezes at whatever
# it was the last time somebody edited it by hand.
#
# That is not cosmetic. platform/VERSION is what a fresh install resolves its
# platform-ops release asset from:
#     https://github.com/<repo>/releases/download/v<VERSION>/insula-linux-<arch>
# Left behind, it names a tag that was never cut. The DEV cluster sat on
# `2026.6.16` — released never — for six weeks: the asset 404'd, bootstrap
# skipped the platform-ops install, the node got no converge timer, and its
# host-migrations could not run at all while the policy said `mode: enforce`.
#
# It also makes the promote snapshot idempotent. A `development → main` promote
# copies development's tree over main's, so a stale VERSION *reverts* main's
# stamp until cut-release rewrites it moments later. Keeping the two equal ends
# that oscillation.
#
# STABLE RELEASES ONLY — and that is a hard constraint, not a preference.
# build-deploy stamps the dev overlay's platform-version ConfigMap as
# `<VERSION>-<short-sha>`, and the backend accepts a version with at most ONE
# hyphenated suffix (VERSION_RE in platform-updates/service.ts). An RC would
# compose to `2026.8.3-rc.4-dd36418`, which that regex REJECTS — so
# persistInstalledVersion() would quietly stop writing
# `installed_platform_version`, and the upgrade spine would lose the very source
# of truth pre-flight gates on. During an RC cycle development therefore names
# the newest STABLE tag: still a real, published, signed asset.
#
# Usage:  sync-development-version.sh --tag vX.Y.Z[-rc.N] [--root DIR] [--write]
#   --tag    the release tag whose version is authoritative (required)
#   --root   repo root (default: this script's parent)
#   --write  write platform/VERSION in place (default: print what it would be)
#
# Exit: 0 wrote/would-write a change · 2 already in sync (no change) · 1 error
set -euo pipefail

TAG="" ROOT="" WRITE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)   TAG="$2"; shift 2 ;;
    --root)  ROOT="$2"; shift 2 ;;
    --write) WRITE=1; shift ;;
    -h|--help) sed -n '1,32p' "$0"; exit 0 ;;
    *) echo "sync-development-version: unknown arg '$1'" >&2; exit 1 ;;
  esac
done

[ -n "$TAG" ] || { echo "sync-development-version: --tag is required" >&2; exit 1; }
ROOT="${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
FILE="${ROOT}/platform/VERSION"
[ -r "$FILE" ] || { echo "sync-development-version: no platform/VERSION under ${ROOT}" >&2; exit 1; }

# Accept exactly what platform_ops_target_version() accepts, so we can never
# write a value bootstrap would then reject as unresolvable.
want="${TAG#v}"
if ! [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]]; then
  echo "sync-development-version: '${TAG}' is not a platform version tag (X.Y.Z or X.Y.Z-rc.N)" >&2
  exit 1
fi

# A prerelease is a valid tag but must never become development's VERSION (see
# the header: the `<VERSION>-<sha>` composite would stop parsing). No-op, not a
# failure — the release itself is fine.
if [[ "$want" == *-rc.* ]]; then
  echo "sync-development-version: ${TAG} is a prerelease — development tracks the stable line; nothing to do."
  exit 2
fi

have="$(tr -d '[:space:]' < "$FILE")"
if [ "$have" = "$want" ]; then
  echo "sync-development-version: platform/VERSION already ${want} — nothing to do."
  exit 2
fi

# Never move VERSION BACKWARDS. Re-running the workflow for an older tag, or a
# late-arriving job from a superseded RC, must not drag development back onto a
# version whose binary predates what is already published.
newest="$(printf '%s\n%s\n' "$have" "$want" | sed 's/-rc\./~rc./' | sort -V | tail -n1 | sed 's/~rc\./-rc./')"
if [ "$newest" != "$want" ]; then
  echo "sync-development-version: platform/VERSION is ${have}, newer than ${want} — refusing to move it backwards." >&2
  exit 2
fi

echo "sync-development-version: platform/VERSION ${have} → ${want}"
[ "$WRITE" -eq 1 ] || exit 0
printf '%s\n' "$want" > "$FILE"
exit 0
