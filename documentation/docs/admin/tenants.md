---
verified: 2026.6.7
---

# Tenants

A **tenant** is one customer account. Everything a customer owns —
websites, databases, mailboxes, files, backups — hangs off the tenant,
and each tenant runs isolated from every other in its own Kubernetes
namespace. As the admin you create tenants, assign them a plan, and drive
them through their lifecycle (suspend, archive, delete, and back).

The mental model: a tenant has a **lifecycle status** (active, suspended,
archived) and a **provisioning status** (whether its cluster resources
actually exist). The two are independent — a tenant can be `active` in the
business sense but `unprovisioned` if its namespace hasn't been built yet.

## The Tenants area

Open **Tenants** in the sidebar. It's a tabbed page; the first tab is the
list of accounts, and the other tabs are cross-tenant views:

| Tab | What it shows |
|-----|---------------|
| **Tenants** | Every account, searchable, with live CPU / memory / storage usage, assigned worker node, and storage tier (local / HA). Usage figures are collected when the list loads and re-used for 15 seconds, so what you see reflects the cluster now rather than the last background sweep. Each row has a small **Login** button beside the name — the same [Login as Tenant](#header-actions) action as the detail page, without opening it first. |
| **Domains** | All domains across all tenants — filter by tenant, bulk-verify, bulk-delete. → [Domains & DNS](domains-and-dns.md) |
| **Workloads** | Every deployment across all tenants, with a `custom` tag for bring-your-own-container deployments. → [Catalogs & applications](catalogs-and-applications.md) |
| **Users** | Sub-users across all tenants. |
| **Email Accounts** | Mailboxes across all tenants. → [Email](email.md) |
| **Cron Jobs** | Scheduled jobs across all tenants. |

The **SYSTEM** tenant always appears in the list with an amber `SYSTEM`
badge. It owns the platform's apex domain and reserved mailboxes
(`noreply@`, `postmaster@`, …). You can host websites and mailboxes under
it through the normal flows, but it can never be selected for bulk
actions and can never be suspended, archived, or deleted.

## Creating a tenant

1. On the **Tenants** tab, click **Add Tenant**.
2. Fill in the account fields: company **Name**, **Contact name**,
   **Primary email**, and optionally a secondary email and phone. A
   collapsible **billing address** section is there if you need it.
3. Choose a **Plan** (defines the resource limits and price — see
   [Plans & subscriptions](plans-and-subscriptions.md)).
4. Optionally pin the tenant to a specific worker **node** — the dropdown
   shows live free CPU / RAM / disk per node so you can place a heavy
   tenant on a roomy node.
5. Choose a **storage tier**: `local` (single-node volume) or `ha`
   (replicated across nodes — only useful once you've enabled HA mode).
6. Click create.

The platform generates a **tenant-portal password** and shows it once, in
an amber box, with a copy button. **Save it now — it is never shown
again.** After you acknowledge it, the **provisioning progress modal**
opens and walks the namespace, quota, and resource creation step by step.

??? info "Under the hood"
    Creation writes the tenant row first, then triggers provisioning,
    which builds the Kubernetes namespace, `ResourceQuota`,
    `NetworkPolicy`, and the per-tenant storage volume. The region is
    auto-filled from the platform apex — you don't pick one (there is no
    multi-region selection).

## The tenant detail page

Clicking any tenant opens its detail page. The header carries the action
buttons (below). Underneath are several cards and a tabbed resource view.

**Cards (top to bottom):**

- **Account Information** — the editable lifecycle **Status** control,
  the **K8s Status** (provisioning) badge, created date, and namespace.
- **IDs** — client ID, plan ID, region ID (for support / debugging).
- **Subscription** — assigned plan, status, and expiry date. Click
  **Edit** to change the plan or set an expiry.
- **Resource Limits** — the effective CPU / memory / storage / sub-user /
  mailbox limits and monthly price, each of which you can **override**
  per tenant (see below).
- **Storage Lifecycle** — current storage state and grow/shrink controls.
- **Placement** — which node the tenant is pinned to.

A **namespace health banner** appears above Storage Lifecycle only when
something is wrong — see [When a tenant is over quota](#when-a-tenant-is-over-quota).

**Resource tabs:** Domains, Applications, Deployments, Files, Email,
Backups, Users. Each shows that tenant's resources with a count. The
**Files** tab is intentionally a pointer — the file browser lives in the
tenant panel; use **Login as Tenant** to reach it.

### Header actions

**Login as Tenant** sits on its own in the title bar; everything else is
under the **Actions** menu beside it.

| Action | What it does |
|--------|--------------|
| **Login as Tenant** | Opens the tenant panel in a new tab, signed in as that customer (impersonation). Also available as a **Login** button on each row of the Tenants list. Requires the Tenant Panel URL to be set in [Platform → Identity](platform-settings.md), and an active `tenant_admin` user on the tenant to sign in as — if either is missing the panel tells you which. |
| **Provision / Re-provision** | Builds (or rebuilds) the tenant's cluster resources. Appears as *Provision* when unprovisioned/failed, *Re-provision* when already provisioned (to repair drifted state). |
| **Refresh All Apps** | Pulls the latest images and restarts every running deployment for the tenant. |
| **Edit** | Edits the contact fields (name, emails). |
| **Notify tenant** | A checkbox above the lifecycle actions — when ticked (default), the customer gets an in-app + email notification about the lifecycle action you're about to take. |
| **Suspend / Reactivate / Archive / Restore** | The lifecycle transitions, described below. Which one appears depends on the tenant's current status. |
| **Delete** | Hard delete, shown last and in red. Irreversible. |

The SYSTEM tenant shows only the non-destructive entries — it cannot be
suspended, archived or deleted.

!!! tip "Typing a name to confirm"
    Destructive dialogs ask you to re-type an exact name (a tenant, a node,
    a volume). Click the highlighted name to copy it instead of
    transcribing it.

## The lifecycle: suspend, resume, archive, restore, delete

A tenant moves between **active**, **suspended**, and **archived**. Each
transition runs a chain of **lifecycle hooks** (DNS, mail, storage, …) in
order. The lifecycle action buttons in the header change depending on the
current status:

| From status | Button | Effect |
|-------------|--------|--------|
| active | **Suspend** | Scales workloads to 0, swaps the website to a "suspended" page, disables cron, and shuts mail down completely: incoming mail (mailboxes, aliases, and mailing lists) is refused with a bounce, and mail accounts cannot sign in or send until re-activation. Fully reversible — mail settings are preserved. |
| suspended | **Reactivate** | Restores workloads to their pre-suspend replica counts, unpatches ingress, re-enables cron and the full mail configuration (mailboxes, aliases, forwarding, auto-reply). |
| active / suspended | **Archive** | Takes a final snapshot, then deletes the volume, workloads, and mailboxes. The tenant row and snapshot are kept for the configured retention window — restorable. |
| archived | **Restore** | Recreates the volume and restores data from the pre-archive snapshot. (Workloads are redeployed afterwards.) |
| any (except SYSTEM) | **Delete** | Hard delete — removes the tenant row, the namespace, and triggers every orphan-cleanup hook (DNS zones, backup bundles, volumes, cluster-scoped refs). Irreversible. |

You can drive the same transitions from the **Status** dropdown in the
Account Information card — it's the keyboard-friendly equivalent of the
buttons.

!!! warning "Archive vs Delete"
    **Archive** is the safe choice when a customer leaves but might come
    back — their data survives as a snapshot. **Delete** is permanent and
    triggers full cleanup. The Delete button opens a type-to-confirm
    dialog.

### Watching a transition: the progress modal

Every lifecycle action opens the **Transition Progress** modal. It shows
the transition (e.g. `archived`) with a live status badge — *Running*,
*Completed*, *Completed with retries*, or *Failed* — and lists each
**hook** as it runs (pending → running → ok / noop / failed). A failed
hook gets a **Retry** button.

The work is decoupled from the modal: closing it never cancels the
operation, and the Task Center chip keeps it visible. If a hook fails and
won't recover, jump to [Platform → Tenant Lifecycle Hooks](platform-settings.md)
where you can inspect per-hook success rates and reset a stuck hook's
circuit breaker.

## Bulk actions

On the **Tenants** tab, tick the checkbox on one or more rows to reveal
the bulk action bar at the bottom: **Suspend**, **Reactivate**, and
**Delete**. Each opens a confirmation dialog with the count. Bulk
operations open a **Bulk Progress** modal that tracks every tenant
individually, so a partial failure tells you exactly which ones need
attention.

The SYSTEM tenant's checkbox is always disabled — it can't be included in
any bulk action.

## Per-tenant overrides

A tenant inherits CPU, memory, storage, sub-user count, mailbox count,
and monthly price from its **plan**. When one customer needs something
different, open the **Resource Limits** card and click edit. Each field
has a "custom" toggle: leave it off to follow the plan, or turn it on to
set a tenant-specific value.

- **Growing storage** happens online — the platform resizes the volume
  and surfaces a progress modal.
- **Shrinking storage** is destructive (snapshot → drop volume → recreate
  smaller → restore). The platform refuses it on a normal save and prompts
  you with a confirmation explaining the steps before it runs.

See [Plans & subscriptions](plans-and-subscriptions.md) for what each
plan field means.

## When a tenant has more than their plan allows

Changing a tenant's plan does **not** resize anything they already have.
Move a customer from a 2 GiB plan down to a 512 MiB one and the 2 GiB
volume stays exactly as it is — the subscription says one thing, the
cluster holds another, and nothing announces the difference.

That gap is easy to miss, because the tenant's own storage figure is
**bytes written**, not volume size. A 2 GiB volume holding 79 MB of files
reads as comfortably inside a 512 MiB plan from the tenant panel, and the
admin panel used to show only the plan values. The first real symptom is
usually a new volume or application being refused, which surfaces as a
deployment stuck pending.

The tenant detail page now compares all three numbers. When they
disagree, a banner appears above **Storage Lifecycle**:

| Resource | Subscription | Enforced quota | Provisioned |
|----------|--------------|----------------|-------------|
| Storage  | 512Mi        | 512Mi          | **2Gi** — over plan |
| CPU      | 0.1          | 100m           | — |
| Memory   | 102.4Mi      | 102.4Mi        | — |

- **Subscription** — the effective limit: the tenant's per-resource
  override if you have set one, otherwise their plan's value.
- **Enforced quota** — what Kubernetes is enforcing right now. It can
  briefly lag the subscription after a plan change.
- **Provisioned** — the size the volume *requests*. This is the column
  that was missing, and the reason an oversized volume stayed invisible.
  CPU and memory have no standing equivalent, so they show `—`.

Every resource is listed, not just the offending one, so you can compare
the three columns at a glance.

!!! note "Two ways this shows up"
    If the quota was lowered along with the plan, Kubernetes is already
    refusing new resources and the banner says so. If the quota was never
    re-applied, nothing is being refused yet — but the tenant is still
    holding more than they are entitled to, and the banner still flags it.

**Run reconciler** is deliberately not offered here. The reconciler
recreates *missing* objects; this object exists and is simply the wrong
size. Resolve it one of two ways, both under **Resource Limits**:

- **Raise the limit** — turn on the override for that resource and set it
  to at least what is provisioned. Immediate, and the right choice if the
  customer should keep the space.
- **Shrink the volume** — reduce the storage override to the intended
  size. This is a destructive resize (snapshot → drop → recreate →
  restore) and the platform will confirm before running it.

The banner clears on its own once the numbers agree; it re-checks every
minute.
