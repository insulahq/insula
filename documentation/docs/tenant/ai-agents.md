# AI agents

You can connect an AI client — Claude, Cursor, VS Code and other clients that speak the
[Model Context Protocol (MCP)](https://modelcontextprotocol.io) — to your hosting panel. The agent
then works with your files, applications, domains and the rest of the panel **as you**: with your
role, inside your account only, and never with more than you could do yourself.

!!! note "If you do not see this"
    AI agents are available once your provider switches them on. Until then **User Settings → AI
    agents** says they are switched off, and agents cannot connect.

## Connect an agent

1. Open **User Settings → AI agents** and copy the **MCP address**
   (`https://tenant.<your provider's domain>/api/v1/mcp`).
2. Add it to your AI client as a remote (HTTP) MCP server. In Claude Code, for example:

    ```bash
    claude mcp add --transport http hosting https://tenant.example.test/api/v1/mcp
    ```

3. The client opens a page of this panel in your browser. Sign in if asked, then check:
    - **where access is sent** — the client's name is chosen by the client itself, so judge by the
      address shown. If you did not just add the address to an AI client yourself, **deny**.
    - **what it may do** — untick anything you do not want:

    | Scope | Allows |
    |---|---|
    | **read** | Looking at everything you can see in the panel |
    | **write** | Changes: creating, updating, uploading, moving files to the recycle bin |
    | **delete** | Anything that cannot be undone: deleting for good, emptying the recycle bin, restoring over existing data |

4. **Approve.** The agent is connected.

## How long it lasts

The agent's access lasts one hour at a time and renews by itself for **up to 8 hours** after you
approved it. After that the client asks you again. You can disconnect it earlier at any time.

## See and disconnect agents

While an agent is connected, a **robot chip** shows in the panel's header. Click it, or open
**User Settings → AI agents**, to see your connected agents — when each was connected, when it was
last active, what it may do and when it ends — and **Disconnect** any of them. A disconnected agent
loses access straight away.

If you are the account's **administrator** (tenant admin), the list shows every agent connected to
the account, by any of its users, and you can disconnect any of them.

## What an agent can and cannot do

- It acts as **you**: a user with read-only access gets a read-only agent, whatever scopes it was
  given.
- It works **in your account only**. It cannot see other accounts or the provider's platform.
- Everything it changes is in the **audit log**, marked as done through an agent.
- It cannot create or reset anything that would keep working after you disconnect it: panel users,
  passwords, SSH keys, SFTP and database logins, mailbox passwords, client certificates, webmail
  sign-ins or backup download links. Do those in the panel yourself.
- It cannot sign in, change your password, or create or approve other agents.

!!! tip "Provider staff"
    When your provider's staff open your account to help you, they cannot connect an agent in your
    name — only the account's own users can.
