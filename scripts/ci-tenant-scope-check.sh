#!/usr/bin/env bash
# Verify every tenant-scoped API route is actually scoped to a tenant.
#
# WHY:
#   `/api/v1/tenants/:tenantId/...` takes the tenant from the URL. If the
#   route does not also verify that the CALLER owns that tenant, `tenantId`
#   is just an attacker-chosen path segment. Two modules had shipped that
#   way:
#     - a (since retired) file-edit route resolved the VICTIM's
#                        namespace and read their files through the
#                        file-manager sidecar (cross-tenant disclosure)
#     - container-console → GET /tenants/:tenantId/.../components leaked
#                        any tenant's pod/container topology
#   Both were `onRequest: [authenticate]` and nothing else.
#   Six more (route OIDC, OIDC providers, route mTLS, deployment network
#   access, Ziti and zrok providers) named the parameter `:cid`. The shared
#   middleware reads only `:tenantId` / `:id`, and this guard only looked for
#   `:tenantId`, so both missed them: any tenant_admin could read, change or
#   delete another tenant's settings by putting that tenant's id in the URL.
#
# THE CONTRACT
#   A backend module that registers a `/tenants/:tenantId/` route must do
#   ONE of the following, and this guard checks for it:
#
#     (a) use `requireTenantAccess()` — the shared middleware; or
#     (b) be gated to platform staff only, i.e. every route in the file
#         sits behind `requireRole(...)` with NO tenant role in the list
#         (no `tenant_admin` / `tenant_user`), so a tenant token can never
#         reach it; or
#     (c) be listed in ALLOWLIST below with a written reason (for modules
#         that enforce scoping by another audited mechanism — e.g. the WS
#         upgrade handlers that can't use onRequest hooks).
#
#   The tenant path parameter MUST be named `:tenantId` (or `:id` when the
#   tenant IS the resource, e.g. GET /tenants/:id): requireTenantAccess()
#   reads those two names and no other, so any other name silently disables
#   it. A route naming it anything else fails here, whatever else it does.
#
# Exit 1 on any module that satisfies none of the three.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODULES_DIR="$REPO_ROOT/backend/src/modules"

# Modules that scope tenants by an audited mechanism other than the
# `requireTenantAccess()` hook. Each entry MUST carry a reason.
declare -A ALLOWLIST=(
  # WebSocket upgrade handlers run outside the onRequest hook chain, so
  # they call a local fail-closed `enforceTenantAccess(user, tenantId)`
  # helper plus an explicit role check inside the handler. The plain-HTTP
  # route in the same file DOES use the middleware.
  [container-console]="WS upgrade handlers use a local fail-closed enforceTenantAccess() + role gate"
  # shared.ts is a helper module (no app.get/post registrations of its
  # own); its callers are the admin-only backup-restore routes.
  [backup-restore]="helper module; callers are super_admin/admin-gated restore routes"
)

failures=0
checked=0

# Tenant-facing roles. A requireRole() list containing any of these means
# a tenant token can reach the route, so tenant scoping is mandatory.
TENANT_ROLES_RE="tenant_admin|tenant_user"

while IFS= read -r file; do
  rel="${file#"$REPO_ROOT"/}"
  module=$(basename "$(dirname "$file")")

  # Only route-registering files matter.
  grep -qE "app\.(get|post|put|patch|delete)" "$file" || continue

  checked=$((checked + 1))

  # The parameter name requireTenantAccess() can see, or nothing protects it.
  # Route strings only: code lines (not comments), inside a quoted path.
  bad_params=$(grep -vE '^[[:space:]]*(\*|//|/\*)' "$file" \
    | grep -oE "['\"\`][^'\"\`]*tenants/:[A-Za-z0-9_]+" | grep -oE "tenants/:[A-Za-z0-9_]+" \
    | sort -u | grep -vE "^tenants/:(tenantId|id)$" || true)
  if [[ -n "$bad_params" ]]; then
    echo "FAIL: $rel names the tenant path parameter $(echo "$bad_params" | tr '\n' ' ')"
    echo "      requireTenantAccess() reads only :tenantId / :id — rename it to :tenantId."
    failures=$((failures + 1))
    continue
  fi

  # (a) the shared middleware
  if grep -q "requireTenantAccess" "$file"; then
    continue
  fi

  # (c) allowlisted with a reason
  if [[ -n "${ALLOWLIST[$module]:-}" ]]; then
    echo "  allow: $rel — ${ALLOWLIST[$module]}"
    continue
  fi

  # (b) staff-only: the file must gate with requireRole/requirePanel AND
  #     must not name any tenant-facing role anywhere in a role list.
  if grep -qE "requireRole\(|requirePanel\(" "$file" \
     && ! grep -E "requireRole\([^)]*\)" "$file" | grep -qE "$TENANT_ROLES_RE"; then
    continue
  fi

  echo "FAIL: $rel registers a /tenants/:tenantId/ route reachable by a tenant token"
  echo "      but never calls requireTenantAccess()."
  echo "      Fix: add requireTenantAccess() to the route's onRequest hooks,"
  echo "      or restrict the route to platform staff via requireRole()."
  failures=$((failures + 1))
done < <(grep -rlE "tenants/:[A-Za-z0-9_]+" "$MODULES_DIR" --include='*.ts' | grep -v '\.test\.ts$' | sort)

# Per route: the checks above pass a whole file that mentions
# requireTenantAccess anywhere, so one open route in a guarded module passed
# (GET /tenants/:tenantId/resource-quota did). Every route that names a tenant
# must be staff-only or behind requireTenantAccess() itself.
if ! python3 -I "$REPO_ROOT/scripts/lib/tenant-scope-routes.py" "$MODULES_DIR" "${!ALLOWLIST[@]}"; then
  echo "      Fix: add requireTenantAccess() to that route's onRequest hooks,"
  echo "      or restrict the route to platform staff via requireRole()."
  failures=$((failures + 1))
fi

echo
echo "ci-tenant-scope-check: inspected $checked tenant-scoped route module(s)"

if [[ $failures -gt 0 ]]; then
  echo "ci-tenant-scope-check: FAILED ($failures module(s))"
  exit 1
fi

echo "ci-tenant-scope-check: PASS"
