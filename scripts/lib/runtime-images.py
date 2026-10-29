#!/usr/bin/env python3
"""Upstream container images that platform-api creates at RUNTIME.

The image scan (list-scan-images.sh) and the component registry check
(ci-component-watch-check.sh) read image pins from the manifests under k8s/.
Images the backend writes into pods itself — the route sign-in's oauth2-proxy,
helper Jobs, init containers — are string literals in TypeScript, and neither
saw them: the route sign-in ran oauth2-proxy v7.6.0, with published
authentication-bypass advisories, while the registry said v7.15.5.

Prints one `<file>\t<image>` line per image literal found in backend/src
(tests excluded). An image literal is a quoted `[registry/]name[/name]:tag` on
a code line that mentions an image (or follows one that does). First-party
images (ghcr.io/insulahq/*) and local `name:latest` / `name:test` tags are left
out, like list-scan-images.sh does for k8s/.

Usage: runtime-images.py [repo-root]
"""
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..")
SRC = os.path.join(ROOT, "backend", "src")
IMAGE_HINT = re.compile(r"image", re.I)
# The whole string literal is the image ('…' or "…"): an example inside a
# longer message (`nginx:1.27.3` in a hint) is not one.
QUOTED = re.compile(r"""(['"])([a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:/[a-z0-9][a-z0-9._-]*)*:[A-Za-z0-9][A-Za-z0-9._-]*)\1""")
COMMENT = re.compile(r"^\s*(\*|//|/\*)")


def images_in(path: str) -> list[str]:
    out: list[str] = []
    with open(path, errors="replace") as f:
        lines = f.read().splitlines()
    for i, line in enumerate(lines):
        if COMMENT.match(line):
            continue
        code = line.split("//", 1)[0] if "://" not in line else line
        if not (IMAGE_HINT.search(code) or (i > 0 and IMAGE_HINT.search(lines[i - 1]) and not COMMENT.match(lines[i - 1]))):
            continue
        for m in QUOTED.finditer(code):
            ref = m.group(2)
            if ref.startswith("node:"):
                continue  # a Node built-in module, not an image
            name = ref.rsplit(":", 1)[0]
            tag = ref.rsplit(":", 1)[1]
            if ref.startswith("ghcr.io/insulahq/"):
                continue
            if "/" not in name and tag in ("latest", "test"):
                continue
            # A port in a URL (`host:8080`) is not an image.
            if tag.isdigit() and "/" not in name:
                continue
            out.append(ref)
    return out


def main() -> int:
    for dirpath, _, files in os.walk(SRC):
        for fn in sorted(files):
            if not fn.endswith(".ts") or fn.endswith(".test.ts") or fn.endswith(".d.ts"):
                continue
            if "/test-helpers" in dirpath or "/__tests__" in dirpath:
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, ROOT)
            for ref in images_in(path):
                print(f"{rel}\t{ref}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
