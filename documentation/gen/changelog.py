#!/usr/bin/env python3
"""Generate the manual's changelog body from the repo CHANGELOG.md.

Rewrites repo-relative markdown links (RELEASING.md, docs/...) to absolute
GitHub URLs so the page builds strict-clean inside the site. Output is
git-ignored; CI and local builds run this before `mkdocs build`.
"""
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "CHANGELOG.md"
DST = ROOT / "documentation" / "docs" / ".changelog-body.md"
GH = "https://github.com/insulahq/insula/blob/main/"

body = SRC.read_text()


def rewrite(m: re.Match) -> str:
    target = m.group(1)
    if target.startswith(("http://", "https://", "#", "mailto:", "`")):
        return m.group(0)
    return f"]({GH}{target})"


body = re.sub(r"\]\(([^)]+)\)", rewrite, body)
DST.write_text(body)
print(f"wrote {DST.relative_to(ROOT)} ({len(body)} bytes)")
