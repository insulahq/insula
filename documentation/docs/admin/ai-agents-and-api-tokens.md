# AI agents & API tokens

The platform can be driven by **AI agents** over the [Model Context Protocol
(MCP)](https://modelcontextprotocol.io) and by **scripts** over its REST API. Both act as a
person: the user who connected them, with that user's role, and never more.

There are two MCP endpoints, one per panel:

| | Admin panel | Tenant panel |
|---|---|---|
| Address | `https://admin.<your domain>/api/v1/mcp` | `https://tenant.<your domain>/api/v1/mcp` |
| Who can connect an agent | Users with the **admin** role | Any tenant user, once tenant agents are switched on (off by default) |
| The agent acts as | That admin | That tenant user, inside their tenant only |
| Managed under | **User Settings → API tokens & AI agents** | **User Settings → AI agents** (tenant panel) |

!!! note "Who can use the admin endpoint"
    Only users with the **admin** role can create API tokens or connect an AI agent to the admin
    panel. super_admins cannot (agents must not reach break-glass functions such as the node
    terminal).

## Two ways to grant access (admin panel)

| | Personal access token (PAT) | AI client sign-in (OAuth) |
|---|---|---|
| Created | **User Settings → API tokens & AI agents → New token** | The AI client connects to the MCP address; you approve it on a consent page |
| Works on | The whole REST API **and** the MCP endpoint | The MCP endpoint only |
| Lifetime | 7 days to 1 year, or never | 1-hour access, renewed by the client for **up to 8 hours** after approval; then it asks again |
| Shown | Once, at creation — copy it then | Never; the client holds it |

Tenant users have no PATs: their agents always sign in.

A signed-in AI client is a **connected agent**. Its access token lasts an hour; the client renews
it with a refresh token that is replaced on every renewal. Eight hours after you approved it the
connection ends and the client must ask again. Presenting a spent refresh token a second time —
a sign that two parties hold it — ends the connection at once.

**Disconnect** (agents) or **Revoke** (PATs) stops them within about 30 seconds. Disabling a user,
taking the admin role away from them, or moving a tenant user out of their tenant stops their
agents and tokens the same way — nobody has to revoke them separately.

## Seeing connected agents

- **Header chip.** While an agent is connected as you, a robot chip shows in the panel header; it
  links to the list where you can disconnect it. Tenant panels show the same chip.
- **Your own.** **User Settings → API tokens & AI agents** lists your connected agents and your
  PATs.
- **Every agent on the platform.** **Security → AI Agents** (super_admin and admin) lists every
  connected agent — admin and tenant — with who approved it and for which tenant, and disconnects
  any of them.
- **Tenant admins** see every agent connected to their tenant in their own User Settings, and can
  disconnect them.

## Switching tenant agents off

**Security → AI Agents → Tenant AI agents.** **Off by default** — on a new installation and on one
that upgrades — so no tenant account is opened to agents until you decide to. Switching it on lets
any tenant user connect an agent; switching it off again disconnects every tenant agent at once and
stops new ones; the tenant panel then says agents are switched off. Admin agents are not affected.

A tenant agent cannot create or reset anything that would keep working after it is disconnected —
panel users, passwords, SSH keys, SFTP and database logins, mailbox login passwords, client
certificates, webmail sign-ins, backup download links. Routes that do are marked `issuesCredential`
and refuse a tenant agent's call. Admin agents and PATs keep them.

## Scopes

Every token carries one or more scopes, and every API call is checked against them:

| Scope | Allows |
|---|---|
| **read** | Looking: every `GET` the user's role may make |
| **write** | Changing things: creating, updating, suspending a tenant, moving a tenant's file to the recycle bin |
| **delete** | Anything that cannot be undone: deleting, purging, emptying the trash, restoring or importing over existing data, disaster recovery, decommissioning, rolling back, resetting passwords, rotating credentials, archiving a tenant, running raw SQL |

The check happens on the API route itself, so a script and an agent are held to exactly the
same rule. A token never exceeds its user's role: a `delete`-scoped token of an admin still
cannot do what only a super_admin can, and a tenant user with read-only access gets a read-only
agent.

## Connecting an AI client

Copy the **MCP endpoint** shown in User Settings into your client:

- **Clients that sign in (OAuth)** — Claude, ChatGPT, Cursor, VS Code and most others: add the
  address as a remote MCP server. The client opens the panel's consent page; sign in if asked,
  check **where the approval is sent** (the client's name is chosen by the client), pick the
  scopes, and approve. The page shows when the client registered itself and warns when nobody has
  approved it before — if you did not just add the address to an AI client yourself, deny.
- **Clients that take a token** (admin panel only) — paste a PAT as a Bearer token, e.g.
  `Authorization: Bearer insula_pat_…`.

On the admin endpoint the agent sees about thirty named tools for everyday work (tenants,
subscriptions, tenant files, deployments, domains, nodes, the audit log, traffic); on the tenant
endpoint, about twenty for the tenant's own files, applications, domains, cron jobs and usage.
Both add three that reach **every** function of that panel's API:

- `find_operations` — search the API ("mailbox create", "backup restore");
- `describe_operation` — what an operation needs;
- `call_operation` — run it.

These are generated from the platform's own API routes, so an agent can always do exactly
what the panel can and nothing else. A few functions are never available to agents:
sign-in and credential flows, managing tokens and connected agents, the node terminal, and binary
file up/downloads.

### Acting as a tenant (admin agents)

Most tenant functions are open to admins directly. Those that only exist in the tenant panel
are reached by **impersonation**: any operation can be run *as* a tenant (`asTenant`), which
signs in as that tenant's admin user exactly like **Impersonate** in the admin panel — with
the agent's scopes still applying, and recorded in the audit log with the admin behind it.

An admin impersonating a tenant in the tenant panel **cannot** approve a tenant agent: that would
give the admin's AI client a tenant credential that outlives the impersonation and is logged as
the tenant. Use the admin endpoint with `asTenant` instead.

### Tenant files

Agents can list, read, write, rename and create files and directories. With **write** they can
move files to the tenant's recycle bin (recoverable); deleting for good needs **delete**.

## Automation with a PAT

```bash
curl -H "Authorization: Bearer $INSULA_TOKEN" \
     https://admin.example.test/api/v1/tenants?limit=20
```

Every route of the admin API accepts a PAT. If the admin panel is protected by OAuth2 Proxy,
API requests carrying a PAT skip the proxy's browser sign-in — the token is checked before
the request is let through, so only a live token gets past. Browser access still goes
through the proxy. (Impersonating a tenant is not available with a token; agents use
`asTenant` instead.) A proxy-protected tenant panel lets its own MCP endpoint and sign-in pages
past the proxy the same way.

## Audit

Every change made with a token is in the audit log as the token's owner, with the token's
name and how it was used (`api` for scripts, `mcp` for agents) — and, when an admin agent acted
as a tenant, the admin it acted for. Approving, disconnecting and switching are audited as well.
