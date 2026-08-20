#!/usr/bin/env bash
# ci-platform-migration-rbac.sh — a platform-migration may only call a
# Kubernetes verb that platform-api's ClusterRole actually grants.
#
# WHY: platform-migrations run INSIDE platform-api, under the `platform-api`
# ServiceAccount. Nothing connected the two, so a migration could be written
# against an API the ServiceAccount cannot touch, and the mismatch surfaced
# only as a 403 buried in pod logs.
#
# That happened. ADR-058's migration 0009 creates the wildcard DNS-01
# ClusterIssuers, but rbac.yaml deliberately kept clusterissuers read-only
# ("operators provision them via k8s/base/cert-manager/"). On every
# already-running cluster the migration 403'd, the registry HALTED on it (by
# design — no later migration runs on a broken base), and
# `letsencrypt-prod-dns01-insula` was never created. Wildcard Certificates
# then referenced an issuer that did not exist, so cert-manager never created
# an Order: no Challenge, no failure event, the Certificate just sat "Issuing".
# Found on a 2026.8.6 cluster after days of a silently pending wildcard cert.
#
# Deliberately narrow: it models the shape that actually bit us (cluster-scoped
# custom-object writes), not all of RBAC.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
exec python3 - k8s/base/rbac.yaml backend/src/modules/platform-upgrades/migrations <<'PYCHECK'
import os, re, sys

rbac_path, migrations_dir = sys.argv[1], sys.argv[2]

try:
    rbac = open(rbac_path).read()
except OSError as e:
    sys.exit(f"ci-platform-migration-rbac: {e}")

# The platform-api ClusterRole's rules: from its `name:` to the next document.
m = re.search(r"\n  name: platform-api\n(.*?)(?=\n---|\Z)", rbac, re.S)
if not m:
    sys.exit("ci-platform-migration-rbac: platform-api ClusterRole not found in " + rbac_path)
api_rules = m.group(1)

def granted(resource: str, verb: str) -> bool:
    """True when the platform-api role grants <verb> on <resource>."""
    for block in re.split(r"\n  - apiGroups:", api_rules):
        res_m = re.search(r"resources:\s*\[([^\]]*)\]", block)
        vrb_m = re.search(r"verbs:\s*\[([^\]]*)\]", block)
        if not res_m or not vrb_m:
            continue
        resources = [r.strip().strip("\"'") for r in res_m.group(1).split(",")]
        if resource not in resources:
            continue
        verbs = [v.strip().strip("\"'") for v in vrb_m.group(1).split(",")]
        if verb in verbs or "*" in verbs:
            return True
    return False

# k8s client call -> the RBAC verb it needs.
CALL_VERB = {
    "createClusterCustomObject": "create",
    "patchClusterCustomObject": "patch",
    "replaceClusterCustomObject": "update",
    "deleteClusterCustomObject": "delete",
}

def plurals_in(src: str):
    """`plural:` is usually a module constant, not a literal — resolve both, or
    the guard silently checks nothing (the very failure mode it exists for)."""
    consts = dict(re.findall(r"const\s+([A-Z0-9_]+)\s*=\s*['\"]([a-z]+)['\"]", src))
    out = set()
    for ref in re.findall(r"plural:\s*([A-Za-z0-9_'\"]+)", src):
        ref = ref.strip()
        if ref[:1] in "'\"":
            out.add(ref.strip("'\""))
        elif ref in consts:
            out.add(consts[ref])
    return sorted(out)

checked = failures = 0
files = sorted(
    f for f in os.listdir(migrations_dir)
    if re.match(r"^\d+.*\.ts$", f) and not f.endswith(".test.ts")
)
for name in files:
    src = open(os.path.join(migrations_dir, name)).read()
    for call, verb in CALL_VERB.items():
        if call not in src:
            continue
        for res in plurals_in(src):
            checked += 1
            if granted(res, verb):
                print(f"  ok: {name} {call} -> platform-api may '{verb}' {res}")
            else:
                failures += 1
                print(
                    f"  FAIL: {name} calls {call} on '{res}' but the platform-api "
                    f"ClusterRole does not grant '{verb}' — it will 403 at runtime "
                    f"and HALT the migration registry",
                    file=sys.stderr,
                )

# A guard that checks nothing passes vacuously. There IS at least one
# cluster-scoped write in the registry today; if that stops being true, this
# assertion is the thing that tells you to retire the guard rather than let it
# keep reporting green.
if checked == 0:
    print(
        "  FAIL: no cluster-scoped custom-object writes found — the matcher has "
        "drifted from the migrations (or they were all removed); this guard is "
        "reporting green without checking anything",
        file=sys.stderr,
    )
    failures += 1

print(f"ci-platform-migration-rbac: {checked} check(s), {failures} failure(s)")
sys.exit(1 if failures else 0)
PYCHECK
