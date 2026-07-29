# HSTS (HTTP Strict Transport Security)

**Last Updated:** 2026-07-28
**Status:** Implemented
**Audience:** Operators, tenant-facing support, backend developers

---

## Overview

HSTS is configured **per ingress route**, in the tenant panel under
**Route → Advanced → HSTS**. It is off by default on every route.

The policy is emitted at the edge (a Traefik `headers` Middleware), **not** by the
workload image. That is deliberate:

- The Official Catalog runtimes (`nginx`, `apache`, `nginx-php`, `apache-php`) ship
  **no** `Strict-Transport-Security` header of their own. A tenant can switch
  runtime, or bring their own container, without silently losing or gaining the
  policy.
- The route already owns the TLS certificate, the `forceHttps` redirect and the
  hostname. HSTS is a statement about that hostname, so it belongs with them.
- One place to audit. `ingress_routes` is the single source of truth for routing;
  the reconciler rebuilds the Middleware from it on every sync.

> The admin and tenant **panels** serve their own HSTS header from their nginx
> config (`frontend/security-headers.conf`, `NGINX_HSTS_MAX_AGE`). That is the
> platform's own UI and is unrelated to tenant routes.

## Settings

| Field | Column | Default | Notes |
| --- | --- | --- | --- |
| Enable HSTS | `hsts_enabled` | `0` (off) | Requires working HTTPS on the route |
| max-age | `hsts_max_age` | `31536000` (1 year) | Seconds; `0` revokes; capped at 2 years |
| includeSubDomains | `hsts_include_subdomains` | `0` | Applies to **every** subdomain, including ones not hosted here |
| preload | `hsts_preload` | `0` | Requires includeSubDomains + max-age ≥ 1 year |

API: `PATCH /api/v1/tenants/:tenantId/routes/:routeId/advanced` with
`hsts_enabled`, `hsts_max_age`, `hsts_include_subdomains`, `hsts_preload`.

## Behaviour

- The header is **only sent over HTTPS.** Traefik attaches STS headers to TLS
  responses only; the platform never sets `forceSTSHeader`, which is the flag that
  would force it onto plain HTTP. RFC 6797 §7.2 requires user agents to ignore the
  header on a non-secure transport anyway, so emitting it there is pure noise.
- The HSTS Middleware is placed **first** in the route's middleware chain.
  Traefik unwinds the chain in reverse on the response, so anything that
  short-circuits — an IP-allowlist `403`, a rate-limit `429`, a redirect `301`, a
  custom error page — still passes back through it and carries the header. Placed
  later, those responses would silently drop the policy.
- Changing the settings takes effect on the next route reconcile; no workload
  restart is involved.

## The preload contract

`preload` is only accepted together with `includeSubDomains` and a max-age of at
least `31536000`. That rule is enforced in three places:

1. the panel disables Save and explains why,
2. `settings-service` validates the **merged** row (request + stored state), so a
   partial API update cannot produce an invalid combination, and
3. a `CHECK` constraint in migration `0077`.

Setting the flag does **not** submit the domain anywhere. Submission is a separate
manual step at [hstspreload.org](https://hstspreload.org), and **removal from the
preload list takes months** — treat it as close to irreversible.

## Backing out safely

HSTS is sticky: a browser that has seen the header refuses plain HTTP for the whole
max-age, and the server cannot recall it. To withdraw a policy:

1. set **max-age to `0`** and leave HSTS enabled,
2. wait long enough for returning visitors to pick up the `max-age=0` response
   (at minimum the old max-age, in practice as long as you can afford),
3. then switch the toggle off.

Switching the toggle off first simply stops sending the header — every browser that
already cached the old policy keeps enforcing it until it expires.

## Implementation

| Concern | Location |
| --- | --- |
| Columns + CHECK constraint | `backend/src/db/migrations/0077_ingress_route_hsts.sql` |
| Persistence + preload validation | `backend/src/modules/ingress-routes/settings-service.ts` (`updateAdvancedSettings`) |
| Middleware emission + ordering | `backend/src/modules/ingress-routes/annotation-sync.ts` |
| Traefik spec fields | `backend/src/modules/ingress-routes/traefik-types.ts` (`headersSpec`) |
| Contract | `packages/api-contracts/src/ingress-routes.ts` |
| UI | `frontend/tenant-panel/src/pages/RouteDetail.tsx` (Advanced tab) |
| Tests | `backend/src/modules/ingress-routes/annotation-sync.hsts.test.ts` |
