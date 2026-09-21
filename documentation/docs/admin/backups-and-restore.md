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
  repository size; open it for that tenant's bundles, a repo-size
  refresh, and its restore carts. Each bundle's **Restore…** opens the
  granular **restore cart** (below) for exactly that bundle — restores
  never silently "pick the latest".
  The **Scheduled inclusion** panel lists every tenant with its
  include/exclude state for the daily bundle cron and lets you override
  it per tenant (*Inherit plan* / *Always include* / *Exclude from
  schedule*).

    ??? info "Backups load when you open a tenant"
        The page itself loads only the tenant list — every tenant, with
        its backup count and repository size. No backup is fetched until
        you open a tenant, and opening one loads **all** of that tenant's
        backups, however many there are. While it works through them the
        wait says how many it is fetching, and once rows appear it keeps
        reporting how many of the total have loaded — so a list still
        filling in is never mistaken for a complete one.

        The count on a tenant's row is that tenant's real total, from the
        per-tenant figures rather than from whatever is on screen, so it
        is correct before you have opened anything.

    ??? info "Bundle Size and Restic Size are different questions"
        **Bundle Size** is everything the bundle captured, at its logical
        size. A scheduled bundle re-states the tenant's whole footprint
        every night, so these figures are large and **must not be added
        up** — summing a month of nightlies suggests tens of times more
        storage than exists.

        **Restic Size** is what that bundle actually *added* to the
        repository after deduplication and compression. This is the
        figure that answers "what did this cost", and unlike Bundle Size
        it is meaningful to add up: the sum across a tenant's bundles is
        the repository size.

        A bundle captured before the platform recorded this shows **—**
        rather than `0`, which would claim it stored nothing.

    ??? info "How repo size is kept current"
        **repo** is the real size of the tenant's restic repository — what
        the backup target actually holds.

        It maintains itself: every backup reports how much it added, and
        that advances the total at no extra cost. It is re-measured
        properly with `restic stats` after each prune (the only operation
        that makes a repository smaller), and any repository that has
        never been measured is measured once by the reclamation sweep.
        **Refresh repo size** forces a measurement immediately.

        Hover the figure to see which of the two you are looking at —
        *measured* straight from the repository, or *tracked* since the
        last measurement — and when it was last verified. A tracked
        figure errs slightly high rather than low.

        Until a repository has been measured even once the row reads
        **not measured yet**, never `0` — a zero in a size column reads as
        "this tenant has no backups".

        A tenant's repository is measured per component (files,
        mailboxes) and summed. If one component's repository is
        unreachable, its error is reported and it contributes nothing
        rather than silently making the total wrong.

    ??? info "How long backups are kept"
        Two limits, set per subsystem under **Targets, Schedules &
        Retention**, and a backup is removed as soon as **either** of them
        is reached:

        - **Retention (days)** — a backup is removed once it is older than
          this, whatever else is kept.
        - **Retention (keep last N)** — only the newest N backups per
          tenant are kept.

        So a tenant backed up nightly with 30 days and keep-last-14 settles
        at 14; one backed up weekly with the same settings is bounded by
        the days instead. Leaving keep-last-N empty applies no count limit
        — it is never read as "keep none".

        Only **restorable** backups count toward N. A failed run holds no
        data and does not occupy one of the N places, so a run of failures
        cannot quietly reduce how much real coverage you have. A backup
        that an open restore refers to is never removed while that restore
        is still in progress.

        Reducing keep-last-N takes effect on the next retention pass, and
        it **deletes** the backups it brings you down to. Raising it does
        not bring anything back.

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

### "Repository is readable but locked"

restic takes a lock on the repository whenever it writes — during a
snapshot, during retention cleanup, and while a repository is first
created. If the pod holding that lock is killed part-way through (the
node is drained, the process runs out of memory, someone deletes the
job), the lock object is left behind. It does **not** expire on its own.

A repository in that state still *reads* perfectly well, so the snapshot
list keeps loading normally. What stops is writing: every following
snapshot fails, and the newest entry in the list quietly stops advancing.

When this happens the page shows an amber banner with a **Clear stale
locks** button. Clearing is safe to press at any time:

- It removes only locks whose owning process is gone. A snapshot that is
  genuinely running right now keeps its lock and is never interrupted.
- If a lock survives, the result says so and tells you to wait — that
  lock belongs to a live backup, and there is deliberately no way to
  force past it from the panel.

You usually will not need the button. Scheduled snapshots now clear stale
locks themselves before giving up, so a repository left locked by a
killed pod recovers on its own at the next run. The button is for when
you would rather not wait for it.

!!! tip "Check the age, not just the list"
    A repository can look healthy — reachable, snapshots listed — while
    nothing new has been written for days. The useful question is how old
    the *newest* snapshot is compared with the mail schedule.
    `platform-ops dr preflight` answers it directly and warns when
    snapshots have stopped landing.

!!! note "Schedule toggles are authoritative"
    The per-class schedule cards on *Targets, Schedules & Retention*
    really gate the runs: disabling the **mail** schedule suspends the
    snapshot cadence, and the **tenant** schedule only bundles when
    enabled. When a scheduled tenant wave fails for any tenant, an
    **admin notification** is raised — a silent night is a completed
    night.

## What the platform tells you when a backup goes wrong

Four separate things can go wrong with a backup, and they are reported
separately because they need different actions.

| You are told | When | What it means |
|---|---|---|
| **Backup failed** | a run executed and failed, within ~5 min | Something ran and returned an error. The message names the job and the reason. |
| **Backups have stopped running** | a scheduled run did not happen | Nothing ran. There is no failed job to look at — this is the only signal you get. |
| **Backup has never run** | a schedule has never once succeeded | Setup, not a regression: the destination, its credentials, or the schedule have most likely never worked. |
| **Backup target unreachable** | the destination cannot be contacted | The repository itself is unreachable or timing out. |

!!! note "Silence is measured against the schedule, not the clock"
    *Backups have stopped* counts **missed scheduled runs**, not elapsed
    hours. A weekday-only schedule is not called stale over a weekend, and
    a half-hourly one is not given a day's grace just because a daily one
    needs it. The schedule's own **timezone** is honoured — a job set to
    run at 03:00 Berlin is judged at 03:00 Berlin.

    You are told roughly an hour after a run was due and did not happen —
    for a daily backup that is the same morning, leaving the day to fix it
    before the next attempt. A run still **in progress** is never counted
    as missed, and a schedule that is **suspended** is not reported at all:
    it is off because someone turned it off.

!!! note "\"Never run\" is deliberately not \"stopped\""
    They are separate alerts because they send you to different places. A
    backup that has stopped is a regression — something that worked no
    longer does. A backup that has never run has never worked, and looking
    for what changed will waste your time.

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

For tenant **bundles**, restore works like a shopping cart: you
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
