---
verified: 2026.6.7
---

# Backup targets

A **backup target** is the off-site storage where Insula writes backups —
system snapshots, tenant bundles, and mail snapshots. Nothing leaves your
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
    - If the share has a recycle bin (Samba's `vfs_recycle`, a NAS's
      per-share recycle bin), files Insula deletes move there. Deleted and
      expired bundles keep their space until it is emptied: the target's used
      space counts them, the per-class sizes do not. Turn the recycle bin off
      for the backup share, or have it emptied on a schedule.

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

A switch copies nothing: the bundles already taken stay on the old target, and
new ones go to the new one. Keep the old target configured (it does not have
to be assigned to anything) — a restore of a tenant bundle reads it from the
target it was written to. For a bundle on a target the `tenant` class is not
bound to — the old one after a switch, a rebuilt cluster's previous target, a
migration source — Insula starts a temporary, read-only copy of the shim bound
to that target (`backup-source-<id>` in the `platform` namespace), reads
through it, and removes it once no restore has used it for 30 minutes. This
covers restore from archive, the restore cart (files, mailboxes, databases),
browsing a bundle's files, and cross-cluster migration imports. A target that
holds the archive of an archived tenant cannot be deleted.

Insula never **writes** to a target the `tenant` class is not bound to. A bundle
on one can be restored but not deleted (`BUNDLE_ON_UNBOUND_TARGET`), and expiry
leaves it alone: it stays listed past its expiry date, marked *kept on
&lt;target&gt;*, until you bind tenant backups to that target again — then it
expires and is deleted as usual. The reason: a bundle this cluster took and one a
cross-cluster migration registered look the same, and deleting from a migration
source would delete the other cluster's backups. If you remove the target
instead, Insula stops tracking where those bundles are and their data stays on
it. While a switch is rolling out, deletes and expiry wait for the shim to serve
the new binding (`BOUND_TARGET_SWITCHING`). A new bundle or an import always
goes to the bound target; naming another is refused (`BUNDLE_TARGET_NOT_BOUND`).

A target that accepts a connection and never answers holds the shim for every
class, since it opens all of its targets before it serves. The shim reports
Ready only once it serves, stops a start that has not served within two minutes
(the pod restarts with back-off), and a switch to such a target fails, saying so.
One case seen in the lab: an OpenSSH `internal-sftp` server in a chroot under a
container with an unbounded open-files limit (`ulimit -n` around 10⁹) spends
minutes closing descriptors before every session — run it with
`--ulimit nofile=65536:65536`.

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
