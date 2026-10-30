#!/usr/bin/env bash
# list-first-party-images.sh — emit the first-party images (ghcr.io/insulahq/*)
# that PRODUCTION runs, for the weekly Trivy image-CVE scan (image-cve-scan.yml).
#
# Each image is also scanned when it is built, but only then: an image nobody
# rebuilds keeps the CVEs of the day it was built. The panels ran a critical
# OpenSSL CVE for months that way. This lists what the production overlay pins
# (on main, cut-release stamps the release tags) so the weekly scan sees what
# production pulls today.
#
# Sources: the overlay's `images:` (name + newTag / digest) and the
# platform-config patch's `*-image:` values (images the API starts at runtime).
#
# The overlay is read at the newest STABLE release tag (PROD_REF overrides): the
# working tree's copy is only right on main. On development the production
# overlay still holds the stamps of the last release merged back — a dispatch
# from development scanned June's images and reported them as production's.
# Without tags (a shallow checkout) it falls back to the working tree and says so.
#
# Usage: scripts/list-first-party-images.sh [repo-root]   → one image ref per line
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
OVERLAY="$ROOT/k8s/overlays/production"
REF="${PROD_REF:-$(git -C "$ROOT" tag -l 'v*' 2>/dev/null | grep -v -- '-' | sort -V | tail -n1 || true)}"
if [ -n "$REF" ]; then
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
  for f in kustomization.yaml platform-config-patch.yaml; do
    git -C "$ROOT" show "${REF}:k8s/overlays/production/$f" > "$WORK/$f" 2>/dev/null || rm -f "$WORK/$f"
  done
  [ -s "$WORK/kustomization.yaml" ] || { echo "list-first-party-images: ${REF} has no production overlay" >&2; exit 1; }
  OVERLAY="$WORK"
  echo "list-first-party-images: production overlay at ${REF}" >&2
else
  echo "list-first-party-images: no release tag here — reading the working tree's production overlay" >&2
fi

python3 - "$OVERLAY" <<'PY'
import os, re, sys
overlay = sys.argv[1]
refs = set()
with open(os.path.join(overlay, "kustomization.yaml")) as f:
    text = f.read()
block = text.split("\nimages:\n", 1)[1] if "\nimages:\n" in text else ""
entry = None
for line in block.splitlines():
    if line and not line.startswith(" "):
        break  # next top-level key
    m = re.match(r"\s*- name:\s*(\S+)", line)
    if m:
        entry = {"name": m.group(1)}
        continue
    m = re.match(r"\s*(newTag|digest|newName):\s*\"?([^\"#\s]+)\"?", line)
    if m and entry is not None:
        entry[m.group(1)] = m.group(2)
        name = entry.get("newName", entry["name"])
        if name.startswith("ghcr.io/insulahq/") and ("newTag" in entry or "digest" in entry):
            ref = name + (":" + entry["newTag"] if "newTag" in entry else "") \
                + ("@" + entry["digest"] if "digest" in entry else "")
            refs.discard(name + ":" + entry.get("newTag", ""))
            refs.add(ref)
patch = os.path.join(overlay, "platform-config-patch.yaml")
if os.path.exists(patch):
    with open(patch) as f:
        for line in f:
            m = re.match(r"\s*[a-z0-9-]+-image:\s*\"?(ghcr\.io/insulahq/[^\"\s#]+)\"?", line)
            if m:
                refs.add(m.group(1))
for r in sorted(refs):
    print(r)
PY
