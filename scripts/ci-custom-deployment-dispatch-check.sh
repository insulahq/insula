#!/usr/bin/env bash
# ci-custom-deployment-dispatch-check.sh — guard against the "silent skip"
# regression in the generic deployment lifecycle (ADR-036 custom deployments).
#
# THE BUG THIS EXISTS TO PREVENT
# ------------------------------
# `deployments/service.ts` was written for catalog deployments. Every
# lifecycle verb resolved a `catalogEntries` row and then guarded the
# Kubernetes half of the operation behind `if (entry) { … }`.
#
# Custom deployments have `catalog_entry_id IS NULL` by construction, so
# every one of those guards evaluated false and the cluster work was skipped
# IN SILENCE — the DB row was updated, HTTP 200 was returned, and
# `last_error` stayed empty because nothing had failed. Nothing was attempted.
#
# Production, 2026-09-02: an operator reduced a custom deployment from 4 CPU
# to 1 and stopped it. The row said `cpu_request=1, status=stopped`; the Pod
# was still Running on 4 cores. That pinned the tenant's `requests.cpu` quota
# at its ceiling and left a sibling catalog deployment permanently
# unschedulable with `FailedCreate: exceeded quota`. Hard-delete was worse
# still: it removed the row and orphaned the workload with nothing left in
# the DB to explain the consumed quota.
#
# The gap is structural, not a typo: nothing in the type system or the unit
# tests can see that a `catalogEntries` lookup will miss for a whole class of
# rows. Hence a grep-level guard.
#
# CHECKS
#   1. Every generic lifecycle function that touches the cluster must branch
#      on `isCustomDeployment` — enumerated explicitly so a NEW function is a
#      deliberate addition to this list, not a silent omission.
#   2. `deployments/service.ts` must contain no bare `if (entry) {` guard —
#      that exact shape IS the bug. Use `if (!entry) throw …` (fail loudly)
#      or dispatch on `source` first.
#   3. `custom-dispatch.ts` must exist and export the verbs service.ts needs.
#
# Exits non-zero on any violation.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SERVICE="$REPO_ROOT/backend/src/modules/deployments/service.ts"
DISPATCH="$REPO_ROOT/backend/src/modules/deployments/custom-dispatch.ts"

fail=0
err() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=1; }
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; }

echo "ci-custom-deployment-dispatch-check: generic lifecycle must dispatch on source"

for f in "$SERVICE" "$DISPATCH"; do
  [ -f "$f" ] || { err "missing required file: ${f#"$REPO_ROOT"/}"; }
done
[ "$fail" -eq 0 ] || exit 1

# ── 1. Lifecycle functions that must dispatch ────────────────────────────────
# Each entry: <function-name>. The body of each (up to the next top-level
# `export async function` / `export function`) must mention isCustomDeployment.
LIFECYCLE_FNS=(
  updateDeployment
  deleteDeployment
  restoreDeployment
  hardDeleteDeployment
  updateDeploymentResources
  redeployWithCurrentConfig
)

for fn in "${LIFECYCLE_FNS[@]}"; do
  body=$(awk -v fn="$fn" '
    $0 ~ "^export (async )?function " fn "\\(" { inside=1 }
    inside { print }
    inside && /^}/ && !($0 ~ "^export") { inside=0 }
  ' "$SERVICE")

  if [ -z "$body" ]; then
    err "$fn: not found in deployments/service.ts (renamed? update this guard deliberately)"
    continue
  fi
  if ! grep -q 'isCustomDeployment' <<<"$body"; then
    err "$fn: touches the cluster but never branches on isCustomDeployment — custom rows would be skipped in silence"
  else
    ok "$fn dispatches on source"
  fi
done

# ── 2. The exact buggy shape must not reappear ───────────────────────────────
# `if (entry) {` means "quietly do nothing when the catalog lookup misses".
#
# Match CODE only. These same strings appear in the comments that explain the
# bug, and a guard that blames a comment is a guard people learn to ignore —
# so strip line comments and block-comment bodies first, keeping line numbers
# intact (blank them rather than delete them) for accurate reporting.
code_only() {
  sed -E 's@^([[:space:]]*)(//|\*|/\*).*@\1@' "$1"
}

CODE=$(code_only "$SERVICE")

if grep -nE '^\s*if \(entry\) \{' <<<"$CODE" >/dev/null; then
  err "bare 'if (entry) {' found in deployments/service.ts — this is the silent-skip shape:"
  grep -nE '^\s*if \(entry\) \{' <<<"$CODE" | sed 's/^/        /'
  echo "        Use 'if (!entry) throw catalogEntryNotFound(...)' or dispatch on source first." >&2
else
  ok "no bare 'if (entry) {' silent-skip guard"
fi

# Same for the resources path's compound form.
if grep -nE 'if \(entry && namespace\)' <<<"$CODE" >/dev/null; then
  err "'if (entry && namespace)' found — silently skips the redeploy for custom rows"
  grep -nE 'if \(entry && namespace\)' <<<"$CODE" | sed 's/^/        /'
else
  ok "no 'if (entry && namespace)' compound skip"
fi

# ── 3. The dispatch module must export what service.ts relies on ─────────────
for sym in isCustomDeployment customSpecImages dispatchCustomStop dispatchCustomStart \
           dispatchCustomScale dispatchCustomHardDelete dispatchCustomResources \
           dispatchCustomRedeploy; do
  if ! grep -qE "export (async )?function $sym\b" "$DISPATCH"; then
    err "custom-dispatch.ts does not export '$sym'"
  fi
done
[ "$fail" -eq 0 ] && ok "custom-dispatch.ts exports all lifecycle verbs"

# ── 4. Custom rows must never be resource-edited via the row projection ──────
# `deployments.cpu_request` is DERIVED from custom_spec for custom rows;
# writing it directly desynchronises the row from the spec that renders the
# pod. The dispatch must run BEFORE the row write in updateDeploymentResources.
res_body=$(awk '
  /^export async function updateDeploymentResources\(/ { inside=1 }
  inside { print }
  inside && /^}/ && !($0 ~ "^export") { inside=0 }
' "$SERVICE")
dispatch_line=$(grep -n 'dispatchCustomResources' <<<"$res_body" | head -1 | cut -d: -f1 || true)
write_line=$(grep -n 'db.update(deployments).set(updateValues)' <<<"$res_body" | head -1 | cut -d: -f1 || true)
if [ -n "$dispatch_line" ] && [ -n "$write_line" ]; then
  if [ "$dispatch_line" -lt "$write_line" ]; then
    ok "updateDeploymentResources dispatches before writing the row projection"
  else
    err "updateDeploymentResources writes cpu_request/memory_request BEFORE dispatching custom rows — the row would desync from custom_spec"
  fi
else
  err "updateDeploymentResources: could not locate both the dispatch and the row write"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "ci-custom-deployment-dispatch-check: FAILED" >&2
  exit 1
fi
echo "ci-custom-deployment-dispatch-check: PASS"
