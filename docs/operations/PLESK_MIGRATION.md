# Plesk Migration — Operator Runbook

> Migrate a Plesk subscription — domains, websites, databases, mailboxes, cron
> jobs, and DNS — onto a platform tenant. **Agentless:** the platform SSHes into
> the Plesk box for read-only discovery, then drives one-shot Kubernetes Jobs to
> move data. R1 / ADR-052.
>
> Roadmap context: [ROADMAP.md → R1](../roadmap/ROADMAP.md#r1--plesk-migration-service).
> Cron extraction detail: [CUSTOMER_CRON_JOBS.md](../features/CUSTOMER_CRON_JOBS.md).

## Concept

The flow has three operator-driven phases, all under **Admin → Platform → Plesk
Migration** (`super_admin` only):

1. **Register a source** — the Plesk box's hostname + SSH credential.
2. **Discover** — a read-only inventory Job lists the subscriptions on that box
   (domains, mailboxes, databases, mail size, cron count).
3. **Migrate a subscription** — map it onto a tenant you have **already created
   and sized**, then the platform runs the import legs sequentially.

**Tenant-first.** The platform does *not* invent a tenant from the Plesk
subscription. You create + size the tenant under **Tenants** first (pick the
plan, set storage), then map the subscription onto it. This keeps plan/billing
decisions with the operator and makes a re-run (Retry) idempotent.

**Legs run in order**, each persisting its own state so a failure is resumable:

```
preflight → domains → email → databases → content → mail → cron
```

A migration that finishes with one or more failed legs is reported as
`partial` — treat that as **not done** and Retry after fixing the cause.

## Prerequisites

- **`PLATFORM_ENCRYPTION_KEY`** set on platform-api (it encrypts the stored SSH
  credential, AES-256-GCM). Required in production; the dev fallback is insecure.
- **SSH access to the Plesk box** as a user that can run the `plesk` CLI and read
  the mail/DB trees — in practice `root` on port 22. Discovery runs
  `plesk version`, `plesk db`, `crontab -u <sysuser> -l`, and `du` over the
  maildir/DB directories.
- **The migration tool images are pullable** by the cluster:
  - `migration-tools` — DB + content legs (override: `PLESK_MIGRATION_TOOLS_IMAGE`)
  - `mail-backup-tools` — mail leg + discovery (override: `PLESK_MAIL_TOOLS_IMAGE`,
    `PLESK_DISCOVERY_IMAGE`)
  - All Jobs run `imagePullPolicy: Always` — a `:latest` tag never serves a stale
    cached layer, but the registry must be reachable.
- **The target tenant exists, is provisioned, and is sized** for the
  subscription's mail + database footprint (see *Capacity preflight*).

## Register a source

**Admin → Platform → Plesk Migration → Add Source.**

| Field | Notes |
|-------|-------|
| Name | Free-form label |
| Hostname / IP | The Plesk box |
| SSH port | Default `22` |
| SSH user | Default `root` |
| Auth | **Key** (paste a PEM private key) **or** **Password** — exactly one |

- The credential is encrypted at rest (`plesk_sources.ssh_key_encrypted` /
  `ssh_password_encrypted`); it is **never** returned to the UI.
- Pasted private keys are normalized (CRLF→LF + one trailing newline) — OpenSSH
  rejects a key with no trailing newline with a cryptic `libcrypto` error, so
  don't worry about how your clipboard mangled it.
- API: `POST /api/v1/admin/plesk/sources` · `PATCH …/sources/:id` ·
  `DELETE …/sources/:id` (delete cascades the source's discoveries).

> Password auth uses `sshpass -e` inside the Job with the secret delivered via the
> `SSHPASS` env var (never on the argv). A real Plesk box often forbids password
> SSH for root — prefer a key.

## Discover

Click **Discover** on the source row (`POST …/sources/:id/discover`). A read-only
Job runs in the `plesk-migration` namespace (5-min deadline) and the row polls
every 3 s until `completed`. The inventory then renders inline: per-subscription
domain / mailbox / database counts, mail size, and cron count.

**Only one discovery per source at a time** — a second click while one is
in-flight returns `409`.

### When discovery fails

Discovery **fails visibly** with a classified, operator-facing reason (it does
not silently report an empty inventory). The reason maps the Job log to one of:

| Reason shown | Cause |
|--------------|-------|
| SSH authentication failed — check the key or password | wrong credential, or the user may not log in |
| could not reach the host — check the hostname/IP and SSH port | DNS/route/refused/timeout |
| connected, but this host is not a usable Plesk server | `plesk` CLI / DB unreachable on the box |
| the remote discovery command failed | generic ssh/remote failure |
| discovery job did not complete | timeout / ssh failure with no clearer signal |

On failure the last ~8 KB of Job output is retained (`plesk_discoveries.log_tail`)
for debugging; on success it's stripped (it can contain mailbox names).

## Migrate a subscription

1. **Create + size the tenant first** under **Tenants** (plan + storage). Only
   `provisioned` tenants that aren't suspended/archived/system are selectable.
2. On the subscription row, click **Migrate**, pick the target tenant, confirm.
   API: `POST /api/v1/admin/plesk/migrations` (body: `source_id`,
   `target_tenant_id`, `subscription_name`, optional `discovery_id`).
3. The subscription snapshot is **frozen** into the migration row at create time,
   so the run is deterministic even if you re-discover later.
4. Expand the status badge to watch the legs (polls every 3 s).

### What each leg does

| Leg | Action | Where it runs |
|-----|--------|---------------|
| **preflight** | Validate tenant + capacity check (below) | in platform-api |
| **domains** | Create each Plesk domain as a platform domain; preserve **primary** DNS mode if Plesk was authoritative | in platform-api |
| **email** | Enable email on mail-hosting domains | in platform-api |
| **databases** | Ensure the tenant MariaDB, create the DBs, stream the dumps | `migration-tools` Job in the **tenant** namespace (30-min deadline) |
| **content** | Ensure the web deployment (apache-php / static-apache), rsync each docroot, route the domain | `migration-tools` Job in the **tenant** namespace (60-min deadline) |
| **mail** | Create each Stalwart mailbox, import via IMAP (master-user proxy, multi-worker MULTIAPPEND) | `mail-backup-tools` Job in the **mail** namespace (120-min deadline) |
| **cron** | Import crontab lines: webcrons → enabled cron jobs; shell crons → **disabled** deployment cron jobs (for review); `@reboot` skipped; `@`-macros mapped to numeric | in platform-api |

All Jobs run non-root (uid 65534), read-only rootfs, all caps dropped; their
per-run Secret is deleted in a `finally` (with a TTL backstop) and labelled
`backup-coverage: excluded:transient-migration-job` so it's never backed up.

## Capacity preflight

Preflight runs **before any platform resource is created** and fails the whole
migration (no downstream legs) if the tenant is too small:

- **Mailboxes:** counts only **net-new** mailboxes (those not already on the
  tenant) against `plan.mailboxLimit`. This is what makes Retry safe — already-
  created mailboxes don't re-consume the quota.
- **Storage:** estimates `mailBytes + databaseBytes` (best-effort; vhost content
  and already-used bytes are excluded) against
  `(storageLimitOverride ?? plan.storageLimit)` in **binary GiB**.

If it fails, the leg detail tells you the numbers. Resize the tenant's plan (or
set a per-tenant storage override), then **Retry**.

## Retry

`POST /api/v1/admin/plesk/migrations/:id/retry` re-runs from the failed/partial
state. It atomically claims the migration (flips only a terminal
`failed`/`partial`/`completed` row back to `pending`), so a double-click can't
spawn two concurrent runs (`409` while in-flight). A `(source_id,
subscription_name)` unique index over in-flight rows enforces the same at create.

## Verification (prove it end-to-end)

A migration is done only when **`status == "completed"`** (never accept
`partial`). Then check the user-visible outcomes:

```bash
# Website serves (per migrated domain)
curl -sk -o /dev/null -w '%{http_code}\n' https://<migrated-domain>/

# Database present in the tenant MariaDB (from the tenant SQL manager or a psql/mysql client)
#   → the Plesk DBs appear with their tables/rows.

# Mail imported WITH unread state preserved (IMAP)
#   log in as the migrated mailbox; unseen counts match the source.

# Cron jobs present (webcron enabled; shell crons disabled pending review)
#   Tenant panel → Cron, or GET /api/v1/.../cron-jobs
```

## Troubleshooting

- **A leg's Job never produced a log / stuck Pending.** Tenant PVCs are
  `ReadWriteOnce` — the DB/content Jobs are pinned to the web deployment's node
  (`nodeName`). If that resolution failed you'll see a Multi-Attach error. Also
  check `kubectl get rs -n <tenant-ns>` for a quota `ReplicaFailure` and confirm
  the migration image actually pulled.
- **`CREATE DATABASE` failed right after the MariaDB came up.** First-boot init
  has a ~10–50 s window after the pod is Ready; the DB leg retries (10×5 s). A
  single transient failure in the log is expected; a persistent one is real.
- **Content rsync "failed" but files are there.** rsync exit codes **23/24**
  (partial transfer / vanished source files) are treated as **success** — a
  busy live docroot legitimately changes mid-sync.
- **Unread mail came across as read.** Fixed: the mail leg consolidates the
  Plesk `new/` maildir into `cur/` with the right flags so unseen state is
  preserved. If you still see drift, re-verify over IMAP, not the webmail cache.
- **Website docroot overflowed its PVC (ENOSPC / rsync exit 11).** The tenant
  PVC is sized to the real docroot at provisioning; if you mapped onto an
  under-sized tenant, grow the plan/override and Retry.
- **A migration/discovery is stuck `running` after a platform-api restart.**
  Boot-time sweeps fail stale discoveries (>10 min) and migrations (>30 min) so
  the row becomes Retryable — no manual cleanup needed.
- **Discovery runs in whichever pod took the POST.** Mid-rollout, the async work
  may execute on an old-image pod — verify all platform-api pods are on the new
  image before trusting a discovery result during an upgrade.

## Schema reference

| Table | Holds |
|-------|-------|
| `plesk_sources` | hostname, ssh_port/user, `auth_method` (`key`/`password`), encrypted credential, plesk_version, status |
| `plesk_discoveries` | per-run status, `inventory` (jsonb), `error`, `log_tail` (failure only) |
| `plesk_migrations` | frozen `subscription_snapshot`, `target_tenant_id`, `status`, per-leg `legs` (jsonb), `error` |

Migrations: `0061` (sources + discoveries), `0062` (migrations), `0063`
(tenant-first mapping — nullable plan), `0065` (password auth).

## Where things live

- Backend module: `backend/src/modules/plesk-migration/` (`routes.ts`,
  `service.ts`, `ssh-auth.ts`, `discovery.ts`, `provision.ts`, `*-sync.ts`).
- Contracts: `packages/api-contracts/src/plesk-migration.ts`.
- Admin UI: `frontend/admin-panel/src/pages/platform/PleskMigrationPage.tsx`
  (+ `hooks/use-plesk-migration.ts`).
- Tool images: `migration-tools`, `mail-backup-tools` (GHCR).
