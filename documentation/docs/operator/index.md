---
verified: 2026.6.7
---

# Operator guide

You are the **operator**: you own the servers Insula runs on. You ran the
install, you add and remove nodes, you point backups at off-site storage, and
you apply platform updates. The admin and tenant work — creating clients,
managing domains, restoring a customer's files — happens in the panels and is
covered in the [Admin guide](../admin/index.md) and
[Tenant guide](../tenant/index.md).

!!! note "You do not need to be a Kubernetes expert"
    Insula installs and runs [k3s](https://k3s.io) (a lightweight Kubernetes)
    for you. Nearly everything in this guide is a button in the admin panel or
    one command over SSH. You reach for raw `kubectl` only in the
    [troubleshooting](troubleshooting.md) cases, and even then the exact
    commands are given.

## The mental model

Think of Insula as three layers stacked on your hardware:

1. **Your servers** — Linux VMs you rent or own. Each one runs a k3s node.
2. **The platform** — the control plane, panels, database (PostgreSQL via
   CNPG), mail server (Stalwart), storage (Longhorn), and ingress (Traefik).
   This is what Insula installs and keeps running.
3. **Tenant workloads** — your customers' websites, apps, databases, and
   mailboxes, each isolated in its own namespace.

Your job is to keep layer 1 healthy and let Insula manage layers 2 and 3. When
something at layer 2 or 3 misbehaves, the admin panel almost always has a
read-out and a recovery action for it.

## Map of this guide

| Page | What it covers |
|---|---|
| [Nodes & cluster](nodes-and-cluster.md) | Node cards, adding nodes, cordon/drain, removing nodes, the node terminal |
| [High availability](high-availability.md) | What HA mode changes, when to enable it, mail HA |
| [Updates & releases](updates-and-releases.md) | CalVer releases, the pull-based upgrade flow, `platform-ops` |
| [Backup targets](backup-targets.md) | Configuring S3 / SFTP / SMB storage, the rclone-shim, connectivity tests |
| [System backups & DR](system-backups-dr.md) | System snapshots, Postgres PITR, the DR bundle and age key, cold restore |
| [Tenant backups](tenant-backups.md) | Schedules, retention, bundle status, partial failures |
| [Mail operations](mail-operations.md) | Mail node placement, port exposure, TLS, deliverability |
| [Security hardening](security-hardening.md) | SSH lockdown, mesh, firewall, the Posture page |
| [Web defense](web-defense.md) | WAF, CrowdSec bans, trusted proxies |
| [Monitoring & health](monitoring.md) | What observability ships in the box (and what does not) |
| [Troubleshooting](troubleshooting.md) | First-response steps for the most common incidents |

## Where you spend your time

Almost all operator work happens in the **admin panel**, in three sidebar
groups:

- **Cluster** — Nodes, Storage, Networking, Ingress & TLS, Load Balancer.
- **Backups** — System, Tenants, Mail, Remote Storage Targets, Disaster
  Recovery.
- **Security** — Posture, Network Trust, Web Defense, Identity & Sessions.

The rest is **Platform Settings** (Updates, Upgrades, Notifications, Lifecycle
Hooks) and the **Monitoring** page.

## An operator's rhythm

You do not need to babysit Insula. A light, regular cadence catches problems
before they become incidents.

=== "Weekly"

    - Glance at **Monitoring → Node Health** and the **Cluster Nodes** health
      bar — all nodes Ready, no CPU/memory/disk pressure, no subsystem badges.
    - Check the notification bell for backup failures, mail-delivery warnings,
      or security events.
    - Confirm last night's backups ran: **Backups → System** and
      **Backups → Tenants**.

=== "Monthly"

    - Review **Platform Settings → Upgrades** for a new release and apply it
      (see [Updates & releases](updates-and-releases.md)).
    - Open **Security → Posture** and clear any new CIS findings, cert-expiry
      warnings, or unencrypted backup targets.
    - Verify a backup is actually restorable — pick one tenant bundle and run
      **Verify** (see [Tenant backups](tenant-backups.md)).

=== "Quarterly"

    - Run a **disaster-recovery drill** against a throwaway VM
      ([System backups & DR](system-backups-dr.md)). A restore script you have
      never exercised is a restore script you cannot trust.
    - Confirm you can still read back your **operator age key** from wherever
      you stored it. Without it, your backups are not decryptable.

!!! warning "The one thing you cannot lose"
    Your **operator age private key** (`AGE-SECRET-KEY-1…`) is the only thing
    that can decrypt the backups this cluster produces. Store it in at least
    two places, off the cluster. See
    [System backups & DR](system-backups-dr.md).

## What lives outside this manual

The deep technical material — architecture decisions, the data model, network
design — lives next to the source code in the
[`docs/` directory](https://github.com/insulahq/insula/tree/main/docs) of the
repository. This guide links into those runbooks where you need them, but stays
focused on *running* the platform.
