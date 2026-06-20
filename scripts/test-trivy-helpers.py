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
    check("summarise with findings → exit 1", code2 == 1)
    check("summarise reports the image name", "docker.io/x/y:1" in md2)
    check("summarise flags the row", "⚠" in md2)
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
