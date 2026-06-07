---
verified: 2026.6.7
---

# Backup targets

A **backup target** is the off-site storage where Insula writes backups —
system snapshots, tenant bundles, and mail archives. Nothing leaves your
infrastructure until you point a target at it; that is your decision, and your
storage bill.

Insula supports three target types:

| Type | Examples |
|---|---|
| **S3-compatible** | Hetzner Object Storage, Backblaze B2, Cloudflare R2, Wasabi, MinIO, AWS S3, Garage, Ceph RGW |
| **SFTP (SSH)** | Hetzner Storage Box (SFTP), any corporate SFTP server |
| **SMB / CIFS** | Hetzner Storage Box (SMB), on-prem NAS |

You manage targets at **Backups → Remote Storage Targets**.

!!! note "One mediator handles every protocol"
    Every backup pipeline writes to a single in-cluster S3 endpoint provided by
    the **rclone-shim** — a small DaemonSet (one pod per node) that translates
    that S3 traffic to whatever upstream protocol your target uses
    (S3 / SFTP / SMB). You never configure rclone directly; you pick a target
    type and credentials, and the shim does the rest. It runs unprivileged and
    needs no kernel mounts. Details:
    [rclone-shim runbook](https://github.com/insulahq/insula/blob/main/docs/operations/BACKUP_RCLONE_SHIM.md).

## Adding a target

On **Backups → Remote Storage Targets**, click **Add target** and choose the
storage type. The form changes per type:

=== "S3-compatible"

    - **Endpoint**, **Bucket**, **Region**, **Access key**, **Secret key**.
    - Optional **prefix** — everything is stored under this path; you do not
      need to pre-create separate buckets per backup class.
    - **Use path-style URLs** — leave **on** (default) for Hetzner OS, MinIO,
      B2's S3 API, R2, Wasabi, Garage, Ceph. Turn **off** for AWS S3 in newer
      regions or some CDN-fronted setups (DNS-based virtual-hosted style).

=== "SFTP (SSH)"

    - **Host**, **path**, and **username**.
    - Authenticate with an **SSH key** or a **password**.

=== "SMB / CIFS"

    - **Host**, **share/path**, **username**, **password**.

!!! warning "NFS is not supported"
    NFS was removed as a target type — rclone has no NFS backend and the shim is
    unprivileged. Use SFTP or SMB to a Storage Box / NAS instead.

## Testing connectivity and speed

Before you rely on a target, prove it works. Each target row has these actions:

- **Test** — a connectivity + write check against the target (or, while you are
  filling in the form, a *draft test* against the unsaved credentials so you can
  fix typos before saving).
- **Speedtest** — measures real throughput to the target, so you know whether a
  full backup will finish inside your window.
- **Activate** — make this the target a backup class writes to.
- **Edit** / **Delete**.

A target may need to be explicitly **marked writable** before backups land on
it — the row surfaces a confirmation modal for that.

!!! tip "Test, then speedtest, then activate"
    A target that authenticates but pushes 2 MiB/s will silently blow past your
    backup window. Always run the speedtest on a new off-site target before you
    depend on it.

## Backup classes and target assignment

Insula splits backups into three **classes**, and you assign each class to a
target independently:

| Class | What it covers |
|---|---|
| `system` | etcd snapshots, Postgres base + WAL, secrets bundle |
| `tenant` | per-tenant data bundles (files, mailboxes, config, secrets) |
| `mail` | the Stalwart mail store (restic) |

Assign classes to targets under **Backups → Remote Storage Targets** (and the
per-class pages). When a class has **no** target assigned, the shim sleeps for
that class — no upstream I/O happens and no noisy failures are generated. That is
the expected state for a class you have not configured yet.

You can also use **snapshot classes** for in-cluster, block-level snapshots
(Longhorn) that are separate from off-site backups — those live on the
per-class pages (see [System backups & DR](system-backups-dr.md)).

## Switching a class to a new target

When you re-point a class, Insula drains in-flight backups using the old config
first, then swaps the assignment and rolls the shim. A progress chip shows the
phases (drain → write → reconcile → verify). If a backup is wedged and you must
switch anyway, a force option short-circuits the drain — any mid-upload over the
old config aborts and retries on the next schedule.

??? info "Under the hood"
    The shim is one `rclone serve s3` process per node. Clients (CNPG
    barman-cloud, restic, the etcd-snapshot job) talk to it at
    `http://backup-rclone-shim.platform.svc:9000`. The operator-configured
    bucket + prefix become the rclone root; the class name (`system` / `tenant`
    / `mail`) is the first path segment under it, auto-created on first write.
    A single platform-wide `BACKUP_TARGET_KEY` derives every credential —
    rclone `crypt`, the restic password, and the shim's own S3 keys — via HKDF.
    Rotating that key (`make backup-target-key-rotate`) invalidates **every**
    existing backup, so keep your offline secrets bundle first. Shim state is
    visible at **status** (`STATE_OK` / `STATE_NO_ASSIGNMENTS` /
    `STATE_MISSING_KEY` / `STATE_ERROR`) and self-heals on a 5-minute tick.
