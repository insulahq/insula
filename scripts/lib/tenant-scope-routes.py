#!/usr/bin/env python3
"""Per-route stage of ci-tenant-scope-check.sh.

The file-level stage passes a module that mentions requireTenantAccess
anywhere, so a module that guards SOME routes (or only imports it) passed while
another route in it stayed open: GET /tenants/:tenantId/resource-quota let any
signed-in tenant read any other tenant's limits. This stage looks at every
route whose path names a tenant (`tenants/:<param>`) and fails when a tenant
token can reach it without requireTenantAccess().

A route counts as tenant-reachable unless the roles that apply to it (its own
`requireRole(...)`, or the file's `addHook('onRequest', requireRole(...))`)
name no tenant role, or it is gated to the admin panel. Gate lists held in a
local const (`const adminGate = [authenticate, requireRole(...)]`) are resolved.

Usage: tenant-scope-routes.py <backend/src/modules> [module-to-skip ...]
Exit 1 when any route fails.
"""
import pathlib
import re
import sys

ROUTE = re.compile(r"app\.(get|post|put|patch|delete)\(\s*['\"`]([^'\"`]*tenants/:[A-Za-z0-9_]+[^'\"`]*)['\"`]")
FILE_HOOK = re.compile(r"addHook\(\s*'(?:onRequest|preHandler)'\s*,\s*([A-Za-z]+\([^)]*\))")
CONST_GATE = re.compile(r"const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[([^\]]*)\]")
ROUTE_GATE = re.compile(
    r"(?:onRequest|preHandler)\s*:\s*(\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_]*\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)"
)
TENANT_ROLE = re.compile(r"tenant_admin|tenant_user")


def strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"(^|[^:])//[^\n]*", r"\1", src)


def guards(text: str) -> dict:
    roles = re.findall(r"requireRole\(([^)]*)\)", text)
    return {
        "roles": roles,
        "tenant_access": "requireTenantAccess()" in text,
        "admin_panel": "requirePanel('admin')" in text,
        "tenant_role_by_method": "requireTenantRole" in text,
    }


def main() -> int:
    root = pathlib.Path(sys.argv[1])
    skip = set(sys.argv[2:])
    failures = 0
    for path in sorted(root.rglob("*.ts")):
        if path.name.endswith(".test.ts") or path.parent.name in skip:
            continue
        src = strip_comments(path.read_text())
        routes = list(ROUTE.finditer(src))
        if not routes:
            continue
        consts = {m.group(1): m.group(2) for m in CONST_GATE.finditer(src)}
        file_g = guards(" ".join(FILE_HOOK.findall(src)))
        for i, m in enumerate(routes):
            end = routes[i + 1].start() if i + 1 < len(routes) else len(src)
            # Options sit between the path and the handler.
            head = re.split(r"\basync\b|=>", src[m.end(): min(end, m.end() + 1200)], maxsplit=1)[0]
            gate_text = ""
            for g in ROUTE_GATE.findall(head):
                # A local const gate list is resolved; an inline list or call is used as is.
                gate_text += " " + consts.get(g, g)
            route_g = guards(gate_text)
            roles = route_g["roles"] or file_g["roles"]
            tenant_access = route_g["tenant_access"] or file_g["tenant_access"]
            admin_only = route_g["admin_panel"] or file_g["admin_panel"] or (
                bool(roles) and not any(TENANT_ROLE.search(r) for r in roles)
            )
            if admin_only or tenant_access:
                continue
            failures += 1
            rel = path.relative_to(root.parent.parent.parent)
            print(f"FAIL: {rel}: {m.group(1).upper()} {m.group(2)} is reachable by a tenant token "
                  f"(roles: {', '.join(r.strip() for r in roles) or 'any signed-in user'}) "
                  "without requireTenantAccess().")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
