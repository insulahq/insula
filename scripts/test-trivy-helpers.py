#!/usr/bin/env python3
"""Tests for the image-CVE-scan helpers (ADR-050 / image-cve-scan.yml).

Plain-python (no pytest), matching the repo convention
(images/tenant-backup-tools/test-plesk-maildir-reshape.py). Run:
    python3 scripts/test-trivy-helpers.py
Exit 0 = all pass, 1 = a failure.
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ign = load("ledger_trivyignore", "cve-ledger-trivyignore.py")
summ = load("trivy_scan_summary", "trivy-scan-summary.py")

failures = []


def check(name, cond):
    print(("PASS" if cond else "FAIL"), name)
    if not cond:
        failures.append(name)


# ── cve-ledger-trivyignore ──
led = {"entries": [
    {"id": "CVE-2026-1", "aliases": ["GHSA-aaaa"]},
    {"id": "GHSA-bbbb"},
    {"id": "CVE-2026-1"},          # duplicate id
    {"aliases": ["CVE-2026-2"]},   # alias only, no id
]}
ids = ign.tracked_ids(led)
check("tracked_ids collects ids + aliases, deduped + sorted",
      ids == ["CVE-2026-1", "CVE-2026-2", "GHSA-aaaa", "GHSA-bbbb"])
check("tracked_ids tolerates empty ledger", ign.tracked_ids({}) == [])
rendered = ign.render(led)
check("render has the header comment", rendered.splitlines()[0].startswith("#"))
check("render lists every tracked id", all(i in rendered for i in ids))
check("render of empty ledger is header only", ign.render({}).strip().startswith("#") and len(ign.render({}).strip().splitlines()) == 1)

import yaml
scoped = {"entries": [
    {"id": "CVE-2026-9", "status": "accepted"},
    {"id": "CVE-2025-68121", "status": "not_affected", "trivy_scope": {"paths": ["usr/bin/kustomize"]}},
    {"id": "GHSA-cccc", "aliases": ["CVE-2026-7"], "status": "accepted",
     "trivy_scope": {"purls": ["pkg:pypi/certifi@2026.6.17"]}},
]}
check("a scoped entry is not waived everywhere", ign.tracked_ids(scoped) == ["CVE-2026-9"])
check("the plain format leaves a scoped entry out", "CVE-2025-68121" not in ign.render(scoped))
rules = yaml.safe_load(ign.render_yaml(scoped))["vulnerabilities"]
by_id = {r["id"]: r for r in rules}
check("yaml keeps the unscoped id bare", by_id["CVE-2026-9"] == {"id": "CVE-2026-9"})
check("yaml scopes the id to its paths", by_id["CVE-2025-68121"]["paths"] == ["usr/bin/kustomize"])
check("yaml scopes id + aliases to their purls",
      by_id["GHSA-cccc"]["purls"] == ["pkg:pypi/certifi@2026.6.17"]
      and by_id["CVE-2026-7"]["purls"] == ["pkg:pypi/certifi@2026.6.17"])
check("yaml of an empty ledger has no rules", yaml.safe_load(ign.render_yaml({}))["vulnerabilities"] == [])

# ── trivy-scan-summary ──
report = {"ArtifactName": "docker.io/x/y:1", "Results": [
    {"Vulnerabilities": [
        {"Severity": "HIGH", "VulnerabilityID": "CVE-A"},
        {"Severity": "CRITICAL", "VulnerabilityID": "CVE-B"},
        {"Severity": "MEDIUM", "VulnerabilityID": "CVE-C"},   # ignored
        {"Severity": "HIGH", "VulnerabilityID": "CVE-A"},     # dup id
    ]},
]}
h, c, vids = summ.counts_for(report)
check("counts_for counts HIGH", h == 2)
check("counts_for counts CRITICAL", c == 1)
check("counts_for ignores MEDIUM/LOW", "CVE-C" not in vids)
check("counts_for dedups ids", vids == ["CVE-A", "CVE-B"])
check("counts_for: empty report → zero", summ.counts_for({}) == (0, 0, []))

# summarise gate: write reports to a temp dir
import json
import tempfile
with tempfile.TemporaryDirectory() as d:
    md, code = summ.summarise(d)
    check("summarise empty dir → no-reports, exit 3 (not a false clean)",
          code == 3 and "No reports" in md)
    # a clean report (no HIGH/CRITICAL) → exit 0
    with open(os.path.join(d, "clean.json"), "w") as f:
        json.dump({"ArtifactName": "x/clean:1", "Results": []}, f)
    md_clean, code_clean = summ.summarise(d)
    check("summarise with a clean report → exit 0", code_clean == 0 and "clean" in md_clean)
    with open(os.path.join(d, "img.json"), "w") as f:
        json.dump(report, f)
    md2, code2 = summ.summarise(d)
    check("summarise with a CRITICAL → exit 4", code2 == 4)
    check("summarise lists the CRITICAL id", "CVE-B" in md2)
    check("summarise reports the image name", "docker.io/x/y:1" in md2)
    check("summarise flags a CRITICAL row", "🛑" in md2)
    with tempfile.TemporaryDirectory() as d2:
        with open(os.path.join(d2, "high.json"), "w") as f:
            json.dump({"ArtifactName": "x/high:1", "Results": [{"Vulnerabilities": [
                {"Severity": "HIGH", "VulnerabilityID": "CVE-H"}]}]}, f)
        md_h, code_h = summ.summarise(d2, "First-party images")
        check("summarise with HIGH only → exit 1", code_h == 1)
        check("summarise uses the given title", "First-party images" in md_h)
    # unreadable / non-JSON report → row marked, still gated by real findings
    with open(os.path.join(d, "broken.json"), "w") as f:
        f.write("{not json")
    md3, _ = summ.summarise(d)
    check("summarise marks an unreadable report", "unreadable" in md3)

print()
if failures:
    print(f"{len(failures)} FAILED: {failures}")
    sys.exit(1)
print("all trivy-helper tests passed")
