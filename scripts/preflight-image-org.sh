#!/usr/bin/env bash
# preflight-image-org.sh — repoint the platform's container-image org for a fork.
#
# The platform's images live at the CANONICAL org `ghcr.io/insulahq/insula/*`.
# Workflows derive their push org from `${{ github.repository }}` automatically,
# so a fork's CI publishes to the fork's OWN GHCR with no edits. But the static
# kustomize overlays (`k8s/overlays/*/kustomization.yaml`) cannot reference the
# GitHub context — they hardcode the canonical org. A fork deploying to a REAL
# cluster (via bootstrap.sh + Flux) must therefore repoint those overlays to the
# org where its CI actually pushed. This script does exactly that, idempotently.
#
# Local dev (`scripts/local.sh up`) does NOT need this — it builds images locally
# and imports them into k3s under the canonical tag, never pulling from GHCR.
#
# Usage:
#   scripts/preflight-image-org.sh [--owner OWNER/REPO] [--check] [--root DIR]
#
#   --owner OWNER/REPO   Target GHCR repo slug (e.g. myorg/myfork). If omitted,
#                        falls back to $IMAGE_REGISTRY_OWNER, then to the
#                        owner/repo parsed from `git remote get-url origin`.
#   --check              Report only; exit 3 if a repoint is pending, 0 if the
#                        overlays already match the target (or target==canonical).
#   --root DIR           Repo root to operate on (default: this script's parent).
#
# Exit: 0 ok / aligned · 2 usage or resolution error · 3 (--check) repoint pending
set -euo pipefail

CANONICAL_OWNER="insulahq/insula"
CANONICAL_PREFIX="ghcr.io/${CANONICAL_OWNER}"

owner="" check=0 root=""
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) [ $# -ge 2 ] || { echo "preflight-image-org: --owner requires a value" >&2; exit 2; }; owner="$2"; shift 2 ;;
    --owner=*) owner="${1#*=}"; shift ;;
    --check) check=1; shift ;;
    --root) [ $# -ge 2 ] || { echo "preflight-image-org: --root requires a value" >&2; exit 2; }; root="$2"; shift 2 ;;
    --root=*) root="${1#*=}"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "preflight-image-org: unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$root" ] || root=$(cd "$(dirname "$0")/.." && pwd)

# Resolve the target owner: --owner > $IMAGE_REGISTRY_OWNER > git origin slug.
if [ -z "$owner" ]; then
  owner="${IMAGE_REGISTRY_OWNER:-}"
fi
if [ -z "$owner" ]; then
  remote=$(git -C "$root" remote get-url origin 2>/dev/null || true)
  if [ -n "$remote" ]; then
    # strip trailing .git, then keep the final two path components (owner/repo)
    owner=$(printf '%s' "$remote" | sed -E 's#\.git$##; s#^.*[:/]([^/]+/[^/]+)$#\1#')
  fi
fi
if [ -z "$owner" ]; then
  echo "preflight-image-org: cannot resolve target owner (pass --owner OWNER/REPO" \
       "or set IMAGE_REGISTRY_OWNER, or run inside a git repo with an origin)" >&2
  exit 2
fi

# Validate the owner before it reaches sed. GitHub owner/repo names are
# [A-Za-z0-9._-]; rejecting anything else both catches typos (e.g. a bare org
# with no /repo) and guarantees the value cannot contain the sed delimiter '#'
# or any regex/path metacharacter.
if ! printf '%s' "$owner" | grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
  echo "preflight-image-org: invalid owner '$owner' (expected OWNER/REPO, e.g. myorg/myfork)" >&2
  exit 2
fi

target_prefix="ghcr.io/${owner}"

# The canonical org is hardcoded across the whole kustomize deploy surface —
# overlays (the `images:` blocks) AND base manifests (sidecar/runtime images
# like firewall-reconciler, mail-backup-tools, sftp-gateway, and the runtime
# image refs the backend reads from platform-config). Repoint them all. Because
# we only ever substitute the literal `ghcr.io/insulahq/insula/` prefix,
# third-party ghcr images (cloudnative-pg, bulwarkmail, stakater, …) are never
# touched.
#
# NOT covered (documented in docs/development/FORK-AND-DEPLOY.md): Flux
# ImageRepository/ImagePolicy CRs, and backend image defaults baked into the
# compiled image (override via the *_IMAGE envs). A future PR consolidates these
# behind a single IMAGE_PREFIX.
if [ ! -d "$root/k8s" ]; then
  echo "preflight-image-org: no k8s/ tree found under $root" >&2
  exit 2
fi
mapfile -t manifests < <(find "$root/k8s" -type f -name '*.yaml' | sort)
if [ ${#manifests[@]} -eq 0 ]; then
  echo "preflight-image-org: no manifests found under $root/k8s" >&2
  exit 2
fi

# Nothing to do if the fork IS the canonical repo.
if [ "$owner" = "$CANONICAL_OWNER" ]; then
  [ "$check" -eq 1 ] && exit 0
  echo "preflight-image-org: target is the canonical org ($CANONICAL_OWNER) — no changes."
  exit 0
fi

pending=0 changed=0
for f in "${manifests[@]}"; do
  if grep -q "${CANONICAL_PREFIX}/" "$f"; then
    pending=$((pending+1))
    if [ "$check" -eq 0 ]; then
      # '#' is a safe sed delimiter — neither prefix contains it. The trailing
      # '/' scopes the match to the canonical org, never third-party ghcr orgs.
      sed -i "s#${CANONICAL_PREFIX}/#${target_prefix}/#g" "$f"
      changed=$((changed+1))
      echo "  repointed ${f#"$root"/} → ${target_prefix}/*"
    fi
  fi
done

if [ "$check" -eq 1 ]; then
  if [ "$pending" -gt 0 ]; then
    echo "preflight-image-org: $pending overlay(s) still point at ${CANONICAL_PREFIX}" \
         "(target ${target_prefix}) — run without --check to repoint." >&2
    exit 3
  fi
  exit 0
fi

if [ "$changed" -eq 0 ]; then
  echo "preflight-image-org: overlays already aligned with ${target_prefix} — nothing to do."
fi
exit 0
