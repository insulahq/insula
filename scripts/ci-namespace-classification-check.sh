#!/usr/bin/env bash
# ci-namespace-classification-check.sh — "is this namespace a tenant's?" has
# exactly ONE answer, in backend/src/lib/namespace-tier.ts.
#
# WHY: 2026-08-31 an admin was paged that tenant "traefik" had a container
# OOM-killed and was advised to raise that tenant's plan. `traefik` is a
# platform namespace; no such tenant exists. The alerting path enumerated the
# SYSTEM namespaces and treated everything else as a tenant — which fails OPEN.
# It named 9 of production's 27 namespaces, so ELEVEN platform ones were being
# reported as tenants: traefik, monitoring, crowdsec, calico-system,
# tigera-operator, redis-system, system-upgrade, hosting, plesk-migration,
# kube-public, kube-node-lease.
#
# Three other modules had independently grown the same list at 9, 18 and 13
# entries, all different, all incomplete. nodes/service.ts had even written the
# lesson in a comment without the fix reaching the others. An enumeration of
# "everything that is not a tenant" drifts by construction.
#
# This guard keeps the classification single-sourced. It does NOT ban every
# hardcoded namespace list — a module that iterates a CURATED SET is making a
# selection, not a classification (see the exemptions below).
#
# Exit: 0 clean · 1 a module classifies tenant-vs-platform on its own
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="backend/src/lib/namespace-tier.ts"
fail=0
cd "$ROOT" || exit 1

# 1) The helper exists and exports the classifier.
for sym in isTenantNamespace isSystemNamespace TENANT_NAMESPACE_PREFIX; do
  if ! grep -q "export \(function\|const\) $sym" "$HELPER" 2>/dev/null; then
    echo "ci-namespace-classification: $HELPER does not export $sym" >&2
    fail=1
  fi
done

# 2) It must classify by prefix, not by an enumeration. A list that grows back
#    inside the helper is the same bug wearing the helper's name.
if grep -qE "^\s*'(platform|kube-system|traefik|mail|monitoring)'," "$HELPER" 2>/dev/null; then
  echo "ci-namespace-classification: $HELPER enumerates namespaces — it must classify by the tenant- prefix" >&2
  fail=1
fi

# 3) Modules that decide tenant-vs-platform must not keep their own list.
#    Exemptions are CURATED SELECTIONS, not classifications:
#      · system-snapshots/service.ts — the namespaces whose PVCs get snapshotted.
#        Not every platform namespace has a PVC worth a snapshot schedule;
#        widening this silently would change backup scope.
#      · nodes/service.ts — mirrors the system-node-affinity Kustomize component
#        and is also used to ENUMERATE namespaces to list pods in, which a
#        prefix rule cannot do. It classifies via the helper; the list stays for
#        the affinity mirror.
EXEMPT='backend/src/modules/system-snapshots/service.ts|backend/src/modules/nodes/service.ts'
offenders=$(grep -rln "SYSTEM_NAMESPACES" --include=*.ts backend/src 2>/dev/null \
  | grep -vE "$EXEMPT" \
  | grep -v '\.test\.ts$' || true)
if [ -n "$offenders" ]; then
  echo "ci-namespace-classification: these modules keep their own SYSTEM_NAMESPACES list:" >&2
  printf '  %s\n' $offenders >&2
  echo "  -> import { isSystemNamespace } from '../../lib/namespace-tier.js' instead." >&2
  echo "  -> if it is a curated SELECTION rather than a classification, add it to EXEMPT with the reason." >&2
  fail=1
fi

# 4) The alerting path specifically must use the helper — this is the one that
#    paged an admin about a tenant that does not exist.
ALERT="backend/src/modules/node-health/memory-events.ts"
if ! grep -q "isSystemNamespace" "$ALERT" 2>/dev/null; then
  echo "ci-namespace-classification: $ALERT must classify via isSystemNamespace()" >&2
  fail=1
fi

# 5) An unconfirmed exit-137 kill must not be worded as a confirmed OOM.
#    Exit 137 is 128+SIGKILL from any source; claiming "OOM-killed at its
#    memory limit" for it is what sent an admin to raise a limit on a container
#    sitting at 13% of one.
if ! grep -q "oomConfidence" "$ALERT" 2>/dev/null; then
  echo "ci-namespace-classification: $ALERT must distinguish confirmed OOMs from inferred exit-137 kills (oomConfidence)" >&2
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "ci-namespace-classification: OK (single classifier; alerting path uses it)"
fi
exit "$fail"
