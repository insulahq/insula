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
  source-IP and date-range filters. The block button on a row adds the source
  to the **static blocklist** — a permanent entry, not a timed ban (see below).
- **Banned IPs** — active CrowdSec ban decisions plus a static blocklist. Each
  row is tagged with where it came from: **auto-ban** (added by the auto-ban
  scheduler), **manual** (an operator clicked Add ban), **static** (the
  permanent list); untagged rows come from the community blocklist or a
  CrowdSec scenario. Filters narrow the table to any one of the three. The tag
  matters when you are deciding whether to lift a ban — an auto-ban will be
  re-applied if the source keeps tripping the same rules, a manual one will not.
- **WAF Exclusions** — per-route CRS rule exclusions and IP allowlists.
- **WAF Settings** — CrowdSec status and Console enrollment, auto-ban
  calibration, and the **L4 host-firewall enforcement** toggle.

### Two ways to block an address

They are not interchangeable, and the panel keeps them apart:

| | Where it lives | Expires? | Use it when |
|---|---|---|---|
| **Ban (CrowdSec decision)** | *Banned IPs* → Add ban | **Yes** — you choose a duration | Reacting to a burst you expect to pass |
| **Static blocklist** | *Banned IPs* → Static Blocklist, and the block button on any **WAF Events** row | **No** — until you remove it | You have judged the source itself unwelcome |

Blocking from a WAF event uses the **static** list on purpose. A block made
from evidence of an attack is a decision about that source, and a timed ban
would lapse quietly while you believed the address was still handled. The
dialog says *Permanent — until removed* and offers no duration, so the two are
hard to confuse.

To undo either one, remove the entry from its table in **Banned IPs**.

!!! note "Adding an exclusion always works, by design"
    A rule exclusion necessarily contains the pattern it excludes, so the
    request that saves one looks like an attack to the very rule being
    excluded. The WAF-management endpoint is therefore routed around the WAF —
    otherwise a false positive could never be disarmed, and the platform would
    tell you to whitelist a rule while refusing the request that does it.
    Access is still `super_admin` and Bearer-token only.

!!! tip "Tenant file operations and OS-filename rules"
    CRS rules 930100–930130 match request arguments against a list of
    interesting OS filenames. The File Manager's arguments *are* file paths, so
    a tenant renaming their own `.htaccess` or `web.config` used to score high
    enough to be blocked. Exclusion `9000111` scopes those four rules away from
    `/api/v1/tenants/*/files/*`; traversal is still refused by the file-manager
    sidecar, which resolves the real path and cannot be influenced by the
    tenant. If you see WAF Events on file paths, check that exclusion is loaded
    before adding another.

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

Wherever the panel attributes an action to someone — the audit log's
**Actor** column, the **Added by** column on WAF allowlists and rule
exclusions, step-up authentication events, and secret-coverage entries —
it shows the person's **name and email address**, not their internal user
ID. Automated and unauthenticated actions are labelled *System* and
*Anonymous* respectively. If an account has since been deleted, the
original ID is shown shortened, with the full value on hover, so the
historical record stays intact rather than silently becoming blank.
