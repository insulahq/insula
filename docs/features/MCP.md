# AI agents (MCP) & API tokens — architecture

Operator docs: `documentation/docs/admin/ai-agents-and-api-tokens.md`. Code: `backend/src/modules/mcp/`,
`backend/src/shared/api-scope.ts`, `middleware/auth.ts`.

## Two endpoints, one backend

Each panel host has its own MCP endpoint, OAuth server and consent page: `admin.<apex>` for admins
(role `admin`), `tenant.<apex>` for tenant users. One backend serves both; `paths.ts:audienceForHost`
reads a request's AUDIENCE from its Host (the panels' nginx passes it unchanged, including the two
`/.well-known/oauth-*` documents). The host only picks which URLs and consent page are presented —
what a token may do comes from the token: every OAuth token names its endpoint (RFC 8707 resource),
and `server.ts` refuses one presented at the other host. A PAT is an admin credential and works on the
admin host only.

A tenant agent is the tenant user who approved it. `executor.ts` runs its calls with that user's own
tenant-panel claims (`sub`, `role`, `panel: tenant`, `tenantId`) and fills the tenant path parameter
(`/tenants/:tenantId/…` or `/tenants/:id/…`) with the connection's tenant, whatever the agent passed;
`asTenant` does not exist there. Its tool list is `TENANT_CORE_TOOLS` plus the three generic tools,
and search hides admin-only operations (`tools.ts:tenantVisible`) — the routes' own guards still decide.

The operator switch `platform_settings.mcp_tenant_agents_enabled` (Security → AI Agents) is OFF unless
set to `true` — an upgrade does not open every tenant to agents. It gates tenant consent and every
tenant token resolve; switching it off also revokes every tenant connection.

A route that creates, resets or hands out a free-standing credential (sub-user create / reset-password,
SSH keys, SFTP users, DB users, protected-dir users, mailbox create, login passwords, mTLS issue-cert,
webmail-token, bundle export-token) carries `config.issuesCredential`. `enforceApiScope` refuses it to a
call whose `apiToken.audience` is `tenant` (403 `AGENT_CREDENTIAL_NOT_ALLOWED`), and the catalog hides it
from tenant agents: such a credential would outlive the connection's 8 h and its Disconnect. Admin
agents and PATs are not affected. Mark any new route of that kind.

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

## Tokens and connections (`tokens.ts`)

Opaque, prefixed (`insula_pat_…`, `insula_oat_…` access, `insula_ort_…` refresh), stored as SHA-256 only.
An approval on a consent page becomes a CONNECTION (`mcp_connections`: user, audience, tenant, client,
scopes, resource, the current refresh-token hash). Under it the client holds a 1-hour access token
(`mcp_tokens`, `kind = 'oauth'`, `connection_id`) and renews it with the refresh token, which is
REPLACED on every use (compare-and-swap on the hash; the spent one is kept as `previous_refresh_hash`,
and presenting it again revokes the connection — RFC 9700 reuse detection). The connection ends
`MCP_CONNECTION_MAX_SECONDS` (8 h) after approval: no access token is issued past it and no refresh
works after it. Revoking the connection — the user, a tenant admin for their tenant, a super_admin/admin
for anyone, the client through RFC 7009, or the tenant switch — ends every token under it.

Resolved per request with a 30 s cache. On every resolve the owner must be active, and: a PAT or admin
connection needs an admin-panel user holding `MCP_ALLOWED_ROLE` (`admin`); a tenant connection needs a
tenant-panel user still in the tenant it was approved for, and tenant agents switched on. PATs (admin
only) authenticate on the whole REST API (`authenticate`) and on the admin MCP endpoint; OAuth tokens
only on MCP, and only for the resource they were issued for (RFC 8707). Token and connection management
routes and the consent API are `apiTokenForbidden` (a token cannot mint, list or revoke credentials), and
so is `POST /admin/impersonate/:tenantId` — it hands out a one-hour tenant credential that would outlive
the token's revocation. An admin agent's `asTenant` instead mints a 2-minute tenant JWT in-process
(`tenants/impersonation.ts`, shared with the route) carrying the token's `apiToken` claim; it never
leaves the server. A leased reaper (15 min) deletes expired access tokens, connections a day after they
ended or were revoked (their tokens cascade), and unreferenced OAuth clients (never approved: 1 day;
idle: 30 days).

Management routes (`token-routes.ts`, all session-only): `/admin/mcp/tokens` (own PATs + own
connections), `/admin/mcp/connections` (every connection, super_admin/admin), `/admin/mcp/settings`
(the tenant switch), `/tenants/:tenantId/mcp-agents` (tenant panel: own connections, or the whole
tenant's for a tenant_admin — under `/tenants/:tenantId` so the audit log files a revoke under the
tenant). Both panels poll their list once a minute for the header chip.

## OAuth (`oauth.ts`)

RFC 9728 / 8414 discovery at each panel host's root (both panels' nginx forward them), open RFC 7591
registration of public clients (https / loopback / private-use redirect URIs; capped at 2000 clients — when
full, the oldest never-approved client without a token or connection is evicted, so a registration flood
cannot lock real clients out),
`authorize` → parked `mcp_oauth_requests` row (resource = that host's MCP endpoint) → that panel's
`/oauth/consent` (shows the redirect host, the client's registration time, and a warning when nobody has
approved it before) → session-only consent API → single-use code (hash) → `token` with PKCE S256 → a
connection: 1 h access token + refresh token (`grant_type=refresh_token`, rotated). Errors use OAuth's
JSON format, not the platform envelope. CORS is `*` without credentials for the agent paths only
(`paths.ts`, delegator in `app.ts`).

The consent API (`assertMayConnect`) lets a request's audience be approved only by: an admin-panel user
with role `admin` (admin endpoint); a tenant-panel user signed in as THEMSELVES while tenant agents are on
(tenant endpoint). An impersonation session (`impersonatedBy`) is refused — approving there would hand
staff a tenant credential that outlives the impersonation and is audited as the tenant. The code exchange
checks the approving user again.

When the admin panel is behind OAuth2 Proxy, `ingress-proxy-manager.ts` adds `platform-agent-endpoints`
with two routes above the proxied panel route. The proxy itself never gates `/api/`
(`--skip-auth-route=^/api/` in `panel-proxy.ts` — the API authenticates every call), but the panel
route's sign-in `errors` middleware rewrites EVERY 401 on that host, the backend's included, into a
302 to `/oauth2/sign_in`. Without these routes the MCP endpoint's 401 + `WWW-Authenticate` challenge
would reach an agent as a browser redirect and no MCP client could start its OAuth sign-in; a script
with a bad token would get a sign-in page instead of a 401. Both carry the panel route's own edge guards
(`PANEL_EDGE_GUARDS` in `system-settings/ingress-reconciler.ts`: CrowdSec first, body cap + ModSecurity
last) — skipping the proxy never skips the ban list or the WAF:

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
401 + `WWW-Authenticate: Bearer resource_metadata=…` (that host's metadata) without a valid token for
this host's endpoint. GET/DELETE → 405.

A proxy-protected TENANT panel gets `platform-tenant-agent-endpoints` (`ingress-proxy-manager.ts`): the
same self-authenticating exact paths on the tenant host, priority 100, with the panel's edge guards. No
PAT route there — tenants hold no PATs.

## WAF

CRS 934110 ("SSRF: cloud provider metadata URL in parameter") matches the RFC 8252 loopback redirect URIs
every desktop MCP client registers (`http://127.0.0.1:<port>/…`, `http://localhost:<port>/…`) and refused
registration, authorize and token with a bare nginx 403. Exclusion `9000117`
(`k8s/base/modsecurity-crs/exclusion-rules-configmap.yaml`) removes it on exactly
`/api/v1/oauth/(register|authorize|token)` of the two panel hosts: the OAuth server never fetches a redirect
URI, it only sends the browser there.

