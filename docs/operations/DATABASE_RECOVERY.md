# Database Recovery — Tenant Add-on Databases in Backup Bundles

> Audience: the operator recovering (or reasoning about the recoverability of) a
> tenant's add-on database — MariaDB/MySQL, PostgreSQL, MongoDB, or SQLite — from
> a tenant backup bundle.
>
> **Public-repo rule:** never paste live hostnames, mailbox addresses, IPs, node
> names, or secrets here. Redact to `example.test` / `<apex>` and RFC-5737 IPs.

This runbook explains the two ways a tenant bundle captures each add-on database
— and why only one of them is a backup — how to read the per-database dump
summary and status, and the recovery mechanism and operator action for each
failure scenario.

---

## 1. Concept — the two layers

A tenant backup bundle captures each add-on database **two ways**. Only the
logical dump is a backup; the raw files are a last resort.

### The raw data files — a last resort, not a guarantee

The `files` component runs `restic backup` over the whole tenant PVC, mounted
read-only while everything on it keeps running. That PVC includes each database
engine's **on-disk data directory** (`databases/<engine>-<suffix>/` per ADR-048),
so the raw bytes of every database are in every bundle.

**That copy is NOT crash-consistent.** There is no volume snapshot: restic reads
the files one by one over minutes while the server writes to them, so the copy
is not the image of any single instant. An engine's crash recovery (InnoDB redo,
PostgreSQL WAL, WiredTiger journal, SQLite journal) is built for a crash-time
image, and may or may not bring this copy up. Treat it as a last resort, restored
via the `files-paths` restore item (§4) — never as the database's backup.

### The logical dump — the database's backup

Capture takes a **per-database logical dump**: consistent, and portable
cross-version, cross-engine-config, or into a differently-shaped target. Each
dump lands on the tenant PVC (and is therefore captured by the same files
snapshot):

| Engine | Dump command | Artifact on PVC |
|--------|--------------|-----------------|
| MariaDB / MySQL | `mysqldump` / `mariadb-dump --single-transaction --quick --routines --triggers` | `predump-<db>-<bundleId>.sql` |
| PostgreSQL | `pg_dump` (MVCC-consistent) | `predump-<db>-<bundleId>.sql` |
| MongoDB | `mongodump --archive --gzip` | `predump-<db>-<bundleId>.archive.gz` |
| SQLite | `sqlite3 <file> .dump` (per discovered file) | `.backup-sqlite-dumps/predump-<path>-<bundleId>.sqlite.sql` |

**SQLite is file-based, not a catalog deployment.** It has no live "database pod",
so capture instead **discovers** SQLite files on the PVC via the file-manager pod
(`find` by `.sqlite`/`.db`/`.sqlite3` extension, filtered by the SQLite magic
header), bounded to the first 200 matches, and writes each `.dump` into a
dedicated `/data/.backup-sqlite-dumps/` dir (kept out of the app's own folders;
prior dumps there are pruned each run — older bundles retain their copy inside
their own restic snapshot). `.dump` reads inside a read transaction, so it is
consistent even under concurrent app writes.

The SQL dumps are a **consistent HOT snapshot**: `--single-transaction` takes the
dump inside one InnoDB transaction, so there is **NO table lock and NO
write-downtime** for the live tenant database. `pg_dump` is already MVCC-consistent
and takes no lock. MongoDB coverage is **new** — `mongodump` bundles were silently
unsupported before this feature.

**Free-space guard.** Before writing a logical dump, capture checks the DB pod's
data volume. If it is **>= 90% full** or has **< 200 MiB free**, the logical dump
is **skipped** (nothing is written) so the dump can never `ENOSPC` and crash the
**live** database. That database then has no reliable backup in this bundle.

### The critical invariant — dumps are a SEPARATE dimension from bundle status

The per-database dump outcome is recorded in the bundle's `database_dumps`
summary (contract type `BackupDatabaseDumps` in
`packages/api-contracts/src/tenant-bundles.ts`, DB column
`backup_jobs.database_dumps`). It is **independent of the bundle's own
`status`**:

- A **`completed`** bundle can carry a **`degraded`** `database_dumps` summary:
  the bundle's other components are fine, but the degraded databases have **no
  reliable backup in it**.
- A degraded or failed logical dump does not flip the bundle to `partial` and does
  not block restoring the rest of the bundle.

Treat a `partial` bundle `status` as a failed backup as always — and treat a
database whose dump failed as **not backed up** by that bundle.

### Per-database status and the overdue-backup alert

After every bundle, each database's outcome is recorded in
`database_backup_status`: the last attempt (status and error) and the **last good
backup** — a `dumped` entry whose files snapshot completed (the dump lives inside
that snapshot). Rows are removed only when a database is shown to be gone (its
deployment deleted, or a clean listing that no longer names it); a failed listing
removes nothing. When the dump step did not run at all (no Kubernetes API, the
file manager could not start, the pre-dump step threw), every database the tenant
has is stamped `failed` with *the dump did not run: …* — its last good backup is
kept. Deleted and stopped database deployments are not dumped and get no
synthetic failure row. Names are capped at 255 characters (a longer name keeps a
hash suffix so its row stays stable), and a tenant keeps at most 500 rows: the
rest of an instance's databases fold into one *(more databases)* row with the
worst status of the folded ones.

A sweep (every 15 minutes, one replica) judges each database against one
**scheduled run**: the latest firing of the tenant-bundle schedule whose wave has
had time to finish, where *time to finish* is the duration of the last completed
scheduled wave plus one hour (at least two hours), never a run whose wave is
still running, and never a run the scheduler did not fire (the schedule was off,
or was enabled after it). A database is **overdue** when it was known before that run and
has had no good backup since the run started — wherever its tenant fell in the
wave. Only tenants the wave covers and running database instances are judged; a
stopped or removed instance is shown as such and is never overdue. When a tenant
leaves the wave (suspended, archived, schedule disabled) or an instance stops, its
open episode closes silently.

Each overdue database is announced **once per episode**: one admin notification
(*Tenant database backups overdue*) listing every newly overdue database with the
operator diagnosis, and one notification to each affected tenant naming only the
kind of failure (*the platform could not log in to the database*, *the volume was
full*, …), never the error text. A database alerted on in the last 12 hours does
not alert again: a new episode inside that window opens quietly and is announced
when the window has passed — or closes silently if it recovers first. When a
database has a good backup again, both get a *working again* notice — only for
episodes that alerted. Each item is cut at 300 characters.

Where to look:

- Admin panel → tenant → **Storage & backups → Database backups**: every database
  of the tenant, its last good backup, its last attempt and error.
- Admin panel → **Backups → Tenant Backups → Backups**: every overdue database
  across tenants (shown only when there is one).
- Tenant panel → **Backups → Database backups**, and a *Not every database dumped*
  marker on bundles whose `database_dumps` is `degraded`.
- API (cursor-paginated, `limit` ≤ 100): `GET /api/v1/admin/tenants/:tenantId/database-backups`,
  `GET /api/v1/admin/database-backups/overdue`,
  `GET /api/v1/tenant/backups/databases` (the tenant gets `lastErrorKind`/`lastErrorLabel`, not `lastError`).

Per-database status values:

| `database_dumps` per-db status | Meaning |
|--------------------------------|---------|
| `dumped` | Fresh logical dump captured. |
| `degraded` | Dump skipped for an **expected** reason (dump tool absent in a bring-your-own image, PVC too full per the guard, engine unsupported for logical dump). No reliable backup of this database in the bundle. |
| `failed` | The dump command errored **unexpectedly**. No reliable backup of this database in the bundle. |

Bundle-level `database_dumps.status` rolls these up to `ok` / `degraded` / `none`
(`none` = the tenant has no add-on databases), plus a `remediation` string when
`degraded`.

---

## 2. Failure / recovery matrix

For every common database failure scenario: what the bundle actually holds, the
recovery mechanism, and the operator action. Where no dump is available, the raw
data files are a last resort that may not restore (§1).

| Scenario | What happens in a bundle | Recovery mechanism | Operator action |
|----------|--------------------------|--------------------|-----------------|
| **DB pod crash / OOM** (engine dies mid-write, before/at capture) | The logical dump for that DB may be `failed` or absent; the files snapshot holds a live, file-by-file copy of the datadir | Prefer the last bundle whose dump is `dumped` (`databases-by-id`). Otherwise the raw datadir via `files-paths`, which may or may not crash-recover | Restore from the newest bundle with a good dump. Use the raw datadir only when no dump exists, and check the database after it starts. |
| **PVC full at capture** (>= 90% full or < 200 MiB free) | Logical dump **skipped** (not written) — per-db `degraded`, error names the fill %; the database is not backed up by this bundle | The previous bundle's dump; the raw datadir is a last resort | Grow the tenant volume or free space, then **re-run the bundle** to get a fresh logical dump. The overdue alert follows if the next scheduled run does not back it up either. |
| **Dump tool missing** (bring-your-own image without `mysqldump`/`mongodump`) | Per-db `degraded`; error = "\<tool\> is not available in this container"; no logical backup | Raw datadir only — a last resort | Add the client binary to the BYO image. Until then this database has no reliable backup, and it is reported overdue. |
| **MongoDB backup** (now covered — was silently unsupported) | `mongodump --archive --gzip` → `predump-<db>-<bundleId>.archive.gz` on the PVC; plus the live-copied WiredTiger datadir in the files snapshot | Logical: `mongorestore --archive --gzip --drop` (recreates namespaces — target db need not exist). Last resort: files restore of the WiredTiger datadir | Use the `databases-by-id` restore item for a clean logical re-import, or `files-paths` for a raw datadir restore. |
| **Cross-version DB restore** (restore into a newer/older or differently-configured engine) | Logical dump `dumped` on the PVC | Logical re-import via `databases-by-id` (`importSqlFromPvcFile` for SQL, `mongorestore` for Mongo) — portable across versions/engine config | Restore with `databases-by-id` (portable), **not** `files-paths` — a raw datadir is version/config-specific and may not attach to a different engine build. |
| **DB dropped / corrupted** (accidental `DROP DATABASE`, logical corruption on the LIVE db) | Dump and raw files in the last good bundle | Logical re-import replays the dump into the running pod (SQL import, or `mongorestore --drop`); or, as a last resort, the raw datadir | Prefer `databases-by-id` (re-imports into the live pod without touching other DBs). If the whole datadir is corrupt, use `files-paths`. |
| **Root-password recovery** (DB root creds lost) | Root passwords live in `deployments.configuration`, captured by the **`config`** component (not in the datadir/dump) | `config` component restore re-creates the deployment row; the password is injected as literal pod env | Restore the tenant `config`; the DB pod comes back with its original root password. **Caveat:** the reconcile redeploy path does **not** re-arm the password-reset init container — a same-bundle restore is coherent, but mixing/rotating creds between restore steps can mismatch (see §5). |
| **Tenant fully deleted** (row gone, namespace gone) | Bundle survives until its own retention sweep; carries `config` + `files` (raw files + dumps) + `meta.json` v2 tenant block | DR re-create from the offsite bundle re-provisions the namespace + empty PVC, then restore-cart overlays files and re-imports dumps | Follow `DR_DRILL_TENANTS.md` (re-create → provision → restore-cart with `files-paths` + `databases-by-id` + `config-tables`). Assert restore `status == completed`. |

---

## 3. Remediation table — degraded / failed dumps

Keyed off the bundle's `database_dumps.status` and the per-database `error`
string. Until the fix lands, the database has **no reliable backup** in new
bundles (§1), and it is reported overdue after the first scheduled run without a good dump.

| Symptom (`database_dumps`) | Cause | Fix |
|----------------------------|-------|-----|
| `status: degraded`; per-db `error` contains "PVC NN% full — logical dump skipped" | DB pod's data volume was **>= 90% full** or had **< 200 MiB free** at capture; the free-space guard refused to write the dump to protect the live DB | Grow the tenant volume (or delete stale data), then re-run the bundle. Meanwhile the newest bundle with a good dump is the backup. |
| `status: degraded`; per-db `error` = "mysqldump / mongodump is not available in this container" | Bring-your-own DB image ships no dump client | Add the client to the image. Without it this database has no reliable backup — only the live-copied raw files. |
| `status: degraded`; per-db `status: degraded`, engine unsupported | Engine has no logical dumper wired up | Expected, but this database has no reliable backup — only the live-copied raw files (`files-paths`). |
| `status: degraded`; per-db `status: failed`; `error` is an unexpected engine message (e.g. `mysqldump: Got error … during …`) | The dump command errored unexpectedly (engine mid-failure, permissions, transient I/O) | Check the DB pod health/logs; fix the underlying DB issue (e.g. `mariadb-upgrade` when system tables are out of date); re-run the bundle. |
| `status: none` | Tenant has **no** add-on databases — nothing to dump | No action. |
| `remediation` string set on the summary | Roll-up of one or more of the above | Read `remediation`; apply the matching fix above. |
| Restore-time: a `databases-by-id` database is **skipped** (not failed) | The DB pod is not running, or no matching dump exists for that bundle | Ensure the DB deployment is running, then re-run `databases-by-id`. A skip is **not** a restore failure. |

---

## 4. How to inspect a bundle's database dumps

`GET /api/v1/admin/tenant-bundles/:id` returns the bundle detail, including a
`databaseDumps` field (`null` on bundles captured before this feature existed):

```bash
curl -s -H "Authorization: Bearer $ADMIN_JWT" \
  https://admin.example.test/api/v1/admin/tenant-bundles/$BUNDLE_ID \
  | jq '.data.databaseDumps'
```

Shape (`BackupDatabaseDumps`):

```jsonc
{
  "status": "degraded",              // ok | degraded | none  (rolls up all dbs)
  "remediation": "PVC full on maria-a — grow the volume and re-run the bundle.",
  "deployments": [
    {
      "deploymentId": "…",
      "deploymentName": "maria-a",
      "engine": "mariadb",           // mariadb|mysql|postgresql|mongodb|sqlite|null
      "databases": [
        { "name": "shop", "status": "dumped",   "sizeBytes": 4194304 },
        { "name": "logs", "status": "degraded", "sizeBytes": 0,
          "error": "PVC 93% full — logical dump skipped to avoid …" }
      ]
    }
  ]
}
```

How to read it:

- **`status: ok`** — every discovered database has a fresh logical dump.
- **`status: degraded`** — at least one database's logical dump is `degraded` or
  `failed`; read `remediation` and the per-db `error` strings, then §3. Those
  databases are **not backed up** by this bundle.
- **`status: none`** — the tenant has no add-on databases.
- Per-database `status` (`dumped` / `degraded` / `failed`) plus `error` tells you
  which specific DB lost its portable dump and why.

> Reminder: `databaseDumps` is orthogonal to the bundle's own `status`. A
> `completed` bundle with `databaseDumps.status == "degraded"` restores
> everything else, but not those databases reliably.

### Restore mechanics (reference)

- **`databases-by-id`** restore item re-imports the **logical** dumps back into the
  running DB pods: SQL via `importSqlFromPvcFile`, MongoDB `.archive.gz` via
  `mongorestore --archive --gzip --drop` (recreates namespaces, so the target db
  need not pre-exist). If a DB pod is not running or no dump exists, it **skips
  gracefully** — not a failure.
- **`files-paths`** restore item restores the **raw DB directory** — a live,
  file-by-file copy that may not restore (§1). Use it only when no bundle has a
  good dump of the database, and check the database once it starts.
- **SQLite** has no live pod to import into, so `databases-by-id` does **not**
  auto-restore it. The raw `.sqlite` file is restored by `files-paths` (it
  crash-recovers on open); the captured `.dump` under `/data/.backup-sqlite-dumps/`
  is the portable belt-and-suspenders copy for a **manual SQL Manager import**
  (or cross-version rebuild) when needed.

---

## 5. Root-password caveat (read before a mixed restore)

Root DB passwords are **not** in the datadir or the logical dump — they live in
`deployments.configuration`, captured by the **`config`** component, and are
injected into the pod as literal env at deploy time. Because of that:

- A **same-bundle** restore (config + files + dumps all from one bundle) is
  **coherent** — the pod comes back with the same root password the dump/datadir
  expects.
- A **mixed** restore — e.g. config from one bundle but data from another, or a
  credential rotated between restore steps — leaves the pod env password out of
  sync with the on-disk auth. Restore config and data from the **same** bundle to
  stay coherent.

**The password-reset init container** (`deployments/password-reset.ts`) exists to
absorb exactly that mismatch: it starts the engine with authentication disabled
and re-stamps the password from `deployments.configuration` onto the reused
datadir. It self-skips when the datadir is empty and is best-effort — it logs a
`WARNING` and lets the database start rather than crash-looping the pod. It is
armed on:

- the **create** path, for every database deployment;
- the **DR reconcile** path (`dr-recover/reconcile.ts` passes
  `armPasswordReset: true`).

It is *not* armed on a routine env-var edit or config redeploy, so those still
assume the on-disk password already matches.

---

## 6. Engine admin lockout after a same-name re-create

**Symptom.** SQL Manager cannot read a running database. `platform-api` logs
`[db-manager] Exec failed: … ERROR 1045 (28000): Access denied for user
'root'@'localhost'` on `/databases`, `/databases-with-size` and `/db-users`.
Tenant applications keep working — they use their own DB user, not the admin.

**Cause.** `storagePath` is deterministic (`${entry.type}/${entry.code}/${name}`,
no uniqueness suffix), and `DELETE …/deployments/<id>` **without**
`deleteData=true` leaves the data folder behind. Re-creating a deployment with
the **same name** therefore mounts the previous datadir — and every engine
applies `*_ROOT_PASSWORD` only when it initialises an *empty* one. The newly
generated password is ignored; the on-disk one stays in force. If the old
deployment row was hard-deleted, the original password is gone with it.

**Confirm it in one query.** Compare the datadir's birth time with the row:

```bash
# datadir age (MariaDB/MySQL)
kubectl exec -n <tenant-ns> <db-pod> -c <engine> -- \
  stat -c %y /var/lib/mysql/multi-master.info
# deployment row age
kubectl exec -n platform system-db-1 -c postgres -- \
  psql -U postgres -d platform -c \
  "SELECT name, created_at, storage_path FROM deployments WHERE id = '<id>';"
```

A datadir **older** than `created_at` is this failure. (Deployments created after
the fix in PR #358 arm the reset init container and self-heal on the first roll.)

**Recovery** — re-stamp the configured password onto the existing datadir.
Non-destructive; costs one database restart.

1. **Snapshot first.** Check for platform backups (`SELECT … FROM backups WHERE
   tenant_id = …`); tenants with none still have Longhorn hourly snapshots. Take
   an explicit one:

    ```yaml
    apiVersion: longhorn.io/v1beta2
    kind: Snapshot
    metadata: { name: pre-root-pw-reset-<date>, namespace: longhorn-system }
    spec: { createSnapshot: true, volume: <pvc-volume-name> }
    ```

2. **Scale the deployment to 0** and wait for the pod to go away. Never run the
   reset against a live datadir — the engine holds the lock.
3. **Stage the configured password** as a temporary Secret, read out of the
   existing spec so it never lands in your shell history or a manifest:

    ```bash
    PW=$(kubectl get deploy <name> -n <tenant-ns> -o \
      jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MARIADB_ROOT_PASSWORD")].value}')
    kubectl create secret generic <name>-root-reset-pw -n <tenant-ns> --from-literal=password="$PW"
    ```

4. **Run a one-shot Job** on the same PVC + `subPath`, using the same image and
   the same buffer-tuning args as the main container, with
   `--skip-grant-tables`, then
   `FLUSH PRIVILEGES; CREATE USER IF NOT EXISTS 'root'@'localhost'; ALTER USER
   'root'@'localhost' IDENTIFIED BY '<pw>'; GRANT ALL PRIVILEGES ON *.* TO
   'root'@'localhost' WITH GRANT OPTION; ALTER USER IF EXISTS 'root'@'%'
   IDENTIFIED BY '<pw>';` — then verify **with the new password** before
   shutting the temporary server down. The `IF EXISTS` / `IF NOT EXISTS` guards
   matter: a datadir missing either account otherwise aborts the whole reset.

    !!! warning "Size the Job inside the tenant's ResourceQuota"
        Tenant namespaces cap `limits.memory`. With the database scaled to 0 the
        headroom is the quota minus whatever else is running — request **the same
        memory as the database container**, not more. A Job that exceeds it never
        creates a pod and the Job just sits at `0/1`; `kubectl describe job` shows
        `FailedCreate … exceeded quota`.

5. **Delete the Job and the Secret, scale back to 1**, then verify through the
   platform's own path:

    ```bash
    kubectl exec -n <tenant-ns> <db-pod> -c <engine> -- \
      sh -c 'mariadb -uroot -p$MARIADB_ROOT_PASSWORD -e "SHOW DATABASES;"'
    ```

    Then confirm at the API layer — SQL Manager requests for that deployment
    should return `200`, and the engine log should stop recording `Access denied`.

**Prevention.** Delete the data along with the deployment when you want a clean
start (`?force=true&deleteData=true`), or keep the existing deployment rather
than re-creating it under the same name.

---

## Related docs

- ADR-048 — Tenant Backup v2, **Primitive 3 (database pre-dumps)**:
  `docs/architecture/adr/ADR-048-tenant-backup-restic-jmap.md`
- ADR-028 — backup architecture:
  `docs/architecture/adr/ADR-028-backup-architecture.md`
- ADR-032 — BackupStore interface + bundle orchestration:
  `docs/architecture/adr/ADR-032-backupstore-interface-and-bundle-orchestration.md`
- Backup component model (the `files`/`config` components, no new component):
  `docs/architecture/BACKUP_COMPONENT_MODEL.md`
- Tenant backup operator runbook: `docs/operations/TENANT_BACKUP.md`
- Tenant-bundle DR (deleted/whole-cluster recovery): `docs/operations/DR_DRILL_TENANTS.md`
</content>
</invoke>
