#!/usr/bin/env python3
"""Summarise Trivy image-scan JSON reports + gate on unwaived findings.

Reads every <dir>/*.json Trivy report, prints a Markdown table (image → HIGH /
CRITICAL counts, CRITICAL ids) and exits non-zero if any HIGH/CRITICAL remains.
Findings already in security/cve-ledger.yaml are excluded upstream by the
generated ignore file, so anything left here is untriaged → triage in the
ledger or upgrade the pin (ADR-050). A CRITICAL exits 4 (the workflow fails on
it); HIGH alone exits 1 (reported, not failed).

Zero reports means every image scan failed (or none ran) — that is NOT a clean
result, so it exits 3 to keep the gate from silently passing.

Usage: trivy-scan-summary.py <reports-dir> [title]   # writes Markdown to stdout
       exit 0 = clean, 1 = unwaived HIGH only, 4 = unwaived CRITICAL,
       2 = usage, 3 = no reports
"""
import glob
import json
import os
import sys


def counts_for(report: dict) -> tuple[int, int, list[str]]:
    high = crit = 0
    ids: list[str] = []
    for r in report.get("Results", []) or []:
        for v in r.get("Vulnerabilities", []) or []:
            sev = v.get("Severity")
            if sev == "HIGH":
                high += 1
            elif sev == "CRITICAL":
                crit += 1
            else:
                continue
            vid = v.get("VulnerabilityID")
            if vid and vid not in ids:
                ids.append(vid)
    return high, crit, ids


def critical_ids(report: dict) -> list[str]:
    ids: list[str] = []
    for r in report.get("Results", []) or []:
        for v in r.get("Vulnerabilities", []) or []:
            vid = v.get("VulnerabilityID")
            if v.get("Severity") == "CRITICAL" and vid and vid not in ids:
                ids.append(vid)
    return ids


def summarise(reports_dir: str, title: str = "Trivy image CVE scan") -> tuple[str, int]:
    paths = sorted(glob.glob(os.path.join(reports_dir, "*.json")))
    if not paths:
        return (f"### {title}\n\n**No reports found** — every image scan "
                "failed (pull/registry error) or none ran. This is NOT a clean result.\n"), 3
    rows = [f"### {title} (HIGH/CRITICAL, ledger-waived excluded)", "",
            "| image | HIGH | CRITICAL | CRITICAL ids |", "|---|---:|---:|---|"]
    total = crits = 0
    for path in paths:
        try:
            with open(path) as f:
                report = json.load(f)
        except (OSError, ValueError):
            rows.append(f"| `{os.path.basename(path)}` (unreadable) | ? | ? |")
            continue
        img = report.get("ArtifactName") or os.path.basename(path)
        high, crit, _ = counts_for(report)
        total += high + crit
        crits += crit
        flag = "" if (high + crit) == 0 else (" 🛑" if crit else " ⚠")
        ids = critical_ids(report)
        shown = ", ".join(ids[:6]) + (f" (+{len(ids) - 6})" if len(ids) > 6 else "")
        rows.append(f"| `{img}`{flag} | {high} | {crit} | {shown} |")
    rows.append("")
    rows.append("**clean — no unwaived HIGH/CRITICAL.**" if total == 0
                else f"**{total} unwaived HIGH/CRITICAL finding(s), {crits} CRITICAL** — triage in "
                     "`security/cve-ledger.yaml` or upgrade the pin.")
    return "\n".join(rows) + "\n", (0 if total == 0 else (4 if crits else 1))


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    md, code = summarise(sys.argv[1], *sys.argv[2:])
    sys.stdout.write(md)
    sys.exit(code)
