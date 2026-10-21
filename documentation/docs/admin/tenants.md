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
| **Cron Jobs** | Scheduled jobs across all tenants. Select rows for the bulk enable / disable / delete bar, or use a row's **pencil** to edit one — it saves against that job's own tenant, so it works with no tenant filter set. Type cannot be changed once saved. The form also sets who hears about a failed run: **Inform the tenant's admins** (on by default — off means the tenant gets nothing on any channel) and the opt-in **failure email** (to the tenant's primary email and/or one more address); an envelope next to a job's name marks the ones that email. A run the platform cut short — its server restarting — is not reported as a failure. → [Scheduled tasks](../tenant/cron-jobs.md#email-when-a-task-fails) |
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
[Placement](#placement) on its **Storage & backups** section.

**Expires** is the subscription expiry date, colour-coded so a lapsing account
is visible without reading dates:

| Shown | Meaning |
|-------|---------|
| Grey date | Expires more than 30 days out |
| Amber date | Expires within 30 days |
| Red date | Already past — the subscription has lapsed |
| `never` | No expiry was ever set. Common and intentional for perpetual accounts. |

The **search box** matches a tenant's name, its contact email, its plan's name
and its placement as the column shows it: a node by its name, hostname or
alias, the node a tenant that is off its primary node is actually on, `auto`
for every tenant with no node pin, and `misplaced` for every tenant off its
primary node.

Sorting applies to the page you are looking at, not the whole tenant list, so
sort after narrowing with the search box if you have many accounts — or set
**Rows per page** to **All**, which loads every tenant that matches the search
onto one page.

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

Clicking any tenant opens its detail page. The header names the tenant with
its status, its open issues, its plan and where it runs, and carries the
actions (below). Under it are six sections:

| Section | What it holds |
|---|---|
| **Overview** | Usage at a glance — CPU, memory, storage, bandwidth and mail sent today, each linking to where it is acted on. **Needs attention** lists every open condition with the place it gets fixed: the tenant's issues, a tenant away from its pinned node, a backup that did not complete, CPU settings waiting for Re-apply, send limits the mail server does not hold. Below: a **Domains** table and an **Applications** table, each linking into the tenant panel, then recent activity and short summaries of placement, account, plan, backups, email and users. |
| **Email** | Outbound sending and its limits (with whether the mail server holds them), sent and held-back mail, a two-week chart, DMARC / TLS-report / abuse summaries, mail domains with their DNS records, mailboxes with aliases and forwarding, mailing lists, and IMAP migrations. |
| **Traffic** | The same view as [Monitoring → Traffic](../operator/monitoring.md#traffic), narrowed to this tenant: its own in/out traffic, or broken down by ingress route or by pod. Above it, the bandwidth used this cycle against the allowance. |
| **Storage & backups** | Placement, the tenant's volumes and any storage operation in flight, retained or orphaned volumes, the platform's backup bundles, and the volume snapshots. |
| **Plan & limits** | The subscription, every limit against what is used, plan comparison. See [Per-tenant overrides](#per-tenant-overrides). |
| **Activity** | Everything recorded against this tenant, newest first, named in words with the request underneath. |

### Managed in the tenant panel

What a tenant manages for itself — domains, applications, cron jobs,
databases, files, mailboxes, aliases, forwarding, mailing lists, migrations,
snapshots, users, SFTP users and SSH keys — is **shown** on this page and
**changed** in the tenant panel. Links marked with an arrow (↗) open the
tenant panel in a new tab, signed in as the tenant, on that page: a mailbox's
**Manage** opens its editor, a migration's **Edit** opens its edit form. A
**Delete** link lands on the item, outlined; the delete itself is pressed
there — nothing is deleted by opening a link.

What only an operator decides stays on this page: the lifecycle actions,
plan and limits, suspending outbound mail, placement, storage operations
and backups, and whether a custom container may run as root (**Root ON /
OFF** beside the application on the Overview).

### Placement

**Storage & backups → Placement** shows one card per node. **ACTIVE** (a
solid green card with a dot) is where the tenant's pods run and its volume
is attached now; **PINNED** (a dashed blue outline with a pin) is its primary
node — where it should run and keep its data; **DATA** (a solid blue pill)
marks a node holding a replica. The volume table below uses the same two badges for *Attached to*
and *Replica nodes*. When active and pinned differ, a **Not on its primary
node** banner says what is elsewhere and since when, with two ways out:

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

  A move to a node that **cannot hold the tenant's volume** is refused
  before anything is stopped, with the numbers: how large the volume is
  and how much Longhorn can still schedule on that node. Longhorn reserves
  a volume's *full* size, not what is in use — a 100 GiB volume holding
  28 GiB needs 100 GiB of schedulable room — so a node with plenty of free
  disk can still be too small. Pick a node with more room, or shrink the
  volume first (**Plan & limits**). Without this check the tenant
  would start on the new node with its data left behind, and do all of
  its disk I/O across the network from then on.
- When Longhorn cannot copy the data to where the tenant runs, the banner
  says so in Longhorn's words — *data on node-a; Longhorn cannot copy it to
  node-b: insufficient storage* — and so does the notification. That does
  not resolve by waiting: move the tenant to a node with room, or shrink
  its volume.
- **Make &lt;current node&gt; the primary node** accepts where it is: the
  workloads restart once on the same node to pick up the new pin, and no
  data is copied.

Both ask for a second click that says what they will do. Below the banner,
**Storage failovers** lists the tenant's recent Longhorn salvages — when a
volume lost every replica and was remounted — with where the tenant ran
before and after.


Under the cards, **Pinned node** and **Storage tier** change the intent:
**Save pin** records where the tenant should run (its pods move at their
next restart); **Save and move pods now** also restarts them so they move.

A **namespace health banner** appears on the Overview and on Plan & limits
only when something is wrong — see [When a tenant is over quota](#when-a-tenant-is-over-quota).

The **Backups** list on Storage & backups shows that tenant's off-site backup
bundles — when each ran, whether it completed, how large it is, who started
it, and when it expires — with a **Restore…** link into the full
[Backups → Tenants](../operator/tenant-backups.md) page.

### Header actions

**Login as tenant** and **Edit** sit in the title bar; everything else is
under the **Actions** menu between them.

| Action | What it does |
|--------|--------------|
| **Login as Tenant** | Opens the tenant panel in a new tab, signed in as that customer (impersonation). Also available as a **Login** button on each row of the Tenants list. Requires the Tenant Panel URL to be set in [Platform → Identity](platform-settings.md), and an active `tenant_admin` user on the tenant to sign in as — if either is missing the panel tells you which. |
| **Provision / Re-provision** | Builds (or rebuilds) the tenant's cluster resources. Appears as *Provision* when unprovisioned/failed, *Re-provision* when already provisioned (to repair drifted state). |
| **Refresh all apps** | Pulls the latest images and restarts every running deployment for the tenant. |
| **Edit** | Edits the contact fields (name, emails). A button of its own, beside the menu. |
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
| active | **Suspend** | Scales workloads to 0, swaps the website to a "suspended" page, disables cron, and shuts mail down completely: incoming mail (mailboxes, aliases, and mailing lists) is refused with a bounce, and mail accounts cannot sign in or send until re-activation. Backups pause too: no new bundles, and the existing ones are kept until re-activation ([details](backups-and-restore.md#tenant-backups)). Fully reversible — mail settings are preserved. |
| suspended | **Reactivate** | Restores workloads to their pre-suspend replica counts, unpatches ingress, re-enables cron and the full mail configuration (mailboxes, aliases, forwarding, auto-reply). |
| suspended | **Archive** | Takes a final backup bundle of everything — files and databases, mailboxes with their mail, configuration — and stores it off-site on the tenant backup target. Then the tenant is taken down almost as if deleted: nobody can sign in, and its applications, volume, mailboxes, DNS zones, mail domains and DKIM keys are removed. The tenant row and the bundle are kept — restorable. An active tenant has to be suspended first. |
| archived | **Restore archived tenant** | Brings everything back from the bundle: files and databases, DNS zones, mail domains (with a new DKIM key), mailboxes with their mail, and every application at the replica count it had before the suspension. Mailboxes need new passwords; the restore notice tells the tenant. |
| any (except SYSTEM) | **Delete** | Hard delete — removes the tenant row, the namespace, and triggers every orphan-cleanup hook (DNS zones, mail, volumes, snapshots, cluster-scoped refs). Irreversible. Off-site backup bundles are **kept** for the deleted-tenant retention window (**Platform → Limits**, default 30 days) so the tenant can still be recovered — see [Recovering a deleted tenant](backups-and-restore.md#recovering-a-deleted-tenant) — then removed automatically. |

**Archive…** asks how long to keep the archive (1 to 3650 days, the
platform's archive retention by default), or **Never expire**. **When the
archive expires, the tenant is deleted** — there is nothing left to restore it
from. An archive that never expires is kept until you delete the tenant by
hand, and so is the archive of a tenant kept out of automatic archive and
delete.

An archived tenant's page shows only that: **ARCHIVED**, the archive bundle's
date and size, how long it is kept, and **Restore archived tenant**. Its
earlier backup bundles expire as usual; the archive bundle stays its newest,
since no new bundle is taken of an archived tenant. **Backups → Tenants**
keeps listing it, marked *Archived*.

Archive and Delete can also happen by themselves: a suspended tenant archived
after a set number of days, an archived one deleted after another, each told
some days ahead. Both are off until switched on — see
[Automatic archive and delete](platform-settings.md#automatic-archive-and-delete).
To hold one tenant back from that, tick **Actions → Keep out of automatic
archive and delete**: it is saved at once, the page then says *Kept out of
automatic archive and delete* under the tenant's name, and the tenant is never
archived or deleted by itself — you still can, by hand.

An archived tenant has no storage volume: archiving deletes it once the
bundle is complete, and **Restore** creates a new one. Volumes that earlier
releases left behind on archived tenants are removed by the platform once
their archive bundle is ready.

!!! warning "Archive vs Delete"
    **Archive** is the safe choice when a customer leaves but might come
    back — everything survives in the archive bundle until it expires. **Delete** is permanent and
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

### Interrupted storage operations

A resize, a restore, a filesystem check and an archive run inside the platform
API after you have started them, and can take from a minute to more than an
hour. If the API restarts in the middle — an upgrade, a crash, a lost node —
the operation is **picked up again** a few minutes later and carried on from
where it stood. Its progress reads *Picked up again after the platform API
restarted* for a moment; nothing is asked of you.

What "carried on" means:

- the tenant's workloads come back at the replica counts they had before the
  operation stopped them, not at zero;
- a copy of the files that was already taken is not taken twice;
- a **shrink** that had already replaced the volume restores the files into
  the new one — it never starts the tenant on the empty volume;
- a **restore** does not revert or overwrite a second time once the tenant is
  running again;
- a **filesystem check** waits for the tool that was already running instead
  of starting a second one on the same volume.

Until it is picked up, a tenant the operation had stopped stays stopped —
typically three to five minutes.

An operation interrupted **three times over** is ended as *failed* with its
workloads started again, and the admins are notified; check the tenant, then
**Reset to idle** (on the tenant's **Storage & backups** section) and start the
operation again.

!!! warning "A failed shrink can leave the tenant stopped on purpose"
    A shrink deletes the tenant's volume and restores the files into a smaller
    one. If it fails in between — the restore Job failed, or it was ended
    after three interruptions — the files are in the **pre-resize bundle**
    (kept 7 days) and the volume is empty or half restored. The platform then
    leaves the workloads **stopped** rather than start the tenant on an empty
    volume, and the failure says so. Restore the files from that bundle into
    the tenant (**Backups**), then **Reset to idle**, which starts the
    workloads. Resetting first starts them on the volume as it is.

    A restore from a retained volume that fails with the storage claim
    deleted leaves the tenant stopped the same way: **Reset to idle**,
    then start that restore again — both volumes are kept.

A **suspend**, a **resume** and a **delete** cut off by a restart are finished
the same way, a few minutes later: the steps that were done are not repeated
(the tenant is not told twice), the rest are run, and a delete goes on to
remove the tenant. If you have changed the tenant in the meantime — resumed
one whose suspend was cut off, say, or cancelled the operation it belonged to
— the interrupted change is not finished over yours: it is closed, and the
steps it never ran read *failed — Interrupted* under **Platform → Tenant
Lifecycle Hooks**. The same happens to one found more than six hours late,
and to a **decommission** (which keeps the tenant): start that again.

A **move** to another server that loses its process is ended after thirty
minutes and the tenant's workloads are started again.

**Cancel** on a running storage operation stops it where it is and starts the
workloads again.

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
reach the cluster. The panel under the *Compute* limits on **Plan & limits**
says which state the tenant is in and what pressing the button will do, and
the *In force* column reads **Waiting for Re-apply** until it is:

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


A tenant inherits CPU, memory, storage, bandwidth, mailbox and sub-user
counts, send limits and monthly price from its **plan**. **Plan & limits**
shows each limit as one row: what is in use, what the tenant gets (with a
**Custom** or **Plan** badge), and — where the platform can tell — whether it
is in force: CPU tier and ceiling against what the namespace applies, send
limits against what the mail server holds.

When one customer needs something different, click **Edit limits**. Every
row gets a **Plan · value / Custom** switch; change as many as you need, and
a bar at the bottom counts the unsaved changes. **Review** lists each change
with what it will do — *grows online*, *shrinks with downtime*, *below the 4
mailboxes in use*, *waits for Re-apply* — and **Save** sends only the limits
that changed. A change the server would refuse (a storage limit below what is
in use) blocks the save until it is fixed. **Put every limit back on the
plan** switches them all at once.

**Compare plans for this tenant** at the bottom sets the plans side by side
against the tenant's current use, flags where a plan would not fit it, and
moves the tenant with **Switch to …** — custom limits stay as they are.

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
  and surfaces a progress modal. The filesystem grows on a running pod; for a
  tenant with no workload running, the platform keeps the tenant's file
  manager up for the moment that takes. If nothing can mount the volume right
  now — the file manager is held stopped, or could not be started — the
  operation still ends as done and says, with the reason, that the filesystem
  grows when the tenant's next pod starts.
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
disagree, a banner appears on the tenant's **Overview** and **Plan & limits**:

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
size. Resolve it one of two ways, both under **Plan & limits → Edit limits**:

- **Raise the limit** — turn on the override for that resource and set it
  to at least what is provisioned. Immediate, and the right choice if the
  customer should keep the space.
- **Shrink the volume** — reduce the storage override to the intended
  size. This is a destructive resize (snapshot → drop → recreate →
  restore) and the platform will confirm before running it.

The banner clears on its own once the numbers agree; it re-checks every
minute.
