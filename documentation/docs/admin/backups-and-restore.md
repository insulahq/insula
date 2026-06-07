---
verified: 2026.6.7
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

The cluster-wide **Secrets bundle** lives on the
[Disaster Recovery](#disaster-recovery) page, not here.

## Tenant backups

**Backups → Tenants** protects customer data, in three areas:

- **Snapshots** — one row per snapshot across all tenants. Per-row
  **Restore…** (opens the Restoration Wizard) and **Delete**. A global
  **Snapshot all eligible tenants** button at the top, plus per-tenant
  snapshot triggers.
- **Bundles** — per-tenant backup bundles. **Restore…** here opens the
  granular **restore cart** (below).
- **Targets, Schedules & Retention** — bind the `tenant` class to a target
  and set schedule/retention.

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

## Remote Storage Targets

**Backups → Remote Storage Targets** is where you register the off-cluster
destinations. Click **Add** and pick a type:

- **S3 / S3-compatible** — AWS S3 and compatibles (R2, Wasabi, MinIO,
  Garage, Ceph). For non-AWS providers there's a path-style toggle.
- **SFTP / SSH** — an SSH server.
- **CIFS / SMB** — a Windows/Samba share.

Each target row has **Test** (verify connectivity), **Activate**,
**Speedtest**, **Edit**, and **Delete**. When you add new credentials you
can test the draft before saving.

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
