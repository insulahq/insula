#!/usr/bin/env python3
"""Upstream container images written into manifests by shell: bootstrap.sh and
the host migrations (platform/host-migrations/**/*.sh).

The image scan and the component registry read k8s/ and, through
runtime-images.py, the backend. bootstrap.sh and the host migrations apply
manifests and Helm values of their own (Traefik's init containers, install-time
pods), and those images were in neither: Traefik's init containers ran
alpine/k8s 1.33.13 and the install pods alpine 3.20 while nothing listed them.

Prints one `<file>\\t<image>` line per literal `image: <ref>` (YAML) or
`"image": "<ref>"` (JSON) on a non-comment line. References built from shell
variables (`${…}`), first-party images (ghcr.io/insulahq/*) and bare
`name:latest` are left out, like list-scan-images.sh does for k8s/.

Usage: script-images.py [repo-root]
"""
import glob
import os
import re
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..")
IMAGE = re.compile(r"""(?:^\s*-?\s*image:\s*["']?|"image"\s*:\s*")([^"'\s,}]+)""")


SUPERSEDED = re.compile(r"^# superseded-images:\s*([^(]*)")


def images_in(path: str) -> list[str]:
    """Images the file writes, less those its `# superseded-images:` header names.

    A shipped host migration's body never changes, so an image a LATER migration
    replaces (Traefik's init containers: alpine/k8s 1.33.13 → curlimages/curl in
    2026.10.23/0004) stays in its text. The header says so; listing that image
    would keep a replaced version in the scan and in the registry for good.
    ci-host-migrations-check.sh checks the header names a real migration.
    """
    out: list[str] = []
    superseded: set[str] = set()
    with open(path, errors="replace") as f:
        for line in f:
            m = SUPERSEDED.match(line)
            if m:
                superseded.update(m.group(1).split())
                continue
            if line.lstrip().startswith("#"):
                continue
            for m in IMAGE.finditer(line):
                ref = m.group(1)
                if "$" in ref or ref.startswith("ghcr.io/insulahq/") or ":" not in ref.split("/")[-1]:
                    continue
                if "/" not in ref.split(":")[0] and ref.endswith(":latest"):
                    continue
                out.append(ref)
    return [r for r in out if r not in superseded]


def main() -> int:
    files = [os.path.join(ROOT, "scripts", "bootstrap.sh")]
    files += sorted(glob.glob(os.path.join(ROOT, "scripts", "lib", "bootstrap-*.sh")))
    files += sorted(glob.glob(os.path.join(ROOT, "platform", "host-migrations", "**", "*.sh"), recursive=True))
    for path in files:
        if not os.path.exists(path):
            continue
        for ref in images_in(path):
            print(f"{os.path.relpath(path, ROOT)}\t{ref}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
