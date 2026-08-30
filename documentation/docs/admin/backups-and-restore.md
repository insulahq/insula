---
verified: 2026.7.2
---

# Backups & restore

Insula protects three things, separately: the **platform itself**
(Postgres, etcd, secrets, monitoring), each **tenant's** data, and the
**mail server**. Each of these is a *backup class*, and each can be pointed
at an off-cluster *Remote Storage Target*. The **Backups** sidebar group
gives you a dashboard plus one page per class, a targets page, and a
disaster-recovery page.

The single most important distinction:

!!! info "Snapshots vs backups"
    A **snapshot** is an in-cluster, point-in-time block copy (Longhorn
    CSI). It's cheap and fast and survives an accidental delete — but **not
    cluster loss**. A **backup** is an artifact uploaded to an off-cluster
    target (S3, SFTP, CIFS). It survives losing the whole cluster. You want
    both: snapshots for quick undo, backups for real disaster recovery.

## Backups Dashboard

**Backups → Dashboard** answers "is anything on fire?" in one screen: a
health banner, one stat card per class (System / Tenants / Mail) plus a
Remote Storage Targets card, and a recent-activity list. Each card
deep-links into its class. A failing or never-run class shows red/amber.

If a DR restore is in progress, a **frozen-targets banner** appears naming
each target that's been marked read-only — until you mark them read-write
again, retention prunes and new backups against them are refused.

## System backups

**Backups → System** protects the platform's own data, in three areas:

- **Snapshots** — block-level snapshots of system volumes, with per-snapshot
  take / in-place revert / prune-older / on-demand actions. CNPG (Postgres)
  clusters collapse into a single row.
- **Backups** — a page-level **Backup Now** button (triggers an on-demand
  Postgres backup) and CNPG scheduled-backup health.
- **Targets, Schedules & Retention** — bind the `system` class to a Remote
  Storage Target and set its schedule and retention.

!!! warning "Enabling WAL streaming or scheduled base backups restarts Postgres"
    The **first** enable of WAL streaming or scheduled base backups
    reconfigures the platform database's archive settings and performs a
    rolling restart of its Postgres instance(s) — the panel asks you to
    confirm. This can take up to ~5 minutes, during which the admin panel
    and API may be briefly unavailable. Hosted websites and tenant
    databases are **not** affected. Saving settings on an already-active
    configuration does not restart anything.

The cluster-wide **Secrets bundle** lives on the
[Disaster Recovery](#disaster-recovery) page, not here.

## Tenant backups

**Backups → Tenants** protects customer data, in three areas (the
**Backups** tab comes first — bundles are the durable artifact):

- **Backups** — **grouped by tenant**. Each tenant is one collapsible row
  showing its bundle count, how many restore carts it has open, and its
  two size figures; open it for that tenant's bundles, a repo-size
  refresh, and its restore carts. Each bundle's **Restore…** opens the
  granular **restore cart** (below) for exactly that bundle — restores
  never silently "pick the latest".
  The **Scheduled inclusion** panel lists every tenant with its
  include/exclude state for the daily bundle cron and lets you override
  it per tenant (*Inherit plan* / *Always include* / *Exclude from
  schedule*).

    ??? info "The two size figures mean different things"
        **bundles** is the sum of every bundle's logical size. restic
        deduplicates across snapshots, so this is **not** the storage the
        tenant consumes — it is generally larger.

        **repo** is the real size of the tenant's restic repository,
        measured by `restic stats`. It reads **not measured** until you
        press **Refresh repo size**, because measuring walks the
        repository index over the network and cannot run on every page
        load. It is deliberately never shown as `0` when unmeasured —
        a zero in a size column reads as "this tenant has no backups".

        A tenant's repository is measured per component (files,
        mailboxes) and summed. If one component's repository is
        unreachable, its error is reported and it contributes nothing
        rather than silently making the total wrong.

    ??? info "Restore carts in the group"
        Open a tenant's group to see its restore carts. **Resume**
        reopens a cart exactly where it was left, rather than starting a
        new one. **Delete** discards it — backups are untouched, only the
        selection. Both are unavailable while a cart is *executing*: the
        restore is mid-flight writing into the tenant's live namespace.
- **Snapshots** — one row per snapshot across all tenants. Snapshots are
  **temporary** on-cluster block copies: each is reaped automatically
  after the configured snapshot expiry (default 48 hours, Settings →
  System), which the tab states along with a per-row **Expires** column.
  Per-row **Restore…** (opens the Restoration Wizard) and **Delete**. A
  global **Snapshot all eligible tenants** button at the top, plus
  per-tenant snapshot triggers.
- **Targets, Schedules & Retention** — bind the `tenant` class to a target
  and set schedule/retention.

All backup and snapshot tables sort by any column (default: newest
first) and show the exact timestamp when you hover a relative time.

!!! note "Bind a target first"
    Snapshot and bundle actions need a backup target bound to the tenant
    class. If none is bound the action errors and points you at *Targets,
    Schedules & Retention*.

## Mail backups

**Backups → Mail** lists the mail server's restic snapshots — size, age,
and a short id. To restore, open a snapshot's **Restore** dialog:

- It's an **in-place** restore back onto the mail store.
- You pick the **target node** for the restore.
- You must type the snapshot's **short id** to confirm — a deliberate
  guard against restoring the wrong snapshot.

(The other mail-backup paths — the Stalwart-native archive and per-tenant
mailbox bundles — are described in [Email](email.md).)

Right after (re)assigning a mail target the page may briefly report a
transitional state instead of the snapshot list — *credentials are being
provisioned*, *backup gateway is restarting*, or *repository not
initialized yet* (a fresh repository is created by the first completed
snapshot upload). These resolve on their own within a minute or two;
only a persistent "not reachable" indicates a genuinely broken target.

Triggering a manual snapshot while **no** mail target is assigned still
works, but the snapshot stays on-cluster only — the panel shows a
warning that nothing is uploaded off-site.

Backup pages refresh automatically when a backup, restore, or snapshot
task finishes — no manual reload needed.

!!! note "Schedule toggles are authoritative"
    The per-class schedule cards on *Targets, Schedules & Retention*
    really gate the runs: disabling the **mail** schedule suspends the
    snapshot cadence, and the **tenant** schedule only bundles when
    enabled. When a scheduled tenant wave fails for any tenant, an
    **admin notification** is raised — a silent night is a completed
    night.

## Remote Storage Targets

**Backups → Remote Storage Targets** is where you register the off-cluster
destinations. Click **Add** and pick a type:

- **S3 / S3-compatible** — AWS S3 and compatibles (R2, Wasabi, MinIO,
  Garage, Ceph). For non-AWS providers there's a path-style toggle.
- **SFTP / SSH** — an SSH server.
- **CIFS / SMB** — a Windows/Samba share.

Each target row has **Test** (verify connectivity), **Speedtest**,
**Edit**, and **Delete**. When you add new credentials you can test the
draft before saving. A target does something once you **assign it to a
class** on the per-class *Targets, Schedules & Retention* tab — there is
no separate "activate" step (the legacy Activate flow was retired
2026-08).

### Read-only freeze during DR

A target can be marked **read-only** (frozen) — this is the safety
interlock during a disaster-recovery restore. While frozen, new backups
and retention prunes against that target are refused, and the freeze is
surfaced on the Backups Dashboard. Use the **Mark Read-Write** modal to
release it once you've verified the restored data.

## Disaster Recovery

**Backups → Disaster Recovery** is the full-cluster recovery surface, in
three sections:

- **Secrets Bundle** — an age-encrypted bundle of everything you'd need to
  rebuild the platform, with a coverage view of what's included.
- **DR Drill** — the operator-driven drill runbook plus a log of past
  drill runs, so you can prove recovery works before you need it.
- **Restore Instructions** — context-aware, pre-filled runbook steps for
  applying the secrets bundle and restoring Postgres and mail.
- **Migrate Tenants** — import tenants from *another* Insula cluster's backup
  target: point this cluster (read-only) at the source target, scan it, and
  import one tenant or all of them. Each import recreates the tenant from its
  latest bundle with its exact resource limits pinned, so a customer moves
  between clusters byte-identical — the only step left to you is repointing
  DNS.

The deep operator runbooks for these live in the
[Operator guide](../operator/system-backups-dr.md).

## Restoring: the wizard and the cart

Two restore experiences, depending on what you're restoring.

### The Restoration Wizard

Clicking **Restore…** on a **system** or **tenant snapshot** row opens the
**Restoration Wizard** — a three-step modal:

1. **What to restore** — defaults to "everything".
2. **Where to restore** — *in-place* (overwrite the live data) vs
   *side-by-side* (a suffixed copy you can inspect first).
3. **Pre-checks & confirm** — review any non-blocking warnings, then
   **Start restore**.

The restore fires as a background task: the modal closes in about a second
and the Task Center chip tracks progress. If the artifact turns out to be a
**tenant bundle**, the wizard routes you into the restore cart instead.

### The restore cart (granular tenant restore)

For tenant **bundles**, restore is Plesk-style: a shopping cart where you
pick exactly which pieces to bring back — specific config tables,
deployments, domains, mailboxes, or files — add them to the cart, then
execute. The admin cart additionally supports **rollback** if a restore
goes wrong. This is the surface to use when a customer needs "just my
WordPress database from Tuesday", not the whole account.

## On-demand backups and snapshots

You don't have to wait for a schedule:

- **System Backups → Backup Now** triggers an immediate Postgres backup.
- **Tenant Backups** has **Snapshot all eligible tenants** and per-tenant
  snapshot/bundle triggers.
- A tenant's own **Backups** tab (see [Tenants](tenants.md)) lets you
  trigger and restore for one tenant.
