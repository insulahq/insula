#!/usr/bin/env python3
"""Which registry components are behind their upstream (component-watch.sh --latest).

For each component in security/components.yaml, find the newest STABLE upstream
version shaped like the pin and compare at the pin's precision: `3.4-alpine`
is not behind 3.4.7, `v1.36.5+k3s1` is behind v1.37.1+k3s1.

Watch types:
  github_releases      repo's releases (drafts + prereleases skipped)
  dockerhub/docker_hub Docker Hub tags shaped like the pinned tag
  alpine_secdb         Docker Hub library/alpine tags
Optional per-component `watch:` keys:
  version_repo   read versions from this repo instead of `repo` (a Helm chart
                 released from its own repo, e.g. cloudnative-pg/charts)
  tag_regex      only tags matching it; group 1 is the version (chart tags next
                 to app tags in one repo, `release-1.31.8`, `curl-8_23_0`)
  pinned_version the version a digest pin stands for (a digest cannot be compared)

A pin that is not a version (digest, `multiple`, `external`, `ci-pinned`, a
module path) is reported as not compared, with the reason — never as behind.
The previous check compared the newest release of any kind, so a chart version
read as behind its own app version and a PowerDNS alpha as an upgrade.

Usage: component-latest.py [repo-root] [--json]
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request

import yaml

PRERELEASE = re.compile(r"(alpha|beta|rc|dev|pre|preview|nightly|snapshot|canary)", re.I)
NOT_A_VERSION = re.compile(r"^(sha256:|multiple$|external$|ci-pinned$|latest$|[a-z0-9.-]+\.[a-z]{2,}/)", re.I)


def split_version(tag: str):
    """(prefix, numbers, suffix) of the first dotted/underscored number run, or None."""
    m = re.match(r"^(\D*?)(\d+(?:[._]\d+)*)(.*)$", tag)
    if not m:
        return None
    nums = tuple(int(x) for x in re.split(r"[._]", m.group(2)))
    return m.group(1), nums, m.group(3)


def pin_tag(pinned: str) -> str:
    """The version part of a pin: `nginx:1.30-alpine` → `1.30-alpine`."""
    return pinned.rsplit(":", 1)[1] if ":" in pinned and "/" not in pinned.split(":", 1)[1] else pinned


def same_stream(pin_prefix: str, tag_prefix: str) -> bool:
    """`v1.2` and `1.2` are one stream; `chart-v2.2` and `release-1.31` are not."""
    return pin_prefix.removesuffix("v") == tag_prefix.removesuffix("v")


def newest(pinned: str, tags: list[str], tag_regex: str | None, docker: bool):
    """Newest stable tag comparable with the pin → (tag, numbers) or (None, None)."""
    pin = split_version(pin_tag(pinned))
    if not pin:
        return None, None
    p_prefix, p_nums, p_suffix = pin
    # Docker tags: same suffix shape (`-alpine`, `-k3s1`, `-r3`), digits free.
    suffix_re = re.compile("^" + re.sub(r"\d+", r"\\d+", re.escape(p_suffix)) + "$") if docker else None
    best = (None, None)
    for tag in tags:
        if PRERELEASE.search(tag):
            continue
        version = tag
        if tag_regex:
            m = re.match(tag_regex, tag)
            if not m:
                continue
            version = m.group(1)
        parts = split_version(version)
        if not parts:
            continue
        t_prefix, t_nums, t_suffix = parts
        if not tag_regex and not same_stream(p_prefix, t_prefix):
            continue
        if docker and (len(t_nums) != len(p_nums) or not suffix_re.match(t_suffix)):
            continue
        if best[1] is None or t_nums > best[1]:
            best = (tag, t_nums)
    return best


def is_behind(pinned_nums: tuple, latest_nums: tuple) -> bool:
    return latest_nums[: len(pinned_nums)] > pinned_nums


def _get(url: str, token: str = ""):
    headers = {"Accept": "application/vnd.github+json"}
    if token and "api.github.com" in url:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
        return json.load(r)


def github_tags(repo: str, token: str) -> list[str]:
    try:
        rel = _get(f"https://api.github.com/repos/{repo}/releases?per_page=100", token)
        tags = [r["tag_name"] for r in rel if not r.get("draft") and not r.get("prerelease")]
        if tags:
            return tags
    except Exception:
        pass
    return [t["name"] for t in _get(f"https://api.github.com/repos/{repo}/tags?per_page=100", token)]


def dockerhub_tags(repo: str) -> list[str]:
    repo = repo if "/" in repo else f"library/{repo}"
    url = f"https://hub.docker.com/v2/repositories/{repo}/tags?page_size=100&ordering=last_updated"
    tags: list[str] = []
    for _ in range(3):
        page = _get(url)
        tags += [t["name"] for t in page.get("results") or []]
        url = page.get("next")
        if not url:
            break
    return tags


def check(component: dict, token: str) -> dict:
    w = component.get("watch") or {}
    kind = w.get("type")
    pinned = str(w.get("pinned_version") or component.get("pinned", ""))
    row = {"id": component["id"], "tier": component.get("tier"), "repo": w.get("version_repo") or w.get("repo"),
           "pinned": str(component.get("pinned", "")), "latest": None, "behind": False, "compared": False}
    if kind not in ("github_releases", "dockerhub", "docker_hub", "alpine_secdb"):
        row["note"] = f"watch type {kind!r}"
        return row
    if NOT_A_VERSION.match(pinned) or not split_version(pin_tag(pinned)):
        row["note"] = "pin is not a version" + (" (set watch.pinned_version)" if pinned.startswith("sha256:") else "")
        return row
    try:
        if kind == "github_releases":
            tags, docker = github_tags(row["repo"], token), False
        else:
            repo = "library/alpine" if kind == "alpine_secdb" else row["repo"]
            tags, docker = dockerhub_tags(repo), True
    except Exception as e:  # network / rate limit: say so, never "behind"
        row["note"] = f"lookup failed: {str(e)[:80]}"
        return row
    tag, nums = newest(pinned, tags, w.get("tag_regex"), docker)
    if tag is None:
        row["note"] = "no upstream tag shaped like the pin"
        return row
    row.update(latest=tag, compared=True, behind=is_behind(split_version(pin_tag(pinned))[1], nums))
    return row


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--json"]
    root = args[0] if args else os.path.join(os.path.dirname(__file__), "..", "..")
    with open(os.path.join(root, "security", "components.yaml")) as f:
        reg = yaml.safe_load(f)
    token = os.environ.get("GITHUB_TOKEN", "")
    rows = [check(c, token) for c in reg.get("components") or []]
    if "--json" in sys.argv[1:]:
        print(json.dumps(rows, indent=2))
        return 0
    print(f"{'COMPONENT':<28} {'PINNED':<26} {'UPSTREAM':<26}")
    print("-" * 82)
    for r in sorted(rows, key=lambda r: (not r["behind"], not r["compared"], str(r["tier"]), r["id"])):
        mark = "←behind" if r["behind"] else ("" if r["compared"] else f"(not compared: {r.get('note')})")
        print(f"{r['id']:<28} {r['pinned'][:25]:<26} {str(r['latest'] or '-')[:25]:<26} {mark}")
    behind = sum(1 for r in rows if r["behind"])
    compared = sum(1 for r in rows if r["compared"])
    print(f"\n{behind}/{compared} compared component(s) behind upstream"
          f" ({'authenticated' if token else 'unauthenticated — set GITHUB_TOKEN to avoid rate limits'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
