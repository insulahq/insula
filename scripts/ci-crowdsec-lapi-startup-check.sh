#!/usr/bin/env bash
# Guard: the CrowdSec LAPI must be able to START without any out-of-band Secret.
#
# WHY THIS EXISTS
#
# The Traefik CrowdSec bouncer FAILS CLOSED. If the LAPI is unreachable, every
# request to every hosted site returns 403. So the LAPI is on the critical path
# for all ingress, and anything that can stop it from starting is a total
# outage, not a degraded feature.
#
# On 2026-09-05, upgrading production to 2026.9.9 did exactly that. The LAPI
# Deployment gained `AGENT_USERNAME` / `AGENT_PASSWORD` as hard `secretKeyRef`s
# on `crowdsec-agent-credentials` — a Secret created by host-migration
# 2026.9.9/0003, which runs on the platform-ops converger's own timer and NOT in
# step with the Flux apply. The kubelet refused to create the container
# (`CreateContainerConfigError: secret ... not found`), the LAPI never started,
# and every hosted website went to 403.
#
# Those two values only pre-register the log-processing agent. Nothing on the
# request path needs them. `optional: true` costs nothing and removes the whole
# failure class.
#
# The rule this enforces: on the LAPI, a secretKeyRef may be non-optional ONLY
# if bootstrap creates that Secret before the workload is ever applied.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MANIFEST="k8s/base/crowdsec/deployment.yaml"

# Secrets bootstrap guarantees exist before first apply. Everything else must be
# optional. Keep this list SHORT and justified — each entry is a workload that
# cannot start without it.
ALLOW_REQUIRED=("crowdsec-bouncer-key")

command -v python3 >/dev/null 2>&1 || { echo "::error::python3 required"; exit 1; }

python3 - "$MANIFEST" "${ALLOW_REQUIRED[@]}" <<'PY'
import sys, yaml

path, allowed = sys.argv[1], set(sys.argv[2:])
docs = [d for d in yaml.safe_load_all(open(path)) if d]
deps = [d for d in docs if d.get("kind") == "Deployment" and d["metadata"]["name"] == "crowdsec"]

if not deps:
    # Anti-vacuity: a guard that inspected nothing must fail, not pass quietly.
    print(f"::error::ci-crowdsec-lapi-startup-check: no crowdsec Deployment found in {path} "
          f"— the detector is broken, not the repo clean", file=sys.stderr)
    sys.exit(1)

fail = False
checked = 0
for dep in deps:
    spec = dep["spec"]["template"]["spec"]
    for c in (spec.get("containers") or []) + (spec.get("initContainers") or []):
        for e in c.get("env") or []:
            ref = (e.get("valueFrom") or {}).get("secretKeyRef")
            if not ref:
                continue
            checked += 1
            if ref.get("optional") is True or ref["name"] in allowed:
                continue
            print(f"::error file={path}::env {e['name']} hard-requires Secret "
                  f"'{ref['name']}' — the LAPI will not start without it, and the Traefik "
                  f"bouncer fails closed, so every hosted site returns 403.", file=sys.stderr)
            print("  Add `optional: true`, or add the Secret to ALLOW_REQUIRED only if "
                  "bootstrap creates it before this workload is ever applied.", file=sys.stderr)
            fail = True
        for ef in c.get("envFrom") or []:
            ref = ef.get("secretRef")
            if not ref:
                continue
            checked += 1
            if ref.get("optional") is True or ref["name"] in allowed:
                continue
            print(f"::error file={path}::envFrom hard-requires Secret '{ref['name']}' "
                  f"— same failure mode.", file=sys.stderr)
            fail = True

if checked == 0:
    print(f"::error::ci-crowdsec-lapi-startup-check: found NO secret references to check "
          f"— the detector is broken, not the repo clean", file=sys.stderr)
    sys.exit(1)

if fail:
    sys.exit(1)
print(f"ci-crowdsec-lapi-startup-check: {checked} secret ref(s) on the LAPI, "
      f"none can block startup — OK.")
PY
