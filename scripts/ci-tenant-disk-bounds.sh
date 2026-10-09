#!/usr/bin/env bash
# ci-tenant-disk-bounds.sh — no backend-built pod gets an emptyDir without a
# size limit, and the tenant pod builders keep bounding every container
# (ROADMAP R37).
#
# Why this guard exists
# ---------------------
# A disk-backed emptyDir with no `sizeLimit`, and a container with no
# `ephemeral-storage` limit, write to the NODE's root disk without bound —
# the disk etcd, Longhorn and every other tenant share. One runaway tenant
# workload could fill it: the kubelet then evicts pods across tenants, taints
# the node so nothing new schedules, and etcd stalls. R37 bounds every tenant
# pod through `boundTenantPodDisk` (backend/src/modules/tenant-disk/); this
# guard keeps the two ways back to "unbounded" closed:
#
#   1. a literal `emptyDir: {}` anywhere in backend/src (tests excluded), unless
#      the file is listed below with the reason it is out of scope;
#   2. a tenant pod builder that stops routing its pod spec through
#      `boundTenantPodDisk` (the rendered shapes are pinned by
#      deployments/disk-bounds.deployer.test.ts and
#      custom-deployments/disk-bounds.deployer.test.ts; this catches the
#      builder dropping the call before a test is even run).
#
# REPO_ROOT may be overridden (negative tests use a temp tree).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SRC="$REPO_ROOT/backend/src"

# file (relative to backend/src) → why an unbounded emptyDir is acceptable there
declare -A ALLOW_UNBOUNDED_EMPTYDIR=(
  ["modules/mail-admin/archive.ts"]="platform mail namespace, not a tenant's: the mailbox-archive Job stages a copy of the mail store, whose size the platform does not choose — bounding it is a separate decision (R37 residuals)"
  ["modules/deployment-network-access/reconciler.ts"]="platform-run Ziti/zrok proxies (platform code, tenant-agnostic): their spec is re-applied on every reconcile, so a cap would restart every proxy at upgrade; out of R37 scope by decision, listed in docs/operations/TENANT_DISK_LIMITS.md"
)

# builder file → how many pod specs it renders (each must be bounded)
declare -A BOUNDED_BUILDERS=(
  ["modules/deployments/k8s-deployer.ts"]=3      # Deployment, CronJob, Job
  ["modules/custom-deployments/k8s-deployer.ts"]=1
)

failures=0
fail() { echo "  $1"; failures=$((failures + 1)); }

echo "── tenant disk bounds guard ───────────────────────────────────────────"

[[ -d "$SRC" ]] || { echo "ci-tenant-disk-bounds: $SRC not found" >&2; exit 1; }

while IFS= read -r hit; do
  file="${hit%%:*}"
  rel="${file#"$SRC"/}"
  if [[ -n "${ALLOW_UNBOUNDED_EMPTYDIR[$rel]:-}" ]]; then continue; fi
  fail "unbounded emptyDir: backend/src/${rel}:${hit#*:} — give it a sizeLimit (TENANT_EMPTYDIR_SIZE_LIMIT for small pod-local state)"
done < <(grep -rnE "emptyDir:[[:space:]]*\{[[:space:]]*\}" "$SRC" --include='*.ts' --exclude='*.test.ts' || true)

for rel in "${!BOUNDED_BUILDERS[@]}"; do
  want="${BOUNDED_BUILDERS[$rel]}"
  f="$SRC/$rel"
  if [[ ! -f "$f" ]]; then fail "tenant pod builder backend/src/$rel is gone — update this guard, do not delete it"; continue; fi
  got=$(grep -cE "boundTenantPodDisk\(" "$f" || true)
  if (( got < want )); then
    fail "backend/src/$rel renders $want tenant pod spec(s) but routes only $got through boundTenantPodDisk()"
  fi
done

if (( failures > 0 )); then
  echo
  echo "ci-tenant-disk-bounds: FAIL — ${failures} problem(s). An unbounded tenant pod can fill a node's disk for every tenant on it." >&2
  exit 1
fi
echo "ci-tenant-disk-bounds: OK — no unbounded emptyDir outside the documented exceptions; ${#BOUNDED_BUILDERS[@]} tenant pod builder(s) bound every pod spec."
