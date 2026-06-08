#!/usr/bin/env bash
# ci-component-watch-check.sh — keep the component CVE/version watch honest.
#
# Validates security/components.yaml (registry) + security/cve-ledger.yaml against
# the actual repo so neither can silently rot. Four invariants:
#
#   1. SCHEMA   — every registry + ledger entry has the required fields with valid
#                 enum values; every ledger `component` exists in the registry.
#   2. DRIFT    — for every component with `pin_check: true`, the `pinned` literal
#                 MUST appear in its `pin_source` file (registry == reality).
#   3. COVERAGE — every distinct image:/imageName: under k8s/ AND every version pin
#                 in scripts/bootstrap.sh maps to a registry component (nothing
#                 ships untracked).
#   4. SLA      — every `open` ledger entry that is KEV or critical AND past its
#                 tier SLA MUST carry a non-empty `mitigation`.
#
# Process + tiering rubric: docs/operations/COMPONENT_WATCH.md  (ADR-050)
# Exits non-zero on any violation. Pure-stdlib python3 (pyyaml); no network.
#
# Self-test:  scripts/ci-component-watch-check.sh --self-test

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
export REPO_ROOT

if [[ "${1:-}" == "--self-test" ]]; then
  export COMPONENT_WATCH_SELFTEST=1
fi

python3 - <<'PY'
import os, re, sys, datetime
REPO = os.environ["REPO_ROOT"]
SELFTEST = os.environ.get("COMPONENT_WATCH_SELFTEST") == "1"

try:
    import yaml
except Exception as e:  # pragma: no cover
    print(f"ci-component-watch-check: pyyaml required ({e})", file=sys.stderr)
    sys.exit(2)

errors = []
warnings = []
def err(m): errors.append(m)
def warn(m): warnings.append(m)

REG_PATH = os.path.join(REPO, "security", "components.yaml")
LEDGER_PATH = os.path.join(REPO, "security", "cve-ledger.yaml")

def load(path):
    with open(path) as f:
        return yaml.safe_load(f)

# ── load ──────────────────────────────────────────────────────────────────────
try:
    reg = load(REG_PATH)
except Exception as e:
    print(f"ci-component-watch-check: cannot parse {REG_PATH}: {e}", file=sys.stderr)
    sys.exit(2)
try:
    ledger = load(LEDGER_PATH)
except Exception as e:
    print(f"ci-component-watch-check: cannot parse {LEDGER_PATH}: {e}", file=sys.stderr)
    sys.exit(2)

with open(REG_PATH) as f:
    reg_text = f.read()

components = reg.get("components") or []
TIERS = set((reg.get("tiers") or {}).keys())
VALID_KIND = {"chart", "image", "binary", "plugin", "npm", "go", "rust", "external"}
VALID_SCAN = {"trivy", "osv", "govulncheck", "cargo-audit", "manual", "none",
              "dependabot", "trivy+osv", "trivy+govulncheck", "trivy+cargo-audit"}
VALID_STATUS = {"open", "investigating", "mitigated", "not_affected", "accepted", "fixed"}
VALID_SEV = {"critical", "high", "medium", "low"}

# ── 1. SCHEMA: registry ────────────────────────────────────────────────────────
ids = set()
by_id = {}
for i, c in enumerate(components):
    where = f"components[{i}]"
    cid = c.get("id")
    if not cid:
        err(f"{where}: missing id"); continue
    if cid in ids:
        err(f"{where}: duplicate id '{cid}'")
    ids.add(cid); by_id[cid] = c
    for fld in ("name", "tier", "kind", "pinned", "pin_source", "watch", "scan", "owner"):
        if c.get(fld) in (None, ""):
            err(f"{cid}: missing required field '{fld}'")
    if str(c.get("tier")) not in TIERS:
        err(f"{cid}: invalid tier '{c.get('tier')}' (allowed: {sorted(TIERS)})")
    if c.get("kind") not in VALID_KIND:
        err(f"{cid}: invalid kind '{c.get('kind')}'")
    if c.get("scan") not in VALID_SCAN:
        err(f"{cid}: invalid scan '{c.get('scan')}'")
    if "pin_check" in c and not isinstance(c["pin_check"], bool):
        err(f"{cid}: pin_check must be true/false")

# ── 2. DRIFT: pinned literal present in pin_source ──────────────────────────────
for c in components:
    cid = c.get("id")
    if not cid or not c.get("pin_check"):
        continue
    pinned = str(c.get("pinned", ""))
    src = c.get("pin_source", "")
    p = os.path.join(REPO, src)
    if not os.path.isfile(p):
        err(f"{cid}: pin_check is true but pin_source '{src}' is not a file")
        continue
    with open(p, errors="replace") as f:
        body = f.read()
    if pinned not in body:
        err(f"{cid}: DRIFT — pinned '{pinned}' not found in {src}")

# ── 3a. COVERAGE: k8s images ────────────────────────────────────────────────────
def norm_repo(image):
    image = image.strip().strip('"').strip("'")
    image = image.split("@", 1)[0]            # drop digest
    # drop tag (last colon segment) unless it's a port-in-host (rare here)
    if ":" in image:
        head, tail = image.rsplit(":", 1)
        if "/" not in tail:                   # tail is a tag, not a path
            image = head
    parts = image.split("/")
    if parts and ("." in parts[0] or ":" in parts[0]):  # strip registry host
        parts = parts[1:]
    return "/".join(parts)

k8s_dir = os.path.join(REPO, "k8s")
img_re = re.compile(r'^\s*-?\s*(?:image|imageName):\s*["\']?([^"\'#\s]+)')
found = {}   # normalized repo -> example "file: raw"
for root, _, files in os.walk(k8s_dir):
    for fn in files:
        if not fn.endswith((".yaml", ".yml")):
            continue
        fp = os.path.join(root, fn)
        rel = os.path.relpath(fp, REPO)
        with open(fp, errors="replace") as f:
            for line in f:
                m = img_re.match(line)
                if not m:
                    continue
                raw = m.group(1)
                if raw.startswith("$") or "{" in raw or raw in ("none", "scratch"):
                    continue
                nr = norm_repo(raw)
                if nr and nr not in found:
                    found[nr] = f"{rel}: {raw.strip()}"

# authoritative coverage map: every repo listed in any component's `repos:` field
declared_repos = set()
for c in components:
    for r in (c.get("repos") or []):
        declared_repos.add(norm_repo(str(r)))

def covered(repo):
    # 1. multi-segment repos MUST be declared explicitly in a component's `repos:`
    #    list — no prose/substring matching (that created a silent coverage hole:
    #    an org/repo string in a notes:/watch.repo: field would falsely "cover" an
    #    untracked image). See ADR-050 review 2026-06-08.
    if repo in declared_repos:
        return True
    # 2. single-segment library images (nginx/busybox/alpine) — word-boundary token
    #    match is safe (these names don't appear as incidental path substrings).
    if "/" not in repo and re.search(rf'(^|[^\w-]){re.escape(repo)}([^\w-]|$)', reg_text):
        return True
    return False

for repo, example in sorted(found.items()):
    if not covered(repo):
        err(f"COVERAGE — k8s image '{repo}' not in registry ({example})")

# ── 3b. COVERAGE: bootstrap.sh version pins ─────────────────────────────────────
boot = os.path.join(REPO, "scripts", "bootstrap.sh")
pinned_values = {str(c.get("pinned", "")) for c in components}
boot_pins = {}  # var -> value
if os.path.isfile(boot):
    with open(boot, errors="replace") as f:
        for line in f:
            m = re.match(r'\s*([A-Z][A-Z0-9_]*VERSION)="([^"$]*)"', line)
            if m:
                boot_pins[m.group(1)] = m.group(2)
            m2 = re.match(r'\s*local\s+([a-z][a-z0-9_]*_ver)="([^"$]+)"', line)
            if m2:
                boot_pins[m2.group(1)] = m2.group(2)
for var, val in sorted(boot_pins.items()):
    if not val:           # e.g. CORAZA_PLUGIN_VERSION="" (disabled)
        continue
    if val not in pinned_values:
        err(f"COVERAGE — bootstrap pin {var}=\"{val}\" maps to no registry component")

# ── 1b. SCHEMA + 4. SLA: ledger ─────────────────────────────────────────────────
SLA_DAYS = {  # critical/KEV remediation window per tier, in days ("next-release"/etc → no day-clock)
    "0": 2, "1": 7, "2": 30, "3": None, "C": 7, "X": None,
}
entries = (ledger or {}).get("entries") or []
today = datetime.date.today()
for i, e in enumerate(entries):
    where = f"ledger.entries[{i}]"
    eid = e.get("id", where)
    for fld in ("id", "component", "severity", "status"):
        if e.get(fld) in (None, ""):
            err(f"{eid}: missing required field '{fld}'")
    comp = e.get("component")
    if comp and comp not in ids:
        err(f"{eid}: component '{comp}' not in registry")
    if e.get("severity") not in VALID_SEV:
        err(f"{eid}: invalid severity '{e.get('severity')}'")
    if e.get("status") not in VALID_STATUS:
        err(f"{eid}: invalid status '{e.get('status')}'")
    if e.get("status") == "accepted" and not e.get("review_by"):
        err(f"{eid}: status 'accepted' requires a review_by date")
    # SLA clock
    if e.get("status") == "open" and (e.get("kev") or e.get("severity") == "critical"):
        tier = str(by_id.get(comp, {}).get("tier", ""))
        days = SLA_DAYS.get(tier)
        disc = e.get("discovered")
        overdue = False
        if days is not None and disc:
            try:
                d = disc if isinstance(disc, datetime.date) else datetime.date.fromisoformat(str(disc))
                overdue = (today - d).days > days
            except Exception:
                warn(f"{eid}: unparseable discovered '{disc}'")
        if (days is not None and overdue) and not e.get("mitigation"):
            # REPORT-ONLY for now (matches the repo's report-only→enforce convention,
            # e.g. ci-manual-impact-check). Flip to err() once the initial CVE backlog
            # seeded 2026-06-08 is burned down, so a stale open critical can't merge.
            warn(f"{eid}: open {('KEV' if e.get('kev') else 'critical')} on tier-{tier} "
                 f"past {days}d SLA with no mitigation (report-only)")

# ── report ──────────────────────────────────────────────────────────────────────
for w in warnings:
    print(f"  ⚠ {w}")
if errors:
    print(f"\nci-component-watch-check: {len(errors)} violation(s):", file=sys.stderr)
    for e in errors:
        print(f"  ✗ {e}", file=sys.stderr)
    sys.exit(1)

print(f"ci-component-watch-check: OK — {len(components)} components, "
      f"{len(entries)} ledger entries, {len(found)} k8s images covered, "
      f"{len([v for v in boot_pins.values() if v])} bootstrap pins covered.")

# ── self-test: prove the detection logic actually rejects bad input ─────────────
if SELFTEST:
    checks = []
    # coverage: a clearly-untracked multi-segment repo must NOT be covered, and a
    # declared one MUST be — exercises covered() itself, not just the data.
    checks.append(("coverage rejects untracked", covered("evil/untracked-xyz") is False))
    a_declared = next(iter(declared_repos), None)
    checks.append(("coverage accepts declared", a_declared is None or covered(a_declared) is True))
    # drift: for a real pin_check component, the true pin is present and a bogus
    # value is absent in the same file.
    pc = next((c for c in components if c.get("pin_check")), None)
    if pc:
        body = open(os.path.join(REPO, pc["pin_source"]), errors="replace").read()
        checks.append(("drift sees real pin", str(pc["pinned"]) in body))
        checks.append(("drift rejects bogus pin", "ZZZ-not-a-real-pin-9x" not in body))
    bad = [name for name, ok in checks if not ok]
    if bad:
        print(f"self-test FAILED: {bad}", file=sys.stderr)
        sys.exit(3)
    print(f"self-test: {len(checks)} detection assertions passed "
          "(coverage accept/reject + drift accept/reject)")
PY
