#!/usr/bin/env bash
# component-watch.sh — operator helper for the component CVE/version watch.
#
#   --status   tiered table: component · tier · pinned · open CVEs (offline)
#   --drift    registry `pinned` vs the literal in pin_source (offline)
#   --scan     osv-scanner + govulncheck + cargo-audit over lockfiles/modules
#   --latest   components whose upstream has a newer release than `pinned` (online; gh/curl)
#   --json     with --status/--scan/--latest: emit JSON instead of a table
#
# Registry: security/components.yaml   Ledger: security/cve-ledger.yaml
# Process:  docs/operations/COMPONENT_WATCH.md   (ADR-050)
#
# The authoritative pass/fail gate is scripts/ci-component-watch-check.sh; this
# helper is for humans + the weekly sweep workflow.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
export REPO_ROOT
MODE="${1:---status}"
export CW_JSON=""
for a in "$@"; do [[ "$a" == "--json" ]] && export CW_JSON=1; done

case "$MODE" in
  --status)
    python3 - <<'PY'
import os, yaml, json, collections
REPO=os.environ["REPO_ROOT"]
reg=yaml.safe_load(open(f"{REPO}/security/components.yaml"))
led=yaml.safe_load(open(f"{REPO}/security/cve-ledger.yaml")) or {}
open_by=collections.Counter()
for e in (led.get("entries") or []):
    if e.get("status") in ("open","investigating","mitigated"):
        open_by[e.get("component")]+=1
comps=reg.get("components") or []
order={"0":0,"1":1,"2":2,"C":3,"3":4,"X":5}
comps.sort(key=lambda c:(order.get(str(c.get("tier")),9), c.get("id","")))
if os.environ.get("CW_JSON"):
    print(json.dumps([{ "id":c["id"],"tier":c["tier"],"pinned":c.get("pinned"),
        "open_cves":open_by.get(c["id"],0)} for c in comps], indent=2)); raise SystemExit
tier_name={"0":"CRITICAL","1":"HIGH","2":"MODERATE","3":"LOW","C":"CATALOG","X":"EXTERNAL"}
cur=None
print(f"{'COMPONENT':<28} {'TIER':<9} {'PINNED':<34} CVEs")
print("-"*80)
for c in comps:
    t=str(c["tier"])
    if t!=cur:
        cur=t; print(f"\n── Tier {t} · {tier_name.get(t,t)} ──")
    n=open_by.get(c["id"],0)
    flag=f" ⚠{n}" if n else ""
    pinned=str(c.get("pinned",""))[:33]
    print(f"{c['id']:<28} {t:<9} {pinned:<34}{flag}")
tot=sum(open_by.values())
print(f"\n{len(comps)} components · {tot} active ledger item(s)")
PY
    ;;

  --drift)
    python3 - <<'PY'
import os, yaml, sys
REPO=os.environ["REPO_ROOT"]
reg=yaml.safe_load(open(f"{REPO}/security/components.yaml"))
bad=0
for c in reg.get("components") or []:
    if not c.get("pin_check"): continue
    src=os.path.join(REPO,c["pin_source"]); pin=str(c.get("pinned",""))
    try: body=open(src,errors="replace").read()
    except OSError: print(f"  ✗ {c['id']}: pin_source missing ({c['pin_source']})"); bad+=1; continue
    if pin not in body:
        print(f"  ✗ {c['id']}: '{pin}' not in {c['pin_source']}"); bad+=1
print("drift: clean" if not bad else f"drift: {bad} mismatch(es)")
sys.exit(1 if bad else 0)
PY
    ;;

  --scan)
    echo "== component-watch --scan =="
    rc=0
    if command -v osv-scanner >/dev/null 2>&1; then
      # osv-scanner walks the tree and auto-detects every lockfile/manifest.
      # Pick the CLI shape by capability (v2 = `scan source`, v1 = top-level)
      # so a findings non-zero exit never triggers a duplicate fallback run.
      if osv-scanner scan source --help >/dev/null 2>&1; then
        osv-scanner scan source --recursive "$REPO_ROOT" || rc=$?
      else
        osv-scanner --recursive "$REPO_ROOT" || rc=$?
      fi
    else
      echo "  osv-scanner not installed — https://github.com/google/osv-scanner (CI installs it)"
      rc=127
    fi
    if command -v govulncheck >/dev/null 2>&1; then
      while IFS= read -r mod; do
        d=$(dirname "$mod"); echo "-- govulncheck $d"
        ( cd "$d" && govulncheck ./... ) || rc=$?
      done < <(find "$REPO_ROOT/images" -name go.mod 2>/dev/null)
    else
      echo "  govulncheck not installed — go install golang.org/x/vuln/cmd/govulncheck@latest"
    fi
    if command -v cargo-audit >/dev/null 2>&1; then
      d="$REPO_ROOT/images/rocksdb-secondary-checkpoint"
      [[ -f "$d/Cargo.lock" ]] && ( cd "$d" && cargo audit ) || true
    else
      echo "  cargo-audit not installed — cargo install cargo-audit"
    fi
    exit "$rc"
    ;;

  --latest)
    python3 - <<'PY'
import os, yaml, json, urllib.request
REPO=os.environ["REPO_ROOT"]
reg=yaml.safe_load(open(f"{REPO}/security/components.yaml"))
tok=os.environ.get("GITHUB_TOKEN","")
def latest(repo):
    url=f"https://api.github.com/repos/{repo}/releases/latest"
    req=urllib.request.Request(url, headers={"Accept":"application/vnd.github+json",
        **({"Authorization":f"Bearer {tok}"} if tok else {})})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r).get("tag_name")
    except Exception:
        # fall back to tags (some projects don't cut "releases")
        try:
            url=f"https://api.github.com/repos/{repo}/tags"
            req=urllib.request.Request(url, headers={"Accept":"application/vnd.github+json",
                **({"Authorization":f"Bearer {tok}"} if tok else {})})
            with urllib.request.urlopen(req, timeout=15) as r:
                t=json.load(r); return t[0]["name"] if t else None
        except Exception as e:
            return f"(error: {e})"
rows=[]
for c in reg.get("components") or []:
    w=c.get("watch") or {}
    if w.get("type")!="github_releases": continue
    repo=w.get("repo");
    if not repo: continue
    up=latest(repo); pin=str(c.get("pinned",""))
    behind = up and not str(up).lstrip("v").startswith(pin.lstrip("v").split("-")[0]) and "error" not in str(up)
    rows.append({"id":c["id"],"tier":c["tier"],"repo":repo,"pinned":pin,"latest":up,"behind":bool(behind)})
if os.environ.get("CW_JSON"):
    print(json.dumps(rows, indent=2)); raise SystemExit
print(f"{'COMPONENT':<28} {'PINNED':<26} {'UPSTREAM':<26} ")
print("-"*82)
for r in sorted(rows, key=lambda r:(not r["behind"], r["tier"], r["id"])):
    mark="←behind" if r["behind"] else ""
    print(f"{r['id']:<28} {str(r['pinned'])[:25]:<26} {str(r['latest'])[:25]:<26} {mark}")
print(f"\n{sum(1 for r in rows if r['behind'])}/{len(rows)} component(s) behind upstream "
      f"({'authenticated' if tok else 'unauthenticated — set GITHUB_TOKEN to avoid rate limits'})")
PY
    ;;

  -h|--help)
    sed -n '2,18p' "$0"
    ;;
  *)
    echo "unknown mode: $MODE (try --status|--drift|--scan|--latest|--help)" >&2
    exit 2
    ;;
esac
