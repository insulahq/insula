#!/usr/bin/env python3
"""Upstream container images that k8s/base names OUTSIDE an `image:` field.

list-scan-images.sh reads `image:` lines, and that is not every image a pod
runs. Three places hold one as plain data:

  * a CNPG Cluster's `spec.imageName` — the platform database. PostgreSQL
    18.3 ran with 14 fixable criticals that no scan saw;
  * a ConfigMap value whose key ends in `_IMAGE` / `-image` — e.g. the
    system-upgrade-controller's SYSTEM_UPGRADE_JOB_KUBECTL_IMAGE, the kubectl
    its node-drain Jobs run (upstream default: v1.30.3, a critical CVE);
  * a Secret value (base64) under such a key — the barman-cloud plugin's
    SIDECAR_IMAGE, the sidecar it injects into every Postgres pod.

Prints one `<file>\\t<image>` line per reference, like runtime-images.py and
script-images.py. First-party images (ghcr.io/insulahq/*), bare `name:latest`
and values with shell/Flux variables are left out, as list-scan-images.sh does.

Usage: config-images.py [repo-root]
"""
from __future__ import annotations

import base64
import os
import re
import sys

import yaml

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..")
IMAGE_KEY = re.compile(r"(_IMAGE|-image)$")
IMAGE_REF = re.compile(r"^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$")


def is_upstream_image(ref: str) -> bool:
    ref = ref.strip()
    if not ref or "$" in ref or not IMAGE_REF.match(ref):
        return False
    name = ref.split("@", 1)[0]
    if ":" not in name.rsplit("/", 1)[-1] and "@" not in ref:
        return False  # no tag, no digest: not an image reference
    if ref.startswith("ghcr.io/insulahq/"):
        return False
    return not ("/" not in name.split(":")[0] and name.endswith(":latest"))


def images_in_doc(doc: dict) -> list[str]:
    out: list[str] = []
    kind = doc.get("kind")
    spec = doc.get("spec") or {}
    if kind == "Cluster" and str(doc.get("apiVersion", "")).startswith("postgresql.cnpg.io/"):
        if isinstance(spec.get("imageName"), str):
            out.append(spec["imageName"])
    if kind == "ConfigMap":
        for key, val in (doc.get("data") or {}).items():
            if IMAGE_KEY.search(str(key)) and isinstance(val, str):
                out.append(val)
    if kind == "Secret":
        for key, val in (doc.get("stringData") or {}).items():
            if IMAGE_KEY.search(str(key)) and isinstance(val, str):
                out.append(val)
        for key, val in (doc.get("data") or {}).items():
            if IMAGE_KEY.search(str(key)) and isinstance(val, str):
                try:
                    out.append(base64.b64decode("".join(val.split())).decode())
                except Exception:
                    continue
    return [r.strip() for r in out if is_upstream_image(r)]


def main() -> int:
    base = os.path.join(ROOT, "k8s", "base")
    for root, _, files in os.walk(base):
        for fn in sorted(files):
            if not fn.endswith((".yaml", ".yml")):
                continue
            path = os.path.join(root, fn)
            try:
                with open(path, errors="replace") as f:
                    docs = list(yaml.safe_load_all(f))
            except yaml.YAMLError as e:
                # Say so: a file dropped here is a file the scan does not see.
                print(f"config-images: skipped {os.path.relpath(path, ROOT)} (not plain YAML: {str(e).splitlines()[0]})",
                      file=sys.stderr)
                continue
            for doc in docs:
                if isinstance(doc, dict):
                    for ref in images_in_doc(doc):
                        print(f"{os.path.relpath(path, ROOT)}\t{ref}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
