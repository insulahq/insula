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
Remote Storage Targets card, and a recent-activity list (failures first,
then the most recent runs). Each card deep-links into its class. A failing
or never-run class shows red/amber.

The **Tenants** card counts tenants by their newest finished bundle: a
`completed` bundle makes the tenant healthy, a `partial` or `failed` one
makes it failing (until a newer bundle completes). A tenant included in the
nightly bundle run that has no bundle yet counts as **never run**. The card
turns amber for any of these, and **red** when a bundle failed outright or a
tenant in the nightly run has gone two nightly runs (48 h) without a
completed bundle. It also shows when the newest tenant bundle succeeded.

A tenant **opted out of scheduled bundles** that has never been bundled
does not appear on the card at all — it is not covered, by your choice. Check
coverage per tenant under **Backups → Tenants**.

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

!!! info "Schedules are wall-clock time in the platform's timezone"
    Every cron expression on this page is read in the timezone set under
    **Settings → System**, which is also the timezone the platform writes into
    each Kubernetes CronJob. The zone is named beside the field, e.g.
    **Cron expression (Africa/Windhoek)** — so `30 3 * * *` means half past
    three in the morning *there*, not in UTC.

    Changing the platform timezone therefore moves every schedule on this page.

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

    !!! note "Backups pause while a tenant is suspended"
        A **suspended** tenant shows **paused — suspended** in the
        Scheduled inclusion panel. While it stays suspended:

        - the daily bundle run skips it, and **Backup now** (here and in
          the tenant's own panel) is refused;
        - **Bundle all eligible tenants** leaves it out;
        - its existing backups are **kept**: retention neither expires nor
          deletes them, however long the suspension lasts.

        Nothing goes unprotected meanwhile: a suspended tenant's sites are
        offline, its mailboxes refuse sign-ins and incoming mail, so its data
        does not change, and the platform's mail backup keeps covering its
        mailboxes. On **Reactivate** the daily run picks the tenant up again.
        Until its first new bundle completes, its newest existing bundle is
        kept, even if that bundle is past its retention date.

    ??? info "The last good copy of each part is never aged out"
        For an active tenant, retention keeps the newest bundle and, per
        part (files, mailboxes, config, secrets), the newest bundle in which
        that part **completed** — even past its retention date. A newer
        **partial** bundle whose mail capture failed therefore does not let
        the last good mail copy expire; it is released once a newer bundle
        completes mail. At most one extra bundle per part is held this way.

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

**Backups → Disaster Recovery** is the full-cluster recovery surface:

- **Recover Tenant** — re-create one tenant from its off-site bundle: after
  cluster loss, or after it was **deleted**. Search for the tenant by name
  (deleted tenants are marked *DELETED* with the date and how long their
  bundles are kept). The screen shows what you are about to restore — plan,
  storage tier, primary node, namespace (and whether it still exists),
  resources — and lists every bundle with when it was taken, by what, what it
  holds and its size; the newest completed one is chosen, any other is a
  click. Pick a **target node** (searchable) or leave it automatic.
- **Recover All** — restore every tenant whose namespace is missing, after a
  cluster rebuild. Tenants **deleted on purpose are skipped** (listed as
  *deleted*) — recover one of those with **Recover Tenant**.

A recovery runs on the server, not in the page. **Recover** (or **Confirm
recover** for Recover All) opens a progress window and the recovery appears in
the **Task Center** in the top bar:

- **Recover Tenant** shows each phase as it runs — re-creating a deleted
  tenant, checking the bundle, provisioning, queuing and running the restore,
  re-establishing services — with the restore's items one by one (which is
  applying, which are done). When it finishes it shows what came back: whether
  the tenant was re-created, the ingress / mail-signing / workload reconcile,
  and any **remaining manual steps**. A failure names the step it stopped at,
  with what to do about it.
- **Recover All** shows one row per tenant — waiting, the step it is on,
  recovered, or why it failed — plus the tenants the run passed over.

Close the window whenever you like (**Run in background**): the recovery keeps
going, and clicking it in the Task Center reopens the same window, including
the final result. Only one recovery of a tenant — and one Recover All — runs at
a time; starting a second is refused with a pointer to the running one. If the
platform API restarts while a recovery runs, the window says it stopped
reporting progress; starting the recovery again marks the stopped run failed
and begins a fresh one.
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

### Recovering a deleted tenant

Deleting a tenant keeps its off-site bundles for the **deleted-tenant retention
window** (**Platform → Limits**, default 30 days) — so it can be brought back
until they expire. A deleted tenant is in no tenant list any more; find it here:

1. **Backups → Tenants → Backups**: the **Deleted tenants — still recoverable**
   card lists each one by name, with the date it was deleted and the date its
   bundles expire. (Right after a delete, the tenants list banner says the same
   and links straight there.)
2. **Recover…** opens **Disaster Recovery → Recover Tenant** with the tenant
   selected. Check what it was (plan, node, namespace), choose a bundle by its
   date — or keep the newest — and run it.

The tenant is re-created with its **original id and namespace**, then its
configuration, files and mailboxes are restored. A tenant that never had a
completed bundle cannot be recovered.

## Exporting a bundle

Every completed bundle has an **Export** button in the bundle list. It streams
the whole bundle down as a `.tar.gz` — `meta.json`, the tenant's configuration
rows, their TLS secrets, every file, and every mailbox as a browsable Maildir
under `components/mailboxes/<address>/`. Nothing is staged on the server, so a
large tenant downloads at the speed of your connection rather than waiting for
the platform to assemble an archive first.

The `secrets` component stays encrypted inside the archive with the platform's
own key, so a plain download never exposes TLS private keys.

Use this when a tenant asks for their data, when you are moving a tenant to
another cluster by hand, or to satisfy a data-portability request.

## Importing a bundle

**Backups → Tenants → Bundles → Import bundle.**

The reverse of an export: take a bundle archive — from this cluster or another
one — and put it back. The result is a normal bundle. It appears in the tenant's
bundle list, it browses, it restores, you can export it again. Nothing about the
restore side knows it arrived by upload.

Pick the archive, choose which tenant it goes into and which backup target
stores it, and the dialog does the rest: it uploads the file in parallel chunks
(cancellable, with real progress), reads the manifest, and then **stops and
shows you what it found** before anything is committed:

- every file and mailbox it will import
- anything it will **not** import, and why
- the tenant's storage head-room
- any reason it cannot proceed at all

Read that screen. An import is not undone by a button.

Imported bundles are labelled **`manual-import`**, plus whatever note you add,
so they are obvious in the bundle list.

### Encrypted archives

If you exported with a passphrase, supply the same passphrase here. The dialog
asks for one as soon as you pick a `.enc` file. A wrong passphrase is reported
as a wrong passphrase, not as a corrupt archive.

### What gets refused

- **Mailboxes on a domain the target tenant does not own.** An export came from
  a tenant who owned those addresses; an upload is just a file and can claim
  anything. Every address is checked against the target tenant's verified mail
  domains before a single mailbox is created. Add and verify the domain first,
  or import into the tenant that owns it.
- **A bundle larger than the tenant's storage allowance.** Checked against the
  archive's real size, not the size it claims, and checked again against what
  actually landed.
- **The older whole-tenant mailbox format**, for tenants importing on their own
  behalf — its addresses cannot be listed before importing, so only an operator
  can bring one in, and the manual says so on screen.

### If an import fails

Nothing is registered. Either the bundle is complete or it does not exist —
there is no half-imported bundle for the restore cart to trip over. Partial
snapshots are removed, and **the uploaded archive is kept** so retrying does not
mean re-uploading several gigabytes. Abandoned uploads are cleaned up on their
own.

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

### Picking what to restore

The cart's **Mailboxes** tab lists the tenant's mailbox addresses as captured
in that bundle, so you pick `someone@example.test` rather than an identifier.
Restoring one mailbox fetches only that mailbox.

Bundle lists and disaster recovery show **tenant names**, not internal ids.
Recovery offers the tenants that actually have bundles on the target —
including tenants already deleted from this cluster, which is the case cold
restore exists for. If you are recovering from a target this cluster has never
written to, switch the field to accept a tenant id directly.

## On-demand backups and snapshots

You don't have to wait for a schedule:

- **System Backups → Backup Now** triggers an immediate Postgres backup.
- **Tenant Backups** has **Snapshot all eligible tenants** and per-tenant
  snapshot/bundle triggers.
- A tenant's own **Backups** tab (see [Tenants](tenants.md)) lets you
  trigger and restore for one tenant.
