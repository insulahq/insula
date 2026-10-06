# AI agents & API tokens

The platform can be driven by **AI agents** over the [Model Context Protocol
(MCP)](https://modelcontextprotocol.io) and by **scripts** over its REST API. Both act as a
person: you, with your role, and never more.

!!! note "Who can use this"
    Only users with the **admin** role can create API tokens or connect an AI agent.
    super_admins cannot (agents must not reach break-glass functions such as the node
    terminal), and neither can tenant users.

## Two ways to grant access

| | Personal access token (PAT) | OAuth (AI client sign-in) |
|---|---|---|
| Created | **User Settings → API tokens & AI agents → New token** | The AI client connects to the MCP address; you approve it on a consent page |
| Works on | The whole REST API **and** the MCP endpoint | The MCP endpoint only |
| Lifetime | 7 days to 1 year, or never | 8 hours, no refresh — the client asks again |
| Shown | Once, at creation — copy it then | Never; the client holds it |

Both appear in the same list, with when they were last used, and **Revoke** stops them
within about 30 seconds. Disabling a user, or taking the admin role away from them, stops
their tokens the same way — nobody has to revoke them separately.

## Scopes

Every token carries one or more scopes, and every API call is checked against them:

| Scope | Allows |
|---|---|
| **read** | Looking: every `GET` the admin role may make |
| **write** | Changing things: creating, updating, suspending a tenant, moving a tenant's file to the recycle bin |
| **delete** | Anything that cannot be undone: deleting, purging, emptying the trash, restoring or importing over existing data, rolling back, resetting passwords, rotating credentials, archiving a tenant, running raw SQL |

The check happens on the API route itself, so a script and an agent are held to exactly the
same rule. A token never exceeds its user's role: a `delete`-scoped token of an admin still
cannot do what only a super_admin can.

## Connecting an AI client

Copy the **MCP endpoint** shown under *API tokens & AI agents* —
`https://admin.<your domain>/api/v1/mcp` — into your client:

- **Clients that sign in (OAuth)** — Claude, ChatGPT, Cursor, VS Code and most others: add the
  address as a remote MCP server. The client opens the admin panel's consent page; sign in if
  asked, check **where the approval is sent** (the client's name is chosen by the client),
  pick the scopes, and approve.
- **Clients that take a token** — paste a PAT as a Bearer token, e.g.
  `Authorization: Bearer insula_pat_…`.

The agent sees about thirty named tools for everyday work (tenants, subscriptions, tenant
files, deployments, domains, nodes, the audit log, traffic) plus three that reach **every**
function of the platform API:

- `find_operations` — search the API ("mailbox create", "backup restore");
- `describe_operation` — what an operation needs;
- `call_operation` — run it.

These are generated from the platform's own API routes, so an agent can always do exactly
what the admin panel can and nothing else. A few functions are never available to agents:
sign-in and credential flows, managing tokens, the node terminal, and binary file
up/downloads.

### Acting as a tenant

Most tenant functions are open to admins directly. Those that only exist in the tenant panel
are reached by **impersonation**: any operation can be run *as* a tenant (`asTenant`), which
signs in as that tenant's admin user exactly like **Impersonate** in the admin panel — with
the agent's scopes still applying, and recorded in the audit log.

### Tenant files

Agents can list, read, write, rename and create files and directories of any tenant. With
**write** they can move files to the tenant's recycle bin (recoverable); deleting for good
needs **delete**.

## Automation with a PAT

```bash
curl -H "Authorization: Bearer $INSULA_TOKEN" \
     https://admin.example.test/api/v1/tenants?limit=20
```

Every route of the admin API accepts a PAT. If the admin panel is protected by OAuth2 Proxy,
requests that carry a platform token are let through to the API (the token is the
credential); browser access still goes through the proxy.

## Audit

Every change made with a token is in the audit log as the token's owner, with the token's
name and how it was used (`api` for scripts, `mcp` for agents) — and, when an agent acted as
a tenant, the admin it acted for.
