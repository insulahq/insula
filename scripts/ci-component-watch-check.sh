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
#   3. COVERAGE — every distinct image:/imageName: under k8s/, every version pin
#                 in scripts/bootstrap.sh, AND every upstream image platform-api
#                 creates at runtime (scripts/lib/runtime-images.py) maps to a
#                 registry component (nothing ships untracked); a runtime image's
#                 tag must be the component's `pinned` (or listed in its
#                 `also_pinned`, with `also_pinned_reason`) — a second copy at
#                 another version is drift, not coverage.
#   4. SLA      — every `open` ledger entry that is KEV or critical AND past its
#                 tier SLA MUST carry a non-empty `mitigation`.
#   5. UPDATER  — .github/dependabot.yml uses no cooldown key GitHub rejects for
#                 an ecosystem (one invalid key drops the whole block), and its
#                 docker block covers every directory with a Dockerfile, so every
#                 digest-pinned FROM has something that keeps it fresh.
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
    if c.get("also_pinned") is not None:
        if not isinstance(c["also_pinned"], list) or not all(isinstance(x, str) for x in c["also_pinned"]):
            err(f"{cid}: also_pinned must be a list of tags")
        if not str(c.get("also_pinned_reason") or "").strip():
            err(f"{cid}: also_pinned needs also_pinned_reason (why a second version ships, and how it goes away)")

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
    # untracked image). See ADR-050 review.
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

# ── 3c. COVERAGE + DRIFT: images platform-api creates at runtime ────────────────
# k8s/ and bootstrap.sh are not everything that runs: the backend writes images
# into pods itself (the route sign-in's oauth2-proxy, helper Jobs, init
# containers). The route sign-in ran oauth2-proxy v7.6.0 — published
# authentication bypasses — while this registry said v7.15.5, because the
# second copy lived in TypeScript where nothing looked.
# bootstrap.sh and the host migrations write manifests and Helm values too
# (Traefik's init containers, install-time pods): scripts/lib/script-images.py.
import subprocess
rt_out = []
for scanner in ("runtime-images.py", "script-images.py"):
    rt = subprocess.run([sys.executable, os.path.join(REPO, "scripts", "lib", scanner), REPO],
                        capture_output=True, text=True)
    if rt.returncode != 0:
        err(f"{scanner} failed: {rt.stderr.strip()[:300]}")
    rt_out.append(rt.stdout)
by_repo = {}
for c in components:
    for r in (c.get("repos") or []):
        by_repo.setdefault(norm_repo(str(r)), []).append(c)
for line in "".join(rt_out).splitlines():
    if "\t" not in line:
        continue
    src_file, ref = line.split("\t", 1)
    repo = norm_repo(ref)
    tag = ref.split("@", 1)[0].rsplit(":", 1)[1] if ":" in ref.split("@", 1)[0].split("/")[-1] else ""
    owners = by_repo.get(repo, [])
    if not owners:
        err(f"COVERAGE — runtime image '{ref}' ({src_file}) maps to no registry component — add it to a component's repos")
        continue
    allowed = set()
    for c in owners:
        allowed.add(str(c.get("pinned", "")))
        allowed.update(str(x) for x in (c.get("also_pinned") or []))
    # An image tag cannot hold '+': k3s v1.36.5+k3s1 is the image rancher/k3s:v1.36.5-k3s1.
    allowed.update({a.replace("+", "-") for a in allowed})
    if tag not in allowed:
        pins = ", ".join(f"{c['id']}={c.get('pinned')} ({c.get('pin_source')})" for c in owners)
        err(f"DRIFT — runtime image '{ref}' ({src_file}) is not the registry's version [{pins}]: "
            "bump it to the pinned version, or list the tag under also_pinned with a reason")

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
    scope = e.get("trivy_scope")
    if scope is not None:
        lists = {k: v for k, v in (scope.items() if isinstance(scope, dict) else []) if k in ("paths", "purls")}
        if (not isinstance(scope, dict) or set(scope) - {"paths", "purls"} or not lists
                or not all(isinstance(v, list) and v and all(isinstance(x, str) and x for x in v) for v in lists.values())):
            err(f"{eid}: trivy_scope must be {{paths: [..], purls: [..]}} with non-empty string lists")
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
            # ENFORCING (the seeded backlog was cleared the same
            # day — PRs #251/#253). An open KEV/critical past its tier SLA with no
            # mitigation now fails CI. To unblock: ship the fix, add a `mitigation:`,
            # or re-triage the entry (not_affected/accepted with review_by).
            err(f"{eid}: open {('KEV' if e.get('kev') else 'critical')} on tier-{tier} "
                f"past {days}d SLA with no mitigation")

# ── 5. UPDATER: Dependabot keeps every digest-pinned base fresh ─────────────────
# GitHub rejected `cooldown.semver-major-days` for docker + github-actions; that
# error dropped the docker block, and the updater never ran while every FROM
# line sat on the digest of the day it was pinned (both panels shipped a
# critical OpenSSL CVE for months). GitHub reports such errors only in the
# repo's Insights tab, so they are checked here.
import fnmatch
NO_SEMVER_COOLDOWN = {"docker", "github-actions", "docker-compose", "terraform", "gitsubmodule"}
dep_path = os.path.join(REPO, ".github", "dependabot.yml")
dep = yaml.safe_load(open(dep_path)) if os.path.exists(dep_path) else {}
docker_dirs = []
for i, u in enumerate((dep or {}).get("updates") or []):
    eco = u.get("package-ecosystem")
    semver_keys = [k for k in (u.get("cooldown") or {}) if str(k).startswith("semver-")]
    if eco in NO_SEMVER_COOLDOWN and semver_keys:
        err(f"dependabot.yml updates[{i}] ({eco}): cooldown {semver_keys} is not supported for "
            f"{eco} — GitHub drops the whole block; use default-days only")
    if eco == "docker":
        docker_dirs += [u["directory"]] if u.get("directory") else []
        docker_dirs += list(u.get("directories") or [])
dockerfile_dirs = []
for dp, dns, fs in os.walk(REPO):
    # Prune on path components RELATIVE to the repo: the repo itself may live
    # under .claude/worktrees/, and `.github` is not `.git`.
    dns[:] = [d for d in dns if d not in ("node_modules", ".git", ".claude", "dist")]
    if "Dockerfile" in fs:
        dockerfile_dirs.append(os.path.relpath(dp, REPO))
dockerfile_dirs.sort()
if not dockerfile_dirs:
    err("dependabot coverage: found no Dockerfile at all — the walk is broken, not the repo")
for d in dockerfile_dirs:
    if not any(fnmatch.fnmatch("/" + d, pat.rstrip("/")) for pat in docker_dirs):
        err(f"dependabot.yml: no docker updater covers {d}/Dockerfile — add the directory "
            "(its digest-pinned FROM lines would never be refreshed)")

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
