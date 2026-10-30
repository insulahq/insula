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
  hold           {below: "1.37", reason: "…"} — a deliberate ceiling: versions at
                 or above `below` are reported as held, with the reason, and the
                 pin is compared with the newest version under it (k3s stays on
                 1.36 while cert-manager does not support 1.37 — and 1.36.6 still
                 shows as behind)

Soak: a GitHub release younger than 7 days (14 when it changes the major — the
minor on 0.x) is reported as in soak until that date, and the pin is compared
with the newest release past it — the same minimum age .github/dependabot.yml's
cooldown applies, so the list never asks for a release the policy says to wait
for. A release that fixes a security advisory affecting us is taken inside the
soak by decision, not by this list. Docker Hub tags carry no publication date,
so no soak is applied to them.

A pin that is not a version (digest, `multiple`, `external`, `ci-pinned`, a
module path) is reported as not compared, with the reason — never as behind.
The previous check compared the newest release of any kind, so a chart version
read as behind its own app version and a PowerDNS alpha as an upgrade.

Usage: component-latest.py [repo-root] [--json]
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
import urllib.request

import yaml

SOAK_DAYS = 7
SOAK_MAJOR_DAYS = 14

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


def comparable(pinned: str, tag: str, tag_regex: str | None, docker: bool):
    """The tag's version numbers when it is a stable tag shaped like the pin, else None."""
    pin = split_version(pin_tag(pinned))
    if not pin or PRERELEASE.search(tag):
        return None
    p_prefix, p_nums, p_suffix = pin
    version = tag
    if tag_regex:
        m = re.match(tag_regex, tag)
        if not m:
            return None
        version = m.group(1)
    parts = split_version(version)
    if not parts:
        return None
    t_prefix, t_nums, t_suffix = parts
    if not tag_regex and not same_stream(p_prefix, t_prefix):
        return None
    if docker:
        # Docker tags: same suffix shape (`-alpine`, `-k3s1`, `-r3`), digits free.
        suffix_re = re.compile("^" + re.sub(r"\d+", r"\\d+", re.escape(p_suffix)) + "$")
        if len(t_nums) != len(p_nums) or not suffix_re.match(t_suffix):
            return None
    return t_nums


def newest(pinned: str, tags: list[str], tag_regex: str | None, docker: bool):
    """Newest stable tag comparable with the pin → (tag, numbers) or (None, None)."""
    best = (None, None)
    for tag in tags:
        t_nums = comparable(pinned, tag, tag_regex, docker)
        if t_nums is not None and (best[1] is None or t_nums > best[1]):
            best = (tag, t_nums)
    return best


def soak_days(pin_nums: tuple, nums: tuple) -> int:
    """7 days, 14 when the major moves (the minor, on 0.x)."""
    width = 2 if pin_nums and pin_nums[0] == 0 else 1
    return SOAK_MAJOR_DAYS if nums[:width] != pin_nums[:width] else SOAK_DAYS


def soak_end(published: str | None, pin_nums: tuple, nums: tuple) -> datetime.date | None:
    """The day a release leaves its soak, or None when it is out of it (or undated)."""
    if not published:
        return None
    try:
        day = datetime.date.fromisoformat(published[:10])
    except ValueError:
        return None
    end = day + datetime.timedelta(days=soak_days(pin_nums, nums))
    return end if end > TODAY else None


TODAY = datetime.date.today()


def is_behind(pinned_nums: tuple, latest_nums: tuple) -> bool:
    return latest_nums[: len(pinned_nums)] > pinned_nums


def _get(url: str, token: str = ""):
    headers = {"Accept": "application/vnd.github+json"}
    if token and "api.github.com" in url:
        headers["Authorization"] = f"Bearer {token}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
        return json.load(r)


def github_tags(repo: str, token: str) -> list[tuple[str, str | None]]:
    """(tag, published_at) of the repo's stable releases; bare tags (undated) without any."""
    try:
        rel = _get(f"https://api.github.com/repos/{repo}/releases?per_page=100", token)
        tags = [(r["tag_name"], r.get("published_at")) for r in rel if not r.get("draft") and not r.get("prerelease")]
        if tags:
            return tags
    except Exception:
        pass
    return [(t["name"], None) for t in _get(f"https://api.github.com/repos/{repo}/tags?per_page=100", token)]


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
            dated, docker = github_tags(row["repo"], token), False
        else:
            repo = "library/alpine" if kind == "alpine_secdb" else row["repo"]
            dated, docker = [(t, None) for t in dockerhub_tags(repo)], True
    except Exception as e:  # network / rate limit: say so, never "behind"
        row["note"] = f"lookup failed: {str(e)[:80]}"
        return row
    return compare(row, pinned, dated, w, docker)


def compare(row: dict, pinned: str, dated: list[tuple[str, str | None]], w: dict, docker: bool) -> dict:
    """Fill latest/behind (and held/soak) from the upstream (tag, published_at) list."""
    regex = w.get("tag_regex")
    tag, nums = newest(pinned, [t for t, _ in dated], regex, docker)
    if tag is None:
        row["note"] = "no upstream tag shaped like the pin"
        return row
    pin_nums = split_version(pin_tag(pinned))[1]
    hold = w.get("hold") or {}
    below = split_version(str(hold["below"]))[1] if hold.get("below") else None
    eligible: list[str] = []
    soaking: dict[str, datetime.date] = {}
    for t, published in dated:
        t_nums = comparable(pinned, t, regex, docker)
        if t_nums is None or (below is not None and t_nums[: len(below)] >= below):
            continue
        end = soak_end(published, pin_nums, t_nums)
        if end:
            soaking[t] = end
        else:
            eligible.append(t)
    e_tag, e_nums = newest(pinned, eligible, regex, docker)
    row.update(latest=tag, compared=True, behind=bool(e_nums) and is_behind(pin_nums, e_nums))
    if e_tag and e_tag != tag:
        row["eligible"] = e_tag
    if below is not None and nums[: len(below)] >= below:
        row["held"] = f"{tag} held below {hold['below']}: {hold.get('reason', 'no reason given')}"
    s_tag, s_nums = newest(pinned, list(soaking), regex, docker)
    if s_tag and is_behind(pin_nums, s_nums) and (not e_nums or s_nums > e_nums):
        row["soak_until"] = soaking[s_tag].isoformat()
        row["soak"] = s_tag
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
        marks = []
        if r["behind"]:
            marks.append("←behind" + (f" (take {r['eligible']})" if r.get("eligible") else ""))
        if r.get("soak"):
            marks.append(f"(soak: {r['soak']} until {r['soak_until']})")
        if r.get("held"):
            marks.append(f"(held: {r['held']})")
        if not r["compared"]:
            marks.append(f"(not compared: {r.get('note')})")
        print(f"{r['id']:<28} {r['pinned'][:25]:<26} {str(r['latest'] or '-')[:25]:<26} {' '.join(marks)}")
    behind = sum(1 for r in rows if r["behind"])
    compared = sum(1 for r in rows if r["compared"])
    soak = sum(1 for r in rows if r.get("soak"))
    held = sum(1 for r in rows if r.get("held"))
    print(f"\n{behind}/{compared} compared component(s) behind upstream; {soak} with a newer release in soak, {held} held"
          f" ({'authenticated' if token else 'unauthenticated — set GITHUB_TOKEN to avoid rate limits'})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
