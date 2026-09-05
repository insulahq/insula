#!/usr/bin/env python3
"""Every Traefik-routed Service in the `platform` namespace must be reachable
through the NetworkPolicy.

`default-deny-ingress` selects EVERY pod in `platform`. A Service that an
IngressRoute points at but that is missing from `allow-ingress-to-platform`'s
podSelector is unreachable — and it fails in the worst possible way:

  * the pod is Running and READY, because the kubelet probes it from the NODE,
    which the policy does not filter; only pod-to-pod traffic is denied;
  * Traefik hangs until its timeout (504) or the client gives up first (499);
  * nothing logs an error.

On production this went unnoticed until the resulting 504s tripped the
availability SLO, and the alert was initially mistaken for a WAF/attack signal.
`platform-suspended` (the page a suspended tenant's visitors should see, and the
tunnel anchor's catch-all backend) and `platform-bandwidth-exceeded` had both
shipped unreachable.

ExternalName indirection is followed: tunnel-anchor-default in platform-system
is an ExternalName to platform-suspended.platform.svc, so the anchor's route
counts as routing `platform-suspended`.
"""
import pathlib
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parent.parent
NETPOL = ROOT / "k8s/base/network-policies.yaml"
POLICY = "allow-ingress-to-platform"


def load_all(path: pathlib.Path):
    try:
        return [d for d in yaml.safe_load_all(path.read_text()) if isinstance(d, dict)]
    except yaml.YAMLError:
        return []


def main() -> int:
    print("── platform netpol reachability ────────────────────────────────────")
    if not NETPOL.exists():
        print(f"  FAIL: {NETPOL} missing", file=sys.stderr)
        return 1

    pol = next((d for d in load_all(NETPOL) if d.get("metadata", {}).get("name") == POLICY), None)
    if pol is None:
        print(f"  FAIL: {POLICY} not found in {NETPOL.name}", file=sys.stderr)
        return 1
    allowed = set()
    for e in pol["spec"]["podSelector"].get("matchExpressions", []):
        if e.get("key") == "app" and e.get("operator") == "In":
            allowed |= set(e.get("values", []))
    if not allowed:
        print("  FAIL: allow-list parsed empty — the guard would pass vacuously", file=sys.stderr)
        return 1

    # ExternalName services anywhere in k8s/base that resolve into `platform`.
    external: dict[str, str] = {}
    docs_by_file = {p: load_all(p) for p in ROOT.glob("k8s/base/**/*.yaml")}
    for docs in docs_by_file.values():
        for d in docs:
            if d.get("kind") == "Service" and d.get("spec", {}).get("type") == "ExternalName":
                tgt = str(d["spec"].get("externalName", ""))
                if tgt.endswith(".platform.svc.cluster.local") or tgt.endswith(".platform.svc"):
                    external[d["metadata"]["name"]] = tgt.split(".")[0]

    # Services referenced by IngressRoutes, resolved through ExternalName.
    routed: dict[str, str] = {}   # service -> the IngressRoute that routes it
    for path, docs in docs_by_file.items():
        for d in docs:
            if d.get("kind") != "IngressRoute":
                continue
            ns = d.get("metadata", {}).get("namespace")
            name = d.get("metadata", {}).get("name", "?")
            for r in d.get("spec", {}).get("routes", []):
                for s in r.get("services", []) or []:
                    svc = s.get("name")
                    if not svc:
                        continue
                    target = external.get(svc, svc if ns == "platform" else None)
                    if target:
                        routed.setdefault(target, name)

    if not routed:
        print("  FAIL: no routed platform Services discovered — guard would pass vacuously",
              file=sys.stderr)
        return 1

    failed = False
    for svc in sorted(routed):
        if svc in allowed:
            print(f"  OK   {svc:30} (routed by {routed[svc]})")
        else:
            print(f"  FAIL: {svc} is routed by IngressRoute '{routed[svc]}' but is NOT in "
                  f"{POLICY}", file=sys.stderr)
            print("        default-deny-ingress will silently block it: 504/499 while the "
                  "pod stays Ready", file=sys.stderr)
            failed = True

    if failed:
        print("── platform netpol reachability: FAILED ────────────────────────", file=sys.stderr)
        print(f"Add the service's `app` label value to the podSelector matchExpressions of "
              f"{POLICY} in {NETPOL.relative_to(ROOT)}.", file=sys.stderr)
        return 1

    print(f"ci-platform-netpol-reachability: OK — {len(routed)} routed Service(s), all allowed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
