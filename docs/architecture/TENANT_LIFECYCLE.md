# Tenant Lifecycle (status-driven)

> Operator runbook. As of 2026-04-28 the tenant lifecycle is driven
> directly from the client row — status dropdown, resource limits,
> archive retention. The standalone Suspend / Resume / Archive /
> Restore / Resize buttons in the Storage Lifecycle card are gone;
> the underlying endpoints stay for scripting + tests.

## Mental model

| Operator intent           | UI surface                                                     | Backend dispatch                                            |
| ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Bump storage (online)     | ResourceLimits → Storage Limit ↑                               | PATCH /tenants/:id { storage_limit_override } → online grow |
| Shrink storage            | ResourceLimits → Storage Limit ↓ → confirm destructive dialog | POST /admin/tenants/:id/storage/resize { newGi }            |
| Suspend                   | Status dropdown → suspended                                    | PATCH /tenants/:id { status: 'suspended' }                  |
| Resume                    | Status dropdown → active                                       | PATCH /tenants/:id { status: 'active' }                     |
| Archive (suspended only)  | Actions → Archive… (days, or Never expire)                     | PATCH /tenants/:id { status: 'archived', archive_retention_days \| archive_never_expires } |
| Restore from archive      | Archived tenant page → Restore archived tenant… (node, size)   | POST /admin/tenants/:id/storage/restore { nodeName?, newGi? } (PATCH status 'suspended'/'active' too) |
| Manual snapshot           | Storage / Snapshots → "Take snapshot"                          | POST /tenants/:id/snapshots (on-server Longhorn CSI)        |
| Reset stuck failed state  | Storage Operations → "Reset to idle" (visible only on failed)  | POST /admin/tenants/:id/storage/clear-failed                |
| Hard delete               | Top-bar → Delete                                               | DELETE /tenants/:id                                         |

The status dropdown is the single switch the operator flips. Anything
that needs a backing snapshot (archive / restore / destructive shrink)
runs in the storage-lifecycle orchestrator and surfaces an
`storage_operations` row id on the response so the UI can poll
`/admin/storage/operations/:opId` and show progress live.

## Asymmetric semantics

The flows are intentionally *not* symmetric:

| Direction         | Class         | Reversibility                                                 |
| ----------------- | ------------- | ------------------------------------------------------------- |
| Grow              | Online        | Reversible only via destructive shrink                        |
| Shrink            | Destructive   | Pre-resize snapshot kept (default 7d). Restore via /storage/restore |
| Suspend           | Reversible    | Workloads scaled to 0; resume restores prior replica counts   |
| Resume            | Reversible    | unquiesce reads QuiesceSnapshot from the suspend op row       |
| Archive           | Destructive   | Suspended tenants only. Final full bundle kept off-site (default 90d, or no end date); then almost a delete — see *Archive and restore* |
| Restore (archived → suspended) | Destructive | Everything back from the bundle, suspended until reactivated; mailboxes need new passwords |
| Hard delete       | Irreversible  | Drops namespace, snapshots, DB rows                           |

## Endpoint catalogue

These endpoints stay in the API regardless of the UI collapse — they
are still called by:
1. The status-driven row-edit dispatcher in `clients/service.ts`
2. Operator scripts (`scripts/integration-*.sh`, prod runbooks)
3. Future automated reconcilers

| Endpoint                                            | Trigger from row-edit                            |
| --------------------------------------------------- | ------------------------------------------------ |
| POST /admin/tenants/:id/storage/resize/dry-run     | (none — used by ResizeStorageModal directly)     |
| POST /admin/tenants/:id/storage/resize             | ResourceLimits shrink confirm                    |
| POST /admin/tenants/:id/storage/suspend            | (script-only; status flip uses cascade path)     |
| POST /admin/tenants/:id/storage/resume             | (script-only; status flip uses cascade path)     |
| POST /admin/tenants/:id/storage/archive            | PATCH /tenants status:archived (`retentionDays`, `neverExpires`) |
| GET  /admin/tenants/:id/archive                    | The archived tenant page + restore dialog: bundle, size, expiry, restorable, files size, storage size, target, nodes, subscription end |
| POST /admin/tenants/:id/storage/restore            | The restore dialog (`nodeName`, `newGi`); PATCH /tenants status:suspended or active (when archived) |
| POST /admin/tenants/:id/storage/clear-failed       | Storage Operations "Reset to idle" (failed only) |
| GET  /admin/storage/operations/:opId               | OperationProgressModal poll                      |

> **Manual snapshots moved off `/storage/*` (2026-06-16, #118).** The legacy tar
> `POST /admin/tenants/:id/storage/snapshot` + `…/storage/rollback` endpoints were
> removed. Tenant PVC snapshots are now on-server Longhorn CSI snapshots via
> `POST/GET/DELETE /tenants/:id/snapshots` (the `tenant-snapshots` module); the
> `GET /admin/tenants/:id/storage/snapshots` list + `DELETE
> /admin/storage/snapshots/:id` routes remain for the restic `bundle:` rows
> (pre-resize / pre-archive) still recorded in `storage_snapshots`.

## Archive and restore

**Archive** takes a **suspended** tenant only (409 `TENANT_NOT_SUSPENDED`
otherwise) and needs a tenant backup target (409 `NO_BACKUP_TARGET`).

1. The final bundle: a full tenant bundle (`system_trigger = pre_archive`) —
   files (the databases' data with them), mailboxes with their mail,
   configuration, TLS secrets — to the tenant backup target. The suspension's
   mail-login block is lifted for the capture only (inbound mail stays
   refused). Anything short of `completed` stops the archive with nothing
   removed (`SNAPSHOT_INCOMPLETE`).
2. Teardown, almost a delete: Deployments, CronJobs, Services, the PVC **and
   its volume** (the Released PV and the Longhorn volume — `longhorn-tenant`
   keeps a volume whose claim is deleted, so it used to be left orphaned);
   the mail domains, DKIM keys, mail accounts and alias lists on the mail
   server; the DNS zones on the DNS servers. The `domains`, `dns_records`,
   `mailboxes`, `email_aliases` and `deployments` rows stay: restore rebuilds
   from them. The namespace stays.
3. Sign-in closes everywhere: password, passkey, OIDC, admin "Login as
   tenant", SFTP, and sessions already open (refresh tokens revoked; every
   tenant-panel request checks the tenant, 403 `TENANT_ARCHIVED`). Each API
   replica caches the answer for 10 seconds, so an open session ends within
   seconds, not on the instant — and a restored tenant's users may meet
   `TENANT_ARCHIVED` for as long.
4. The tenant's notice (`tenant.archived`, honours "Notify tenant") says
   sign-in is closed and how long the backup is kept.

The archive's expiry is the bundle's. **When it expires the tenant is
deleted** (the snapshot-expiry sweep, `tenant-archive/expiry.ts`) — only by
the expiry of its newest archive, and never while a restore owns it: the
bundle of an archive the tenant was restored from expires as any bundle, even
when the tenant was archived again since. An archive kept with no end date is
never deleted automatically, and the automation card's delete step skips it. New bundles of an archived tenant are refused
(409 `TENANT_ARCHIVED`), so the archive bundle stays its newest; its older
bundles expire as usual. Backups → Tenants keeps the tenant, marked Archived.

**Restore** first checks, before anything changes, the node it runs on
(`tenant-archive/restore-placement.ts`: the pin, another node, or Auto — never
one that is gone, down, not hosting tenants, cordoned, server-only, or
pinned-only for an HA tenant; the choice is written as the pin) and the size
(never below the archive's files; a larger one becomes the tenant's override,
and the namespace's storage quota is raised to it). It then brings back, in
order: a fresh volume, with the HA tier's second copy, holding the bundle's
files — read from the target the bundle was written to, through a read-only
source shim when that is not the bound tenant target
(`backup-source-shim/`); the DNS zones and their records (SOA and apex NS come with
the zone; a rebuilt mail domain's MX, SPF, DKIM, DMARC, SRV and webmail
records are left out, its rebuild writes them afresh); each mail domain (a
new DKIM key, published); each mailbox, its mail imported from the bundle
(a restore job of the tenant, in the restore history); the account of every
mailbox the bundle does not hold, from its row — the platform's `postmaster@`
intake, which `dmarc@` is an alias of, is never captured; every application
deployed again at 0 replicas with its CronJobs paused; a `suspend` operation
holding what Reactivate scales back to (the counts the suspension before the
archive wrote down, 0 included, else what a deploy runs); the ingress routes,
rebuilt while the tenant still reads archived and with its domains active (a
route's certificate is looked up only for an active domain); then the `suspended` hooks with
`restoredFromArchive` on the transition (`applySuspendedFromArchive`): status
suspended with a fresh `suspendedAt` and `archivedAt` cleared, sites on the
suspended page, mail shut — and the tenant told its account was restored
(`tenant.restored`), not that it was suspended. Mailboxes get new random passwords — the
mail server never returns a stored one, so no archive can hold it — and the
restore notice tells the tenant to set new ones. An archive taken before
archives were whole (`pre_resize`, files only) restores the files only, as it
always did. A resumed restore repeats no step's effect: zones and records are
written idempotently, rebuilt mail domains are skipped, and the mail import
skips messages it already has.

While an archive runs, the 15-minute mail-rules sweep leaves the tenant's
mailboxes alone (their logins are open for the capture). A failed archive
hook is not retried once the tenant has been restored — it would tear the
restored tenant down again — and the 6-hourly sweep that removes an archived
tenant's leftover volume skips a tenant a restore owns, and never touches a
volume whose PV is still bound.

## Status transitions and the orchestrators

```
                                   (status dropdown)
                                          │
            ┌─────────────────────────────┼──────────────────────────────┐
            │                             │                              │
            ▼                             ▼                              ▼
    status: suspended             status: active                  status: archived
       │                            │  │                              │
       │ applySuspended (sync)      │  │ applyActive (sync)           │ archiveTenant (suspended only)
       │ (cascades.ts)              │  │ (cascades.ts)                │ (storage-lifecycle/service.ts)
       ▼                            │  │                              │   ├─ final full bundle (pre_archive)
   ingress patched                  │  │                              │   ├─ delete workloads, PVC, volume
   workloads scaled to 0            │  │                              │   ├─ applyArchived (mail, DNS, status)
   mailboxes disabled               │  │                              │   └─ end the tenant's sessions
                                    │  │                              ▼
                                    │  │                         status: archived
                                    │  │                         storage_operations row written
                                    │  │
              from archived ────────┘  └──── from suspended
                     │                           │
                     ▼                           ▼
              restoreArchivedTenant           applyActive (sync)
              (storage-lifecycle/service.ts)  (cascades.ts)
                ├─ fresh PVC + files          ingress restored
                ├─ DNS zones, mail, mailboxes workloads scaled back
                ├─ applyRestored (status)     mailboxes re-enabled
                └─ redeploy applications
              storage_operations row written
```

### Synchronous cascade vs orchestrator

Suspend / resume run inline as part of the PATCH request. They
complete before the API returns and don't write `storage_operations`
rows when triggered via the row-edit path; the response is just the
updated client. (The standalone POST /storage/suspend and
/storage/resume endpoints DO write op rows — that path is unchanged
for scripting.)

Archive / restore-from-archive return immediately with an op id and
run in the background. The PATCH response carries
`storageArchiveOperationId` or `storageRestoreOperationId`; the UI
opens OperationProgressModal which polls
`/admin/storage/operations/:opId` every 1.5s.

## Idempotence rules

* PATCH status:archived on already-archived client → no-op (no
  orchestrator dispatched, no error).
* PATCH status:active on already-active client → no-op (cascade is
  idempotent: re-runs ingress/mail re-enable).
* PATCH archive_retention_days without status:archived → ignored.
* PATCH storage_limit_override === current → no-op (not a grow).

## Failure modes

| Failure                                | Where to look                                              |
| -------------------------------------- | ---------------------------------------------------------- |
| Archive: final bundle not complete     | storage_operations.lastError (`SNAPSHOT_INCOMPLETE`); the bundle's components under Backups → Tenants |
| Archive: mail server unreachable       | `MAIL_SERVER_UNREACHABLE` — nothing removed; retry        |
| Restore: archive bundle expired        | the tenant was deleted with it (no restore)               |
| Restore: a step failed (DNS, mail, an application) | the operation's closing message lists them; the restore went on |
| Shrink: destructive resize stuck       | Storage Operations card → Reset to idle (clear-failed)     |
| Suspend cascade race                   | backend logs "[clients] Lifecycle cascade failed"          |

## Migration note

Pre-collapse code paths still exist and are tested:
* `useStorageSuspend / useStorageResume / useStorageArchive /
  useStorageRestore` hooks remain in `use-storage-lifecycle.ts` for
  any future tooling, but ClientDetail.tsx no longer imports them.
* The /storage/suspend, /storage/resume, /storage/archive,
  /storage/restore, /storage/resize endpoints stay for operator
  scripts and integration tests.

When operator scripts run those endpoints directly they bypass the
status dropdown, so their `storage_operations` rows still appear in
the Storage Operations card progress strip — the card now displays
ANY active op, not just ones started from inside the card.
