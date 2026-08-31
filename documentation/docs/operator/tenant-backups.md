---
verified: 2026.6.7
---

# Tenant backups

Tenant backups protect your customers' data: their files, mailboxes, database
config rows, and TLS secrets. Each backup is a **bundle** — one snapshot of one
tenant — written off-cluster to the target you assigned to the `tenant` class
(see [Backup targets](backup-targets.md)).

This page is the operator's view: scheduling, retention, reading bundle status,
and handling failures. The actual *restore* work — the Plesk-style shopping-cart
picker — is in the [Admin guide → Backups & restore](../admin/backups-and-restore.md).

## What a bundle contains

Every bundle is split into four **components**:

| Component | What |
|---|---|
| `files` | The tenant's data volume, as a tar.gz |
| `mailboxes` | Per-mailbox exports from the mail server |
| `config` | The database rows the tenant owns (clients, users, domains, deployments, …) |
| `secrets` | The tenant's TLS Secrets, encrypted |

!!! note "`meta.json` is the commit marker"
    A bundle is only restorable once `meta.json` is written, which happens
    **last** and **only when every enabled component succeeded**. A bundle on
    the target with no `meta.json` is incomplete — treat it as failed.

## Scheduling

There is a single, platform-wide schedule that drives **every** scheduled tenant
bundle — not one schedule per tenant. You edit it under **Backups → Schedules**
(the `tenant_bundle` entry). It is gate-enabled: the schedule only runs once a
target is assigned to the `tenant` class.

Which tenants are *included* in that schedule is controlled in two places:

- **Per plan** — a hosting plan's "include in scheduled bundles" flag is the
  default for every tenant on it.
- **Per tenant** — a per-tenant override (inherits from the plan when unset).

The **Backups → Tenants** tab shows an expandable *scheduled inclusion* summary
so you can see exactly which tenants are in or out of the daily run, and a
**Bundle all eligible** button to fire one off on demand.

!!! tip "On-demand bundles"
    Beyond the schedule, an operator can create a bundle for a single tenant
    from **Backups → Tenants**, and a tenant can self-serve a one-off "Run
    backup now" from their own panel. A tenant cannot run two bundles at once
    (the second is rejected to prevent corruption).

## Retention

- Each bundle gets an expiry at creation time from its retention setting.
- A **retention sweeper** runs every few minutes, deletes expired bundles from
  the target, and marks them `expired`.
- Stuck bundles still `running` after 24 hours are garbage-collected to `failed`
  so they don't hang forever.
- **Plans cap retention.** A hosting plan's maximum retention days caps both
  ad-hoc and scheduled bundles — a tenant cannot request a longer retention than
  their plan allows.

### Storage reclamation

Expiring a bundle removes its own directory from the target, but the `files` and
`mailboxes` components live in a shared per-tenant **restic repository** that
several bundles deduplicate against. Freeing that space is a separate step, so a
second sweeper reconciles each repository against the bundles the platform still
vouches for and drops the rest.

- Runs every 6 hours. It compares the snapshots actually in the repository with
  the bundles that are still live, then `restic forget`s the difference.
- `forget` only removes references; **`restic prune` reclaims the disk**. Prune
  is expensive, so it runs on its own cadence — at most once per repository per
  24 hours, a few repositories per pass. A repository with a large backlog
  converges over several nights rather than in one long stall.
- Because it reconciles rather than reacting to each expiry, it also reclaims
  snapshots left behind by bundles that were deleted directly.
- **Deleting the oldest snapshot never harms newer ones.** restic is
  content-addressed: every snapshot is a complete, independently restorable
  tree, and prune only discards data no remaining snapshot references. There is
  no "base backup" whose loss breaks the chain.

Once every part of a bundle is genuinely gone from the target, its row is
removed from **Backups → Tenants** rather than kept as an `expired` entry. A
bundle whose data spans two repositories stays listed until both have been
swept, so the list never hides a backup that still exists.

Settings (Backups → Settings) — the defaults suit most installs:

| Setting | Default | Effect |
|---|---|---|
| Reclamation enabled | on | Master switch for forget/prune |
| Minimum snapshot age | 48 h | Snapshots younger than this are never removed, whatever the database says |
| Prune interval | 24 h | Minimum gap between prunes of the same repository |
| Max repack size | 4G | Caps the work in one prune pass |

If a repository holds snapshots but the platform has **no record of any bundle**
for that tenant, the sweeper skips it and logs a warning instead of deleting.
That combination is the signature of a restored or damaged platform database, so
it refuses to guess; a tenant that simply aged out still has its expired bundle
rows and is reclaimed normally. Use the per-tenant run with the force option
once you have confirmed the repository really is abandoned.

## Reading bundle status

In **Backups → Tenants**, each bundle shows an overall status and a
per-component breakdown. The status you care about:

- **completed** — every enabled component succeeded and `meta.json` is written.
  Restorable.
- **partial** — capture finished but at least one component failed. **Not** a
  safe restore source — see below.
- **failed** — the bundle did not complete.
- **expired** — past retention; removed from the target. The entry disappears
  from the list once its storage has also been reclaimed (see
  [Storage reclamation](#storage-reclamation)).

## Partial-failure handling

A `partial` bundle means one component (say, `mailboxes`) failed while others
succeeded.

!!! warning "Never treat a partial bundle as a good backup"
    A `partial` bundle is missing data. Do not rely on it for a restore. Find
    the failing component, fix the cause, and re-run the bundle until it reports
    **completed**.

To diagnose, open the bundle and look at the per-component status — anything
other than `completed` is the culprit. The component's `lastError` carries a
sanitised reason; full detail is in the platform-api logs:

```bash
kubectl -n platform logs -l app=platform-api --tail=200
```

You can also **verify** a bundle — it reads every component back, decrypts the
secrets, and decompresses the config dump, reporting any parse/decrypt error and
per-component sizes. Run it after a suspicious capture or before relying on a
bundle for a real recovery.

## Where restores happen

Restores are not immediate — they are a **cart**. You browse a completed bundle,
add the items you want (specific tables, deployments, domains, file paths, or
mailboxes), and execute them in order. Carts that include files take a
**pre-restore snapshot** first, so a files restore can be rolled back.

| Surface | Where |
|---|---|
| Operator restore cart (one bundle) | **Backups → Tenants** → a bundle row → **Restore** |
| Recent restore carts (resume failed/paused) | **Restores** |
| Per-tenant bundle list | a tenant's detail page → **Backups** tab |

Tenants can also restore from their own panel, through a stricter policy that
hides and rejects platform/billing tables. Full details and the cart mechanics:
[Tenant Backup runbook](https://github.com/insulahq/insula/blob/main/docs/operations/TENANT_BACKUP.md)
and [Admin → Backups & restore](../admin/backups-and-restore.md).

## GDPR data export

A bundle can be created as a passphrase-encrypted **data export** for a tenant
who requests their data. The platform wraps every component into a single
encrypted archive and never stores the passphrase. The tenant decrypts it
locally with standard `openssl`. The command and download routes are in the
runbook above.

??? info "Under the hood"
    Bundles are written via a `BackupStore` abstraction (S3 or SFTP) through the
    rclone-shim. The global scheduler runs every 5 minutes on each platform-api
    replica, firing within ±5 minutes of the cron HH:MM, with `last_fired_at` as
    the dedup marker. Restore items are idempotent (`INSERT … ON CONFLICT DO
    UPDATE` per allow-listed table; tar-extract per file path; per-mailbox
    import), and every executor asserts the bundle's tenant matches the restore
    job's tenant before applying anything.
