#!/usr/bin/env bash
# ci-config-image-pin-check.sh — runtime-resolved images must not silently land
# on a mutable tag.
#
# THE PROBLEM
#   Job/sidecar images the BACKEND builds at runtime (mail-archive checkpoint,
#   file-manager, migration-tools, …) resolve through platform-config →
#   configMapKeyRef → env. The kustomization `images:` transformer cannot reach
#   them, so pin-image-tag.sh does not cover them and every one of them sat on
#   `:latest`. That is not theoretical here: the `is_default_branch` bug froze
#   `:latest` at its pre-cutover build on 2026-06-22 and every consumer silently
#   pulled a stale image for weeks.
#
#   Fixing them one at a time only helps if a NEW one cannot appear unnoticed —
#   which is why this guard fails on an unclassified key rather than only on a
#   known-bad one.
#
# THE RULE (development overlay — the one CI pins)
#   PINNED  keys MUST carry an @sha256: digest. Regressing one fails CI.
#   PENDING keys are known-mutable, listed WITH a reason. Deliberate debt, not
#           an oversight — each moves to PINNED as its build workflow is wired.
#   Anything in neither list fails: a new runtime image landed with no decision.
#
# Base and dind overlays are exempt by design: those values are bare names that
# local.sh imports into DinD's containerd, and there is no registry to digest
# against. Production is stamped at release time (ADR-053 pull model), not by a
# branch pin — tracked as PENDING until cut-release.sh does it.
#
# Exit: 0 clean · 1 violations
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

PATCH="k8s/overlays/development/platform-config-patch.yaml"
[[ -f "$PATCH" ]] || { echo "❌ ci-config-image-pin: $PATCH not found" >&2; exit 1; }

# Keys that MUST be digest-pinned in the development overlay.
PINNED=(
  rocksdb-secondary-checkpoint-image
)

# Known-mutable, with the reason. Shrink this list; never grow it silently.
declare -A PENDING=(
  [file-manager-image]="per-tenant sidecar; ci-file-manager.yml not yet wired to pin-config-image.sh"
  [private-worker-agent-image]="image tenants run at HOME, not in-cluster — a digest here would pin what we hand out, needs its own decision"
  [private-worker-frps-image]="THIRD-PARTY upstream (fatedier/frps), version-pinned not digest-pinned. We do not build it, so a digest means a manual bump on every upstream release with no CI to produce it — a different trade-off from our own images. Revisit with the Dependabot docker ecosystem."
)

violations=0
report=""

# Every `*-image:` key in the development overlay must be classified.
while IFS= read -r line; do
  key="$(printf '%s' "$line" | sed -E 's/^[[:space:]]*([a-z0-9-]+):.*/\1/')"
  val="$(printf '%s' "$line" | sed -E 's/^[^:]*:[[:space:]]*//; s/^"//; s/"$//')"
  [[ -n "$key" ]] || continue

  classified=0
  for p in "${PINNED[@]}"; do
    [[ "$key" == "$p" ]] || continue
    classified=1
    if [[ "$val" != *"@sha256:"* ]]; then
      report+="  $PATCH: '$key' is declared PINNED but has no @sha256: digest → $val"$'\n'
      violations=$((violations + 1))
    fi
  done
  if [[ -v PENDING[$key] ]]; then
    classified=1
    # A PENDING key that HAS been pinned should be promoted, not left lying.
    if [[ "$val" == *"@sha256:"* ]]; then
      report+="  $PATCH: '$key' is digest-pinned but still listed PENDING — move it to PINNED in $(basename "$0")"$'\n'
      violations=$((violations + 1))
    fi
  fi

  if (( ! classified )); then
    report+="  $PATCH: '$key' is a new runtime image with no pin decision."$'\n'
    report+="      Add it to PINNED (and wire its build workflow to pin-config-image.sh),"$'\n'
    report+="      or to PENDING with a reason, in scripts/$(basename "$0")."$'\n'
    violations=$((violations + 1))
  fi
done < <(grep -nE '^[[:space:]]*[a-z0-9-]+-image:' "$PATCH" | cut -d: -f2- | sed 's/^[0-9]*://')

if (( violations > 0 )); then
  echo "❌ ci-config-image-pin: $violations issue(s):" >&2
  printf '%s' "$report" >&2
  cat >&2 <<'EOF'

  Runtime-resolved images are pinned by their OWN build workflow, after the push:
    .github/scripts/pin-config-image.sh <config-key> "<repo>:<tag>@sha256:<digest>"
  See ci-rocksdb-secondary-checkpoint.yml for the reference wiring.
EOF
  exit 1
fi

echo "✅ ci-config-image-pin: ${#PINNED[@]} pinned, ${#PENDING[@]} pending-with-reason, no unclassified runtime images."
