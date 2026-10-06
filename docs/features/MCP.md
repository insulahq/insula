# AI agents (MCP) & API tokens — architecture

Operator docs: `documentation/docs/admin/ai-agents-and-api-tokens.md`. Code: `backend/src/modules/mcp/`,
`backend/src/shared/api-scope.ts`, `middleware/auth.ts`.

## No second API

Agents do not get a parallel implementation of platform functions. `catalog.ts` collects Fastify's own
route table (`onRoute` hook, registered before any route) into an **operation catalog**; `executor.ts`
runs a catalog operation by `app.inject`-ing a real request to the route, with a 2-minute access JWT
minted for the token's owner that carries the token's scopes (`apiToken` claim). Guards, validation,
rate limiting, audit and scope checks are the route's own. A new route is an agent operation the
moment it exists.

Hand-written references are only the **core tools** (`tools.ts`: a name, a description and the route
they run, optionally fixed body fields) and the **exclusions** (`catalog.ts` `EXCLUSIONS`, or
`config.apiTokenForbidden` on a route). `tools.test.ts` scans every `app.<method>('<path>'` in the
source and fails when a core tool names a missing route or an exclusion no longer matches anything.

Input schemas come from the route: its JSON `schema`, or `config.apiBody` / `config.apiQuery` (the same
api-contracts Zod schema the handler validates with, converted by `z.toJSONSchema`).

## Scopes (`shared/api-scope.ts`)

`read` / `write` / `delete`. First match wins: `config.apiScope` on the route (a scope, or a function
of the request when the body decides — `files/delete` with `permanent`, `PATCH /tenants/:id` with
`status: archived`); GET/HEAD/OPTIONS → read; a non-GET path naming an irreversible action
(`delete|purge|wipe|destroy|drop|empty|erase|truncate|reset|restore|import|rollback|regenerate|rotate|recover|decommission|prune|reclaim|force`),
singular or plural (`/admin/restores/…`) → delete; DELETE → delete; else write. A false match only asks
for more scope; routes harmless despite their words (`/admin/restores/carts`, `prune-policy`,
`recover/repin`) say `apiScope: 'write'`. Enforced in `authenticate` (any hook stage) and again in a global
`preHandler` once the body is parsed, so neither hook order nor a body-less request skips a body rule.

Session requests carry no `apiToken` claim and are unaffected.

## Tokens (`tokens.ts`)

Opaque, prefixed (`insula_pat_…`, `insula_oat_…`), stored as SHA-256 only (`mcp_tokens`). Resolved per
request with a 30 s cache; on every resolve the owner must be active, admin-panel, and hold
`MCP_ALLOWED_ROLE` (`admin`). PATs authenticate on the whole REST API (`authenticate`) and on MCP;
OAuth tokens only on MCP, and only for the resource they were issued for (RFC 8707). Token management
routes and the consent API are `apiTokenForbidden` (a token cannot mint tokens), and so is
`POST /admin/impersonate/:tenantId` — it hands out a one-hour tenant credential that would outlive the
token's revocation. An agent's `asTenant` instead mints a 2-minute tenant JWT in-process
(`tenants/impersonation.ts`, shared with the route) carrying the token's `apiToken` claim; it never
leaves the server. A leased reaper (15 min) deletes expired credentials and unreferenced OAuth clients
(never approved: 1 day; idle: 30 days).

## OAuth (`oauth.ts`)

RFC 9728 / 8414 discovery at the admin host root (admin-panel nginx forwards them), open RFC 7591
registration of public clients (https / loopback / private-use redirect URIs; capped at 2000 clients — when
full, the oldest never-approved client without a token is evicted, so a registration flood cannot lock real
clients out),
`authorize` → parked `mcp_oauth_requests` row → admin-panel `/oauth/consent` (shows the redirect host, the
client's registration time, and a warning when nobody has approved it before) → session-only consent API
→ single-use code (hash) → `token` with PKCE S256 → 8 h access token, no refresh. Errors use OAuth's
JSON format, not the platform envelope. CORS is `*` without credentials for the agent paths only
(`paths.ts`, delegator in `app.ts`).

When the admin panel is behind OAuth2 Proxy, `ingress-proxy-manager.ts` adds `platform-agent-endpoints`
with two routes above the proxied panel route:

- priority 100, no middleware — the endpoints that authenticate themselves, by EXACT path
  (`SELF_AUTHENTICATING_PATHS` in `paths.ts`: MCP, OAuth register/authorize/token/revoke, the discovery
  documents). Never a prefix with an exclusion — `/api/v1/oauth//requests` escapes one at the edge and nginx
  merges the slashes behind it. `mcp-flow.test.ts` holds the list equal to the registered `skipAuth` routes;
- priority 99 — `/api/v1/*` with an `insula_pat_` bearer, through the `platform-agent-token-auth`
  ForwardAuth middleware → `GET /api/v1/internal/agent-token-check` on platform-api (204 for a live PAT,
  else 401; own rate-limit bucket). The header shape only routes; the token is checked at the edge, so a
  made-up header never reaches the backend behind the proxy. OAuth tokens are MCP-only and get no API route.

## MCP endpoint (`server.ts`)

`POST /api/v1/mcp`, Streamable HTTP, stateless (`sessionIdGenerator: undefined`, JSON responses).
401 + `WWW-Authenticate: Bearer resource_metadata=…` without a valid token. GET/DELETE → 405.
