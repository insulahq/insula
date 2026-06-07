---
verified: 2026.6.7
---

# Storage and backups

Tenant files and databases live on **cluster storage** (replicated across nodes
when high availability is on). Backups, by contrast, are written **off the
cluster** — to a target you configure — because a backup that shares fate with
the thing it protects isn't a backup.

There are three distinct backup layers. Each answers a different "what if", and
they don't substitute for one another.

## The three layers

| Layer | Protects against | Granularity | Who restores |
|---|---|---|---|
| **1. Tenant backups (bundles)** | "A customer deleted a file / lost a mailbox / I need their data back" | Per-tenant, down to individual files, DB tables, or mailboxes | Admin or the tenant |
| **2. System snapshots + DB WAL** | "A platform-level component broke; roll back recent state" | Platform database + volume snapshots | Operator |
| **3. DR bundle** | "The whole cluster is gone" | Everything needed to cold-rebuild from nothing | Operator |

### 1. Tenant backups (bundles)

A **bundle** is one snapshot of one tenant's data, stored off-cluster. It's
split into components:

| Component | Contents |
|---|---|
| `files` | The tenant's storage volume (their site files, DB datadirs) |
| `mailboxes` | Per-mailbox mail exports |
| `config` | The tenant's rows across the platform database (domains, deployments, …) |
| `secrets` | The tenant's TLS secrets (encrypted) |

Bundles are created on a schedule, by an admin on demand, or by the tenant
themselves. Restores use a **Plesk-style cart**: you browse a bundle, add the
exact items you want back (specific files, specific tables, specific mailboxes),
and execute. Carts run item by item and resume from a failure rather than
restarting. A pre-restore snapshot is taken before any file restore so you can
roll back if a restore goes wrong.

The same machinery powers **GDPR data export**: a tenant can download an
encrypted bundle of their own data.

### 2. System snapshots and database WAL

The platform's own state — the PostgreSQL database, volume snapshots, secrets —
is protected separately from tenant data. Database write-ahead logging plus
volume snapshots let an operator roll back recent platform-level state without
touching individual tenants.

### 3. DR bundle (whole-platform cold restore)

The disaster-recovery path rebuilds a cluster **from nothing but backups**:
freshly bootstrap a node, then run the DR restore, which walks etcd → database →
secrets → storage volumes back into place. It is gated by a decrypt smoke-test
up front — if the operator's encryption key doesn't match the backups, the
restore stops before doing anything destructive.

!!! warning "The operator's encryption key is the linchpin"
    DR bundles are encrypted with an operator-held key (generated at bootstrap;
    printed once). **Without it, backups cannot be decrypted and disaster
    recovery is impossible.** Store it offline — a password manager and a paper
    copy. See the operator guide.

## Backup targets

All three layers write to **operator-configured targets**:

- **S3-compatible** object storage (default for production),
- **SFTP/SSH** to a remote server,
- **SMB/CIFS** shares.

Nothing leaves your infrastructure unless you point a target at it. Targets are
configured in the admin panel (Backups → targets); at most one tenant-backup
target is active at a time.

??? info "Under the hood"
    - Tenant bundles share one on-disk layout written through a `BackupStore`
      interface, with a `meta.json` commit marker written last so a bundle is
      only "restorable" once every enabled component succeeded. The `secrets`
      component is AES-256-GCM encrypted with the platform key; GDPR exports add
      a passphrase-derived second layer.
    - Volume snapshots and replication are provided by Longhorn; the platform
      database is CloudNativePG (CNPG) PostgreSQL, with WAL archiving for
      point-in-time recovery.
    - Authoritative sources:
      [TENANT_BACKUP.md](https://github.com/insulahq/insula/blob/main/docs/operations/TENANT_BACKUP.md),
      [BACKUP_COMPONENT_MODEL.md](https://github.com/insulahq/insula/blob/main/docs/architecture/BACKUP_COMPONENT_MODEL.md),
      [DISASTER_RECOVERY.md](https://github.com/insulahq/insula/blob/main/docs/operations/DISASTER_RECOVERY.md).
