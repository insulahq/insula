#!/usr/bin/env bash
# ci-admin-route-role-check.sh — an /admin/* route must name its own role.
#
# WHY. Tenant-scoped route files apply two blanket hooks:
#
#     app.addHook('onRequest', requireTenantRoleByMethod());
#     app.addHook('onRequest', requireTenantAccess());
#
# Neither restricts an /admin/* route to operators. `requireTenantRoleByMethod`
# permits tenant_admin and tenant_user on GET, and `requireTenantAccess` only
# compares a `:tenantId` PATH PARAM against the caller's claim — an /admin/*
# route has no such param, so the comparison is skipped and the request is
# allowed through.
#
# That is not theoretical. Verified against the running DEV cluster with a
# real tenant-panel token:
#
#     GET /api/v1/admin/cron-jobs        -> HTTP 200
#
# a cross-tenant listing served to a tenant user. The blanket hooks read like
# protection, which is what made it survive review.
#
# So every /admin/* registration must carry its own `requireRole(...)`, and
# this fails the build when one does not.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

missing=0
checked=0

# Guards can be declared two ways, and BOTH count:
#   1. per route:   onRequest: [authenticate, requireRole('super_admin', ...)]
#   2. per plugin:  app.addHook('onRequest', requireRole('super_admin', ...))
#
# The second is why the naive version of this script reported twelve routes
# in smtp-relay and mail-events that are in fact guarded — those files
# register their /admin/* routes inside a separate plugin function whose own
# addHook covers them. A guard that cries wolf gets switched off, so this
# resolves the ENCLOSING plugin function for each route before judging it.
while IFS= read -r file; do
  grep -q "requireTenantAccess()" "$file" || continue

  # Line numbers where a plugin function begins, so a route can be attributed
  # to the scope whose hooks actually apply to it.
  mapfile -t fn_starts < <(grep -nE "^(export )?async function [A-Za-z0-9_]+Routes" "$file" | cut -d: -f1)

  while IFS= read -r lineno; do
    checked=$((checked + 1))

    scope_start=1
    for fs in "${fn_starts[@]}"; do
      [ "$fs" -le "$lineno" ] && scope_start="$fs"
    done

    # Hooks declared in this scope, before the route.
    scope_hooks=$(sed -n "${scope_start},${lineno}p" "$file" \
      | grep -E "addHook\(\s*'onRequest'\s*,\s*requireRole" || true)
    # A guard named on the registration itself.
    own_guard=$(sed -n "${lineno},$((lineno + 3))p" "$file" | grep -E "requireRole" || true)

    if [ -z "$scope_hooks" ] && [ -z "$own_guard" ]; then
      route=$(sed -n "${lineno}p" "$file" | grep -oE "'/admin/[^']*'" | head -1)
      echo "UNGUARDED: $file:$lineno  $route"
      missing=$((missing + 1))
    fi
  done < <(grep -nE "app\.(get|post|put|patch|delete)\(\s*'/admin/" "$file" | cut -d: -f1)
done < <(find backend/src/modules -name 'routes.ts')

if [ "$missing" -gt 0 ]; then
  echo ""
  echo "$missing /admin/* route(s) inherit only the tenant hooks, which do NOT"
  echo "restrict them to operators: requireTenantRoleByMethod permits"
  echo "tenant_admin and tenant_user, and requireTenantAccess only compares a"
  echo ":tenantId PATH PARAM that an /admin/* route does not have."
  echo ""
  echo "    app.get('/admin/thing', {"
  echo "      onRequest: [authenticate, requireRole('super_admin', 'admin')],"
  echo "    }, async (request) => { ... });"
  exit 1
fi

echo "ci-admin-route-role-check: OK — $checked /admin/* route(s), all role-guarded."
