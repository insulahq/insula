#!/usr/bin/env python3
"""Tests for scripts/lib/component-latest.py (offline: version logic only).

Plain-python (no pytest), matching scripts/test-trivy-helpers.py. Run:
    python3 scripts/test-component-latest.py
Exit 0 = all pass, 1 = a failure.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("component_latest", os.path.join(HERE, "lib", "component-latest.py"))
cl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cl)

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        failures.append(name)


# Docker tags: same shape as the pin, newest wins, compared at the pin's precision.
hap = ["3.2-alpine", "3.4-alpine", "3.3-alpine", "3.4.7-alpine", "3.5-dev10-alpine", "latest", "3.4"]
tag, nums = cl.newest("3.4-alpine", hap, None, docker=True)
check("docker: picks the newest same-shape tag, skips -dev", tag == "3.4-alpine" and nums == (3, 4))
check("docker: 3.4-alpine is not behind itself", not cl.is_behind((3, 4), nums))
tag, nums = cl.newest("2.9-alpine", hap, None, docker=True)
check("docker: 2.9-alpine is behind 3.4-alpine", tag == "3.4-alpine" and cl.is_behind((2, 9), nums))
tag, _ = cl.newest("alpine3.23-r3", ["alpine3.23-r3", "alpine3.24-r1", "alpine3.24", "alpine"], None, docker=True)
check("docker: an -rN suffix keeps its shape", tag == "alpine3.24-r1")

# GitHub releases: one tag stream; v-prefix optional; prereleases skipped.
tags = ["chart-v2.2.19", "v1.4.23", "v1.4.22", "v2.0.0-beta.2"]
tag, nums = cl.newest("v1.4.22", tags, None, docker=False)
check("github: a chart-v tag is another stream", tag == "v1.4.23")
check("github: v1.4.22 is behind v1.4.23", cl.is_behind((1, 4, 22), nums))
tag, _ = cl.newest("1.75.2", ["v1.75.2", "v1.76.0-beta"], None, docker=False)
check("github: v-prefix is the same stream, beta skipped", tag == "v1.75.2")
tag, nums = cl.newest("v1.36.5+k3s1", ["v1.37.1+k3s1", "v1.36.5+k3s1"], None, docker=False)
check("github: k3s build metadata", tag == "v1.37.1+k3s1" and cl.is_behind((1, 36, 5), nums))

# tag_regex: chart tags, release- / curl- prefixes, one major line.
tag, nums = cl.newest("0.29.1", ["cluster-v0.9.0", "cloudnative-pg-v0.29.1", "v1.30.1"],
                      r"^cloudnative-pg-v(\d+\.\d+\.\d+)$", docker=False)
check("tag_regex: the chart stream, not the app's v1.30.1", tag == "cloudnative-pg-v0.29.1" and not cl.is_behind((0, 29, 1), nums))
tag, nums = cl.newest("8.21.0", ["curl-8_23_0", "curl-8_22_0"], r"^curl-(\d+_\d+_\d+)$", docker=False)
check("tag_regex: curl's underscores", nums == (8, 23, 0) and cl.is_behind((8, 21, 0), nums))
tag, nums = cl.newest("node:22-alpine", ["v26.13.0", "v22.23.4", "v22.22.0"], r"^v(22\.\d+\.\d+)$", docker=False)
check("tag_regex: one major line, and the image prefix of the pin", tag == "v22.23.4" and not cl.is_behind((22,), nums))

# Pins that are not versions are never "behind".
for pin in ("sha256:4a76", "multiple", "external", "ci-pinned", "latest", "github.com/insulahq/insula/x"):
    row = cl.check({"id": "x", "pinned": pin, "watch": {"type": "github_releases", "repo": "a/b"}}, "")
    check(f"not a version: {pin}", row["compared"] is False and row["behind"] is False and row.get("note"))
row = cl.check({"id": "x", "pinned": "1.0", "watch": {"type": "manual"}}, "")
check("manual watch is not compared", row["compared"] is False)

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all component-latest tests passed")
