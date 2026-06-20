#!/usr/bin/env python3
"""Summarise Trivy image-scan JSON reports + gate on unwaived HIGH/CRITICAL.

Reads every <dir>/*.json Trivy report, prints a Markdown table (image → HIGH /
CRITICAL counts) and exits non-zero if ANY HIGH/CRITICAL remains. Findings
already in security/cve-ledger.yaml are excluded upstream by the generated
.trivyignore, so anything left here is untriaged → triage in the ledger or
upgrade the pin (ADR-050).

Zero reports means every image scan failed (or none ran) — that is NOT a clean
result, so it exits 3 to keep the gate from silently passing.

Usage: trivy-scan-summary.py <reports-dir>   # writes Markdown to stdout
       exit 0 = clean, 1 = unwaived HIGH/CRITICAL, 2 = usage, 3 = no reports
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


def summarise(reports_dir: str) -> tuple[str, int]:
    paths = sorted(glob.glob(os.path.join(reports_dir, "*.json")))
    if not paths:
        return ("### Trivy image CVE scan\n\n**No reports found** — every image scan "
                "failed (pull/registry error) or none ran. This is NOT a clean result.\n"), 3
    rows = ["### Trivy image CVE scan (HIGH/CRITICAL, ledger-waived excluded)", "",
            "| image | HIGH | CRITICAL |", "|---|---:|---:|"]
    total = 0
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
        flag = "" if (high + crit) == 0 else " ⚠"
        rows.append(f"| `{img}`{flag} | {high} | {crit} |")
    rows.append("")
    rows.append("**clean — no unwaived HIGH/CRITICAL.**" if total == 0
                else f"**{total} unwaived HIGH/CRITICAL finding(s)** — triage in `security/cve-ledger.yaml` or upgrade the pin.")
    return "\n".join(rows) + "\n", (0 if total == 0 else 1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    md, code = summarise(sys.argv[1])
    sys.stdout.write(md)
    sys.exit(code)
