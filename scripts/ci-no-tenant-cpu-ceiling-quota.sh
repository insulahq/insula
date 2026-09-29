#!/usr/bin/env bash
# A tenant ResourceQuota must never carry `limits.cpu`.
#
# Why this guard exists
# ---------------------
# A ResourceQuota charges every container its whole CPU *ceiling* at
# admission, used or not. A namespace budget of N ceilings is therefore a cap
# on the number of CONTAINERS the tenant may run, wearing the clothes of a CPU
# limit — and Kubernetes accepts a budget below what the namespace already
# holds, then refuses every new pod AND every rolling replacement.
#
# Shipped once as a "backstop": it capped a starter tenant at two
# applications, refused the third, deadlocked that tenant's own CPU migration
# (a replacement needs a free slot while the old pod still holds one), and left
# fourteen more tenants one application away from the same wall.
#
# What bounds a noisy neighbour is the per-container ceiling in the tenant
# LimitRange (`default` + `max`) — untouched, and the thing ADR-062 promised.
#
# The guard is deliberately crude: any `'limits.cpu'` written into something
# that looks like a quota `hard` map fails. Reading the key is fine (decoding a
# rejection, reporting an old cluster's state); writing one is not.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

fail=0

# Writers: a `'limits.cpu':` whose value is not `null` (null is the RFC 7396
# deletion we use to take the key OFF an upgraded namespace).
while IFS= read -r hit; do
  file=${hit%%:*}
  case "$file" in
    *".test.ts"|*"/k8s-manifests/generator.ts") ;;  # fixtures + the comment there
  esac
  echo "::error::$hit"
  fail=1
done < <(grep -rn "'limits\.cpu':" backend/src --include='*.ts' \
           | grep -v '\.test\.ts:' \
           | grep -v "'limits\.cpu': null" \
           | grep -v "'limits\.cpu': 'CPU limit'" || true)

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "A tenant ResourceQuota must not carry limits.cpu — it caps the tenant's"
  echo "container count, not their CPU. Bound a container with the LimitRange"
  echo "(default/max) instead. See tiered-namespace.ts for the incident."
  exit 1
fi

# ── the other half: a tenant LimitRange must not carry `max` ───────────
# A LimitRange polices every container in the namespace, and the platform
# runs its own Jobs in a tenant namespace — the file-backup Job declares 1.5
# cores. A `max` at the tenant's ceiling refused it outright and took the
# file backups of 24 of 31 namespaces down without failing the backup run:
# every other component succeeded, so it reported `partial`.
#
# `default` is the bound that matters and stays; `max` only refuses a
# container that DECLARES more, which under the tier model is never a
# tenant's own application.
while IFS= read -r hit; do
  echo "::error::$hit"
  fail=1
done < <(grep -rn "max: { cpu" backend/src --include='*.ts' | grep -v '\.test\.ts:' || true)

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "A tenant LimitRange must not set max.cpu — it refuses the platform's"
  echo "own Jobs in that namespace. Bound the tenant with 'default' instead."
  exit 1
fi

echo "ci-no-tenant-cpu-ceiling-quota: OK — no quota limits.cpu, no LimitRange max"
