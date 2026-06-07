---
verified: 2026.6.7
---

# Security

The **Security** sidebar group is the security operations hub. It spans
five pages — from cluster hardening posture down to per-user sessions —
plus the **Audit Logs** under Monitoring and the admin-user roles that
gate everything. Several of these pages are `super_admin`-only.

## Roles

Every admin login has a **role** that decides what they can see and do:

| Role | Meaning |
|------|---------|
| **super_admin** | Everything, including the most sensitive pages (Posture, Network Trust, Web Defense, Upgrades, Export/Import, node terminal, granting allowRoot). |
| **admin** | Full platform management (tenants, domains, mail, backups, most settings). |
| **support** | Tenant support — read access plus impersonation. |
| **billing** | Billing and subscription management. |
| **read_only** | View-only access. |

You create and manage admin users from **Security → Identity & Sessions**
(below). New users are created with one of *Admin*, *Support*, *Billing*,
or *Read Only*; `super_admin` is the elevated system role.

## Identity & Sessions

**Security → Identity & Sessions** combines four surfaces:

- **Admin Users** — the user table, showing MFA status and last-IP at a
  glance. **Add** a user (email, full name, password, role), or select and
  **delete** users (single or bulk). Click a user's row to load their
  sessions in the panel below.
- **Active Sessions** — the selected user's refresh-token sessions, with
  per-row **revoke** and **bulk revoke**. This is your "stolen laptop"
  button: revoke a compromised user's sessions immediately.
- **Step-Up Events** — a live feed of the last 50 step-up challenges
  (`step_up.password.*` and `step_up.passkey.*`, success and failed) — use
  it to spot brute-force attempts before they land.
- **Active Node-Terminal Sessions** — every open node-terminal session
  across the cluster, with terminate-from-elsewhere.

!!! note "Passkeys are self-service"
    Each admin enrolls and manages their own **passkeys** from their own
    profile (the user menu → *Settings*). This page shows you *whether* a
    user has MFA and lets you revoke their sessions, but you don't enroll
    passkeys on someone else's behalf from here.

## Posture (super_admin)

**Security → Posture** is read-mostly observability for cluster hardening,
across nine tabs:

1. **Overview** — banner summary + per-node table.
2. **SSH Lockdown** — per-node SSH posture with a guided runbook.
3. **Mesh Status** — detected mesh provider per node (NetBird / Tailscale /
   WireGuard) and install hints.
4. **Firewall Posture** — mode, peer counts, public ports per node.
5. **Node Hardening** — a CIS-style check matrix.
6. **K8s Posture** — Pod Security Standards and privileged-pod listing.
7. **Authentication** — Dex / oauth2-proxy health and failed-login counts.
8. **Network Policies** — a bulk NetworkPolicy template catalog.
9. **Security Events** — recent security-relevant audit entries.

Destructive remediations are presented as guided runbooks rather than
one-click buttons. The deep operator context lives in the
[Operator guide](../operator/security-hardening.md).

## Network Trust (super_admin)

**Security → Network Trust** manages who the cluster firewall trusts:

- **Trusted Ranges** — CIDR ranges the host firewall trusts.
- **Pending Peers** — pre-authorize a new node before it joins, with the
  bootstrap command to run on it.
- **Trusted Proxies** — upstream-proxy CIDRs for the reverse-proxy layer.
- **Blacklist** — operator-managed firewall blocks.

!!! warning "Pre-enroll new peers here"
    A new node must be pre-enrolled (a Pending Peer) before it can join —
    the firewall reconciler reverts ad-hoc manual additions within
    seconds. Do peer authorization on this page, not by hand on the host.

## Web Defense (super_admin)

**Security → Web Defense** owns the WAF and intrusion-ban surfaces, in
four tabs:

- **WAF Events** — the cluster-wide ModSecurity / CRS event stream, with
  source-IP and date-range filters.
- **Banned IPs** — active CrowdSec ban decisions plus a static blocklist.
- **WAF Exclusions** — per-route CRS rule exclusions and IP allowlists.
- **WAF Settings** — CrowdSec status and Console enrollment, auto-ban
  calibration, and the **L4 host-firewall enforcement** toggle.

!!! warning "Read the operator-IP-trust check before enforcing L4"
    The L4 enforcement toggle has cluster-wide blast radius — flipping it
    to `enforce` can lock you out if your own IP isn't trusted. The page
    surfaces the check; heed it. Full detail in the
    [Operator web-defense guide](../operator/web-defense.md).

## OIDC / SSO

**Security → OIDC / SSO** configures external identity providers and how
strictly authentication is enforced:

- **Providers** — add, edit, test, enable/disable OIDC providers, each
  scoped to the **admin** panel or the **tenant** panel.
- **Authentication settings** — per panel: *disable local (password)
  auth* (forces SSO — only allowed once a scoped provider is enabled), and
  *protect via OAuth2 Proxy* (block unauthenticated access entirely).
- **Break-glass** — a recovery URL so you can still get in if SSO breaks;
  you can regenerate it (and the cookie secret) on demand.

!!! tip "Enable a provider before locking the door"
    The "disable local auth" toggles only unlock after a matching
    (admin- or tenant-scoped) provider is enabled — the panel won't let
    you lock yourself out without an SSO path in place. Keep the
    break-glass URL somewhere safe regardless.

## Audit Logs

**Monitoring → Audit Logs** (super_admin) is the searchable record of who
did what. Filter by action type, resource type, HTTP method, free-text
path search, date range, tenant, or actor, with cursor pagination and
color-coded badges. The [Dashboard](index.md) 5xx card and Posture's
Security Events tab both deep-link here.
