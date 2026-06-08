#!/usr/bin/env python3
"""Fail CI on a new HIGH/CRITICAL OSV finding not waived in the CVE ledger.

Usage: component-watch-gate.py <osv.json> <cve-ledger.yaml>

The gate fails only on **untracked** HIGH/CRITICAL findings — i.e. a finding whose
OSV ids/aliases match NO ledger entry. Any ledger entry (any status, including
`open`) marks a finding as tracked and suppresses it here; timely remediation of
`open` items is enforced separately by the SLA check in
scripts/ci-component-watch-check.sh + surfaced in the weekly sweep issue. This
keeps CI mergeable while a triaged backlog is burned down. HIGH/CRITICAL = CVSS
base score >= 7.0 (osv-scanner group max_severity); unknown-severity findings are
warnings, not failures. Part of ADR-050.
"""
import json
import sys

# Any valid ledger status means the finding is *tracked* → suppressed here.
TRACKED_STATUSES = {"open", "investigating", "mitigated", "not_affected",
                    "accepted", "fixed"}


def main() -> int:
    osv_path, ledger_path = sys.argv[1], sys.argv[2]
    try:
        import yaml
    except Exception as e:  # pragma: no cover
        print(f"component-watch-gate: pyyaml required ({e})", file=sys.stderr)
        return 2

    try:
        with open(osv_path) as f:
            osv = json.load(f)
    except (OSError, json.JSONDecodeError):
        print("component-watch-gate: no/*empty* osv.json — treating as no findings.")
        return 0

    try:
        with open(ledger_path) as f:
            ledger = yaml.safe_load(f) or {}
    except (OSError, yaml.YAMLError) as e:
        print(f"component-watch-gate: cannot read ledger {ledger_path}: {e}", file=sys.stderr)
        return 2
    tracked = {
        str(e.get("id"))
        for e in (ledger.get("entries") or [])
        if e.get("status") in TRACKED_STATUSES and e.get("id")
    }

    blocking, warnings = [], []
    for result in osv.get("results", []):
        src = (result.get("source") or {}).get("path", "?")
        for pkg in result.get("packages", []):
            name = (pkg.get("package") or {}).get("name", "?")
            for grp in pkg.get("groups", []):
                ids = set(grp.get("ids", [])) | set(grp.get("aliases", []))
                if ids & tracked:
                    continue  # already tracked in the ledger
                sev = grp.get("max_severity", "")
                primary = grp.get("ids", ["?"])[0]
                try:
                    score = float(sev)
                except (TypeError, ValueError):
                    warnings.append((primary, name, src, "unknown"))
                    continue
                if score >= 7.0:
                    blocking.append((primary, name, src, sev))

    for vid, name, src, sev in warnings:
        print(f"  ⚠ {vid}  {name}  ({src})  severity=unknown — triage into the ledger")
    if blocking:
        print(f"\ncomponent-watch-gate: {len(blocking)} UNTRACKED HIGH/CRITICAL finding(s):",
              file=sys.stderr)
        for vid, name, src, sev in blocking:
            print(f"  ✗ {vid}  CVSS {sev}  {name}  ({src})", file=sys.stderr)
        print("\nTriage each into security/cve-ledger.yaml (add an entry — status "
              "open with a remediation, or mitigated/not_affected/accepted), then fix "
              "per its tier SLA. See docs/operations/COMPONENT_WATCH.md.",
              file=sys.stderr)
        return 1

    print("component-watch-gate: OK — no untracked HIGH/CRITICAL dependency findings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
