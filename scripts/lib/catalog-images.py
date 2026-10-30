#!/usr/bin/env python3
"""Images the default Official Catalog deploys into tenant namespaces.

The catalog is its own repository (github.com/insulahq/application-catalog,
seeded by backend/src/db/seed.ts) and builds its images there; nothing in that
repository scans them, and this one never listed them. They run in every tenant
that installs a runtime or database from the catalog (tier C in
security/components.yaml), so the weekly image scan covers them from here.

Reads catalog.json's entries, then each entry's manifest.json, and prints every
string under an `image` key (the entry's image, its components', and each
supportedVersions variant's) — one per line, sorted. A catalog that cannot be
read exits non-zero: an empty list is not a clean scan.

Usage: catalog-images.py [owner/repo] [ref]   (default insulahq/application-catalog main)
"""
from __future__ import annotations

import json
import sys
import urllib.request

REPO = sys.argv[1] if len(sys.argv) > 1 else "insulahq/application-catalog"
REF = sys.argv[2] if len(sys.argv) > 2 else "main"


def fetch(path: str) -> object:
    url = f"https://raw.githubusercontent.com/{REPO}/{REF}/{path}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.load(r)


def images(node: object) -> set[str]:
    found: set[str] = set()
    if isinstance(node, dict):
        for key, val in node.items():
            if key == "image" and isinstance(val, str) and val.strip():
                found.add(val.strip())
            else:
                found |= images(val)
    elif isinstance(node, list):
        for item in node:
            found |= images(item)
    return found


def main() -> int:
    catalog = fetch("catalog.json")
    entries = catalog.get("entries") if isinstance(catalog, dict) else None
    if not entries:
        print(f"catalog-images: no entries in {REPO}@{REF}/catalog.json", file=sys.stderr)
        return 1
    found: set[str] = set()
    for code in entries:
        try:
            found |= images(fetch(f"{code}/manifest.json"))
        except Exception as e:  # one unreadable entry must not hide the rest — but must fail
            print(f"catalog-images: {code}/manifest.json: {e}", file=sys.stderr)
            return 1
    for ref in sorted(found):
        print(ref)
    return 0


if __name__ == "__main__":
    sys.exit(main())
