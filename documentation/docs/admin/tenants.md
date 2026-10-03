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
| **Tenants** | Every account, searchable, with live CPU / memory / storage usage, **Placement**, storage tier (local / HA) and subscription **Expires**. Usage figures are collected when the list loads and re-used for 15 seconds, so what you see reflects the cluster now rather than the last background sweep. Each row has a small **Login** button beside the name — the same [Login as Tenant](#header-actions) action as the detail page, without opening it first. |
| **Domains** | All domains across all tenants — filter by tenant, then bulk-verify, bulk-refresh route DNS or bulk-delete. → [Domains & DNS](domains-and-dns.md) |
| **Workloads** | Every deployment across all tenants, with a `custom` tag for bring-your-own-container deployments. → [Catalogs & applications](catalogs-and-applications.md) |
| **Users** | Sub-users across all tenants. |
| **Email Accounts** | Mailboxes across all tenants. → [Email](email.md) |
| **Cron Jobs** | Scheduled jobs across all tenants. Select rows for the bulk enable / disable / delete bar, or use a row's **pencil** to edit one — it saves against that job's own tenant, so it works with no tenant filter set. Type cannot be changed once saved. → [Scheduled tasks](../tenant/cron-jobs.md) |
| **SFTP Users** | Every SFTP account across all tenants, searchable by username, home path, description or tenant name. Each row opens the tenant that owns it. Read-only here — accounts are created and rotated on the tenant's own page, where the home path and their storage are both in view. |

### The "N issues" chip

A tenant with an open problem shows an amber **⚠ N issues** chip in the
**Status** column, beside the lifecycle badge. It is a live reading, not a
stored flag: it counts conditions that are true *right now*, and it disappears
on its own when they stop being true. Nobody has to remember to clear it.

The conditions counted are the same thresholds the notification system fires
from, so a chip and the message an operator received cannot disagree:

| Condition | Counted when |
|-----------|--------------|
| **Mailbox over quota** | a mailbox is at or past 80% — one issue per mailbox, at its highest open threshold |
| **Subscription expiring** | expiry is within 35 days (critical inside 7) |
| **Bandwidth capped** | the monthly cap has been reached and traffic is being refused |
| **Not on its primary node** | the tenant's workloads, its attached volume or its data are on a node other than its primary one — see [Placement](#reading-the-placement-and-expires-columns) |

Click the tenant to see the detail, which names the specific object.

### Reading the Placement and Expires columns

**Placement** is the tenant's **primary node** — the node its workloads are
pinned to and its data lives on. `auto` means no pin is set and Kubernetes
schedules the tenant wherever there is room — that is a normal state, not a
missing value. A node name appears once the tenant is pinned (new local-tier
tenants are pinned automatically at creation).

When a tenant is **not on its primary node**, the column shows where it
**actually** is, in **red**, with `primary <node>` underneath — hover it for
what is elsewhere (running on, volume attached on, data on). This happens after
a storage failover, a node outage, or a pod scheduled onto another node. The
platform checks every minute; the same fact adds a **Not on its primary node**
entry to the tenant's issues chip. To resolve it, open the tenant's
[Placement card](#the-tenant-detail-page).

**Expires** is the subscription expiry date, colour-coded so a lapsing account
is visible without reading dates:

| Shown | Meaning |
|-------|---------|
| Grey date | Expires more than 30 days out |
| Amber date | Expires within 30 days |
| Red date | Already past — the subscription has lapsed |
| `never` | No expiry was ever set. Common and intentional for perpetual accounts. |

Sorting applies to the page you are looking at, not the whole tenant list, so
sort after narrowing with the search box if you have many accounts.

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

The login this creates is named after the **Contact name**, not the
company — it belongs to a person, and that name is what appears in the
tenant's own team list and in the audit log. If you leave Contact name
empty (only possible for scripted callers; the form requires it), the
company Name is used instead.

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

- **Open issues** — an amber banner, shown only when the tenant has at least
  one open condition. Each line names the object it concerns (the mailbox
  address, the tenant), the value that tripped it, and how long it has been
  true, with a link to the page where it gets fixed. It sits above the other
  cards so the answer to "what is wrong with this tenant" is the first thing
  on the page, and it clears itself when the condition does.
- **Account Information** — the editable lifecycle **Status** control,
  the **K8s Status** (provisioning) badge, created date, and namespace.
- **IDs** — client ID, plan ID, region ID (for support / debugging).
- **Subscription** — assigned plan, status, and expiry date. Click
  **Edit** to change the plan or set an expiry.
- **Resource Limits** — the effective CPU / memory / storage / sub-user /
  mailbox limits and monthly price, each of which you can **override**
  per tenant (see below). For CPU this is the tenant's **share** and its
  **burst ceiling**; both default to *inherit from plan*.
- **Apply new limits** — appears under Resource Limits for a tenant on the
  share model. Saving a share or ceiling writes it; this delivers it to the
  tenant's namespace (see below).
- **Storage Lifecycle** — current storage state and grow/shrink controls.
- **Placement** — the tenant's primary node and storage tier, and where it
  actually runs and keeps its data right now (checked every minute). When
  those differ, a red **Not on its primary node** banner says what is
  elsewhere and since when, with two ways out:
    - **Move back to &lt;primary&gt;** moves the tenant to its primary node.
      A **running** tenant is stopped first: its workloads scale to 0, the
      platform waits until its volume has detached from the node it ran on,
      re-pins it and starts it on the primary node — usually about a minute of
      downtime. This runs as a storage operation: its progress opens right
      away (and stays in the Task Tracker), other storage operations wait for
      it, and a failure starts the tenant again — on the old node if it had not
      been re-pinned yet. Longhorn then copies the data back in the
      background; the copy takes as long as the volume is large. (Re-pinning a
      running tenant without stopping it let Longhorn detach the volume under
      its still-running pods.) The move is refused — *the tenant's volume is in
      use* — while a backup or restore Job uses the volume or a platform task
      holds the file manager; try again once it has finished. A tenant with
      nothing running (no app, file manager idle) has no workload to carry its
      data, so the platform attaches its volume on the primary node itself
      until the copy is done; the result line says **Moving the data there
      now**, and the banner clears once it has.
    - **Make &lt;current node&gt; the primary node** accepts where it is: the
      workloads restart once on the same node to pick up the new pin, and no
      data is copied.
  Both ask for a second click that says what they will do. Below the banner,
  **Storage failovers** lists the tenant's recent Longhorn salvages — when a
  volume lost every replica and was remounted — with where the tenant ran
  before and after.

A **namespace health banner** appears above Storage Lifecycle only when
something is wrong — see [When a tenant is over quota](#when-a-tenant-is-over-quota).

**Resource tabs:** Domains, Deployments, Files, Email, Backups, Snapshots,
Users, SFTP Users. Each shows that tenant's resources with a count. The
**Files** tab is intentionally a pointer — the file browser lives in the
tenant panel; use **Login as Tenant** to reach it.

There is no longer an **Applications** tab: it listed the deployments of
type `application`, which is a filtered view of the **Deployments** tab
beside it, under a second name for the same objects.

The **Backups** tab lists that tenant's off-site backup bundles — when each
ran, whether it completed, how large it is, who started it, and when it
expires — with a **Restore…** link into the full
[Backups → Tenants](../operator/tenant-backups.md) page. The count on the tab
is the tenant's total bundle count.

The **Users** tab manages the tenant's team on their behalf — the same
add / edit / enable / reset / delete actions the tenant sees, attributed
to your staff account in the audit log. Passwords work the same way here
as they do for the tenant: **Add User** takes an email, name, and role but
no password, and **reset password** regenerates rather than letting you
choose one. Either way the new password is shown once, with a copy button.
You cannot set a password of your choosing on a tenant's account.

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
| any (except SYSTEM) | **Delete** | Hard delete — removes the tenant row, the namespace, and triggers every orphan-cleanup hook (DNS zones, mail, volumes, snapshots, cluster-scoped refs). Irreversible. Off-site backup bundles are **kept** for the deleted-tenant retention window (**Platform → Limits**, default 30 days) so the tenant can still be recovered — see [Recovering a deleted tenant](backups-and-restore.md#recovering-a-deleted-tenant) — then removed automatically. |

You can drive the same transitions from the **Status** dropdown in the
Account Information card — it's the keyboard-friendly equivalent of the
buttons.

!!! warning "Archive vs Delete"
    **Archive** is the safe choice when a customer leaves but might come
    back — their data survives as a snapshot. **Delete** is permanent and
    triggers full cleanup. The Delete button opens a type-to-confirm
    dialog. Once the delete succeeds you are taken back to the tenants list,
    which confirms it; **Review the deletion steps** there opens
    **Platform → Lifecycle hooks**, where the per-step record outlives the
    tenant. A delete that fails keeps you on the tenant and says why.

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
**Delete**. The **Domains** and **Cron Jobs** tabs have their own bulk bars
(verify / refresh route DNS / delete, and enable / disable / delete).

Every bulk action asks for confirmation with the count, then opens a progress
dialog that processes the selection **one item at a time**:

- Each row shows its status — *Queued*, *Running*, *Succeeded*, *Skipped* or
  *Failed* — and a line saying what happened or why it failed. For tenants this
  includes the lifecycle hooks: a tenant whose hooks did not all complete is
  shown as *Failed*, with each failing hook listed (failed hooks keep being
  retried in the background).
- A progress bar and running counts sit at the top.
- **Cancel** stops before the next item; the one already running finishes.
  Items that never ran are shown as *Not run*.
- **Close** becomes available once the run has finished or been cancelled.
- The dialog ends with a summary — *N succeeded, M skipped, K failed*. If
  anything failed, a `BULK_PARTIAL_FAILURE` panel explains what to do, and
  **Retry failed** runs only the failed items again.

After you close the dialog, only the items that failed (or were not run)
stay selected, so running the action again touches just those.

The SYSTEM tenant's checkbox is always disabled — it can't be included in
any bulk action.

## Per-tenant overrides

### Applying a changed CPU share or ceiling

Saving a tenant's **CPU tier** or **Burst ceiling** records it; it does not
reach the cluster. The panel under *Resource Limits* says which state the
tenant is in and what pressing the button will do:

| It says | Meaning |
|---|---|
| **CPU settings are applied** | Saved and running settings agree. Pressing it again is safe and changes nothing. |
| **CPU settings not yet applied** | The two disagree. Both are shown — what is saved, and what the namespace is really enforcing. |

The panel also tells you the cost before you commit to it. Applying a
changed **share** replaces nothing. Applying a changed **ceiling** replaces
the tenant's applications, one at a time with a health check between —
a ceiling is stamped onto a container when it starts, so a running
application cannot pick one up any other way.

If the tenant needs review — most often because their measured peak already
exceeds the new ceiling — the button stays disabled until you tick the
acknowledgement beside it. That is the same gate that guards a first
migration, for the same reason.

!!! note "Tenants are shown what is enforced, never what is saved"
    While the two disagree, the tenant's own panel keeps reporting the
    ceiling their namespace actually applies. They are never told they may
    burst further than they can.

The same control appears per tenant under
[Cluster → CPU Scheduling](../operator/cpu-and-capacity.md#changing-a-tenants-share-or-ceiling-afterwards),
which is the better place to work through several tenants at once.


A tenant inherits CPU, memory, storage, sub-user count, mailbox count,
and monthly price from its **plan**. When one customer needs something
different, open the **Resource Limits** card and click edit. Each field
has a "custom" toggle: leave it off to follow the plan, or turn it on to
set a tenant-specific value.

**Turning email off for one tenant.** Set **Max Mailboxes** to `0`. The tenant
keeps the mailboxes they already have, but no new one can be created and email
cannot be enabled on a further domain — their panel says so plainly instead of
offering a button that fails. This is narrower than suspending the tenant,
which also stops their websites and databases. **Max Sub-Users** accepts `0` the
same way.

    A custom field left **empty** is treated as "no override" and falls back to
    the plan, rather than as zero. If you mean zero, type `0` — the form tells
    you what it will do.

- **Growing storage** happens online — the platform resizes the volume
  and surfaces a progress modal.
- **Shrinking storage** is destructive (snapshot → drop volume → recreate
  smaller → restore). The platform refuses it on a normal save and prompts
  you with a confirmation explaining the steps before it runs.

    When it finishes successfully, the progress dialog offers to delete the
    volume it replaced, with its size. The old volume is **kept** by
    default and goes on reserving its full original size until something
    removes it, so accepting is usually what you want. Declining is safe —
    it stays listed under
    [Cluster → Storage → Orphaned volumes](nodes-and-storage.md), where you
    can delete it later. The offer never appears when the resize failed:
    the old volume is the way back, and deleting it then would remove the
    only copy of the data.

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
