#!/usr/bin/env python3
"""Fail CI on a new HIGH/CRITICAL OSV finding not waived in the CVE ledger, and
on ANY malicious (MAL-) package regardless of severity.

Usage: component-watch-gate.py <osv.json> <cve-ledger.yaml>

Two classes of finding, deliberately governed by different rules:

**Vulnerabilities (CVE/GHSA).** The gate fails only on **untracked** HIGH/CRITICAL
findings — i.e. a finding whose OSV ids/aliases match NO ledger entry. Any ledger
entry (any status, including `open`) marks a finding as tracked and suppresses it
here; timely remediation of `open` items is enforced separately by the SLA check in
scripts/ci-component-watch-check.sh + surfaced in the weekly sweep issue. This
keeps CI mergeable while a triaged backlog is burned down. HIGH/CRITICAL = CVSS
base score >= 7.0 (osv-scanner group max_severity); unknown-severity findings are
warnings, not failures.

**Malicious packages (MAL-).** A MAL- advisory does not mean a package we depend on
has a bug — it means the published artifact is hostile (hijacked maintainer account,
injected install script, credential stealer). It is NOT a severity judgement and
there is nothing to burn down: the package leaves the lockfile or CI stays red.

Two consequences follow, and both matter:
  * A MAL- finding blocks whatever its CVSS says. Most carry NO severity at all, so
    under the vulnerability rules above they would land in the *warnings* bucket and
    the gate would exit 0 — a malicious dependency printed as a ⚠ and merged. That
    was the behaviour until 2026-08-06.
  * `open` / `investigating` / `mitigated` / `accepted` do NOT suppress it. Those
    statuses all mean "we know, we will get to it", which is a coherent answer for a
    CVE and an incoherent one for a package that is currently stealing tokens.
    Only `not_affected` (confirmed false positive) or `fixed` (removed/repinned,
    lockfile regenerated) clear it.

Part of ADR-050. Runbook: docs/operations/COMPONENT_WATCH.md.
"""
import json
import sys

# Any valid ledger status means the finding is *tracked* → suppressed here.
TRACKED_STATUSES = {"open", "investigating", "mitigated", "not_affected",
                    "accepted", "fixed"}

# OSV id prefix for a malicious-package advisory (the OSV "malicious packages"
# database — MAL-YYYY-NNNN). Checked against ids AND aliases: a group's primary id
# is often the GHSA while the MAL- id rides along as an alias.
MALICIOUS_PREFIX = "MAL-"

# The only two statuses that clear a malicious-package finding. See the module
# docstring — this set is intentionally much narrower than TRACKED_STATUSES.
MALICIOUS_CLEARED_STATUSES = {"not_affected", "fixed"}


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
    entries = [e for e in (ledger.get("entries") or []) if e.get("id")]
    tracked = {
        str(e.get("id")) for e in entries if e.get("status") in TRACKED_STATUSES
    }
    cleared_malicious = {
        str(e.get("id")) for e in entries
        if e.get("status") in MALICIOUS_CLEARED_STATUSES
    }

    malicious, blocking, warnings = [], [], []
    for result in osv.get("results", []):
        src = (result.get("source") or {}).get("path", "?")
        for pkg in result.get("packages", []):
            name = (pkg.get("package") or {}).get("name", "?")
            version = (pkg.get("package") or {}).get("version", "?")
            for grp in pkg.get("groups", []):
                ids = set(grp.get("ids", [])) | set(grp.get("aliases", []))
                mal_ids = sorted(i for i in ids if i.startswith(MALICIOUS_PREFIX))
                if mal_ids:
                    # Severity is not consulted: hostile is hostile. Report the MAL-
                    # id rather than the group's primary, because that is the id an
                    # operator would look up and write into the ledger.
                    if ids & cleared_malicious:
                        continue
                    malicious.append((mal_ids[0], name, version, src))
                    continue
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

    if malicious:
        print(f"\ncomponent-watch-gate: {len(malicious)} MALICIOUS package finding(s) "
              "— this is not a CVE:", file=sys.stderr)
        for vid, name, version, src in malicious:
            print(f"  ☠ {vid}  {name}@{version}  ({src})", file=sys.stderr)
        print("""
The published package itself is hostile — a hijacked maintainer account, an
injected install script, a credential stealer. Do NOT waive this to unblock a
merge:

  1. Remove the package or pin away from the affected version, then regenerate
     the lockfile. Verify it is gone: `grep -n '<name>' package-lock.json`.
  2. Treat every machine that ran `npm install`/`npm ci` on it as compromised —
     rotate registry tokens, GHCR tokens, and anything else in the runner or
     developer environment. (`ignore-scripts=true` in .npmrc blocks the usual
     install-time execution path, so this is containment, not certainty.)
  3. ONLY if the advisory is a confirmed false positive, add a ledger entry with
     status `not_affected` and justify it in `notes`.

Statuses open/investigating/mitigated/accepted deliberately do NOT suppress a
malicious-package finding. See docs/operations/COMPONENT_WATCH.md.""",
              file=sys.stderr)

    if blocking:
        print(f"\ncomponent-watch-gate: {len(blocking)} UNTRACKED HIGH/CRITICAL finding(s):",
              file=sys.stderr)
        for vid, name, src, sev in blocking:
            print(f"  ✗ {vid}  CVSS {sev}  {name}  ({src})", file=sys.stderr)
        print("\nTriage each into security/cve-ledger.yaml (add an entry — status "
              "open with a remediation, or mitigated/not_affected/accepted), then fix "
              "per its tier SLA. See docs/operations/COMPONENT_WATCH.md.",
              file=sys.stderr)

    if malicious or blocking:
        return 1

    print("component-watch-gate: OK — no malicious packages, no untracked "
          "HIGH/CRITICAL dependency findings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
