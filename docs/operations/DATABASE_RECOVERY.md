# Database Recovery — Tenant Add-on Databases in Backup Bundles

> Audience: the operator recovering (or reasoning about the recoverability of) a
> tenant's add-on database — MariaDB/MySQL, PostgreSQL, MongoDB, or SQLite — from
> a tenant backup bundle.
>
> **Public-repo rule:** never paste live hostnames, mailbox addresses, IPs, node
> names, or secrets here. Redact to `example.test` / `<apex>` and RFC-5737 IPs.

This runbook explains the **two-layer** guarantee that every add-on database in a
tenant bundle carries, how to read the per-database dump summary, and the exact
recovery mechanism and operator action for each failure scenario.

---

## 1. Concept — the two layers

A tenant backup bundle captures each add-on database **two independent ways**.
The layers are stacked, not alternatives: the second sits on top of the first.

### Layer 1 — Raw-files floor (ALWAYS present)

The `files` component `restic`-snapshots the whole tenant PVC. That PVC includes
each database engine's **on-disk data directory** (`databases/<engine>-<suffix>/`
per ADR-048). So the raw bytes of every database are in every bundle,
unconditionally.

Every engine crash-recovers from that snapshot to a **committed-consistent**
state on next start:

| Engine | Crash-recovery mechanism |
|--------|--------------------------|
| MariaDB / MySQL | InnoDB redo log replay |
| PostgreSQL | WAL replay |
| MongoDB | WiredTiger journal replay |
| SQLite | WAL / rollback-journal replay |

**A bundle is therefore NEVER without a recoverable copy of a database.** This
floor is the load-bearing guarantee. It is restored via the `files-paths` restore
item (see §4) and works for every engine, including plain SQLite files.

### Layer 2 — Logical dump (best-effort, on top)

On top of the floor, capture also takes a **per-database logical dump** so a
database can be restored **portably** — cross-version, cross-engine-config, or
into a differently-shaped target. Each dump lands on the tenant PVC (and is
therefore also captured by the same files snapshot):

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
**live** database. The database still has its raw-files floor; only the portable
dump is absent for that run.

### The critical invariant — dumps are a SEPARATE dimension from bundle status

The per-database dump outcome is recorded in the bundle's `database_dumps`
summary (contract type `BackupDatabaseDumps` in
`packages/api-contracts/src/tenant-bundles.ts`, DB column
`backup_jobs.database_dumps`). It is **independent of the bundle's own
`status`**:

- A **`completed`** bundle can carry a **`degraded`** `database_dumps` summary and
  remains **fully restorable** via the raw-files floor.
- A degraded or failed logical dump **NEVER** flips the bundle to `partial` and
  **NEVER** blocks restore.

This is "loud but non-blocking": the operator *sees* the logical-layer gap in the
summary, but the recoverability guarantee (the floor) is untouched. Treat a
`partial` bundle `status` as a failed backup as always — but do **not** treat a
`degraded` `database_dumps` as one.

Per-database status values:

| `database_dumps` per-db status | Meaning |
|--------------------------------|---------|
| `dumped` | Fresh logical dump captured. |
| `degraded` | Dump skipped for a **benign** reason (dump tool absent in a bring-your-own image, PVC too full per the guard, engine unsupported for logical dump). Floor still covers it. |
| `failed` | The dump command errored **unexpectedly**. Floor still covers it. |

Bundle-level `database_dumps.status` rolls these up to `ok` / `degraded` / `none`
(`none` = the tenant has no add-on databases), plus a `remediation` string when
`degraded`.

---

## 2. Failure / recovery matrix

For every common database failure scenario: what the bundle actually holds, the
recovery mechanism, and the operator action. In **all** rows the raw-files floor
guarantees a recoverable copy.

| Scenario | What happens in a bundle | Recovery mechanism | Operator action |
|----------|--------------------------|--------------------|-----------------|
| **DB pod crash / OOM** (engine dies mid-write, before/at capture) | Files snapshot captures the on-disk datadir at a crash point; the logical dump for that DB may be `failed` or absent | Engine crash-recovery (InnoDB redo / WAL / WiredTiger journal) replays to committed-consistent on next start; raw-files floor restores that datadir | Restore the DB directory via the `files-paths` restore item; let the engine crash-recover on start. No special action for the `failed`/absent logical dump — the floor is authoritative. |
| **PVC full at capture** (>= 90% full or < 200 MiB free) | Logical dump **skipped** (not written) — per-db `degraded`, error names the fill %; floor snapshot still taken | Raw-files floor (crash-consistent datadir) | Grow the tenant volume or free space, then **re-run the bundle** to get a fresh logical dump. Restore meanwhile still works from the floor. |
| **Dump tool missing** (bring-your-own image without `mysqldump`/`mongodump`) | Per-db `degraded`; error = "\<tool\> is not available in this container"; floor snapshot taken | Raw-files floor | Add the client binary to the BYO image if portable dumps are wanted, **or** accept floor-only recovery. Restore is unaffected — it uses `files-paths`. |
| **MongoDB backup** (now covered — was silently unsupported) | `mongodump --archive --gzip` → `predump-<db>-<bundleId>.archive.gz` on the PVC; plus the WiredTiger datadir in the floor | Logical: `mongorestore --archive --gzip --drop` (recreates namespaces — target db need not exist). Floor: files restore of the WiredTiger datadir | Use the `databases-by-id` restore item for a clean logical re-import, or `files-paths` for a raw datadir restore. |
| **Cross-version DB restore** (restore into a newer/older or differently-configured engine) | Logical dump `dumped` on the PVC | Logical re-import via `databases-by-id` (`importSqlFromPvcFile` for SQL, `mongorestore` for Mongo) — portable across versions/engine config | Restore with `databases-by-id` (portable), **not** `files-paths` — a raw datadir is version/config-specific and may not attach to a different engine build. |
| **DB dropped / corrupted** (accidental `DROP DATABASE`, logical corruption on the LIVE db) | Both layers present in the last good bundle | Logical re-import replays the dump into the running pod (SQL import, or `mongorestore --drop`); or floor restore of the datadir | Prefer `databases-by-id` (re-imports into the live pod without touching other DBs). If the whole datadir is corrupt, use `files-paths`. |
| **Root-password recovery** (DB root creds lost) | Root passwords live in `deployments.configuration`, captured by the **`config`** component (not in the datadir/dump) | `config` component restore re-creates the deployment row; the password is injected as literal pod env | Restore the tenant `config`; the DB pod comes back with its original root password. **Caveat:** the reconcile redeploy path does **not** re-arm the password-reset init container — a same-bundle restore is coherent, but mixing/rotating creds between restore steps can mismatch (see §5). |
| **Tenant fully deleted** (row gone, namespace gone) | Bundle survives until its own retention sweep; carries `config` + `files` (floor + dumps) + `meta.json` v2 tenant block | DR re-create from the offsite bundle re-provisions the namespace + empty PVC, then restore-cart overlays files (floor) and re-imports dumps | Follow `DR_DRILL_TENANTS.md` (re-create → provision → restore-cart with `files-paths` + `databases-by-id` + `config-tables`). Assert restore `status == completed`. |

---

## 3. Remediation table — degraded / failed dumps

Keyed off the bundle's `database_dumps.status` and the per-database `error`
string. In **every** row the raw-files floor still covers the database — these
fixes only restore the **logical** (portable) layer.

| Symptom (`database_dumps`) | Cause | Fix |
|----------------------------|-------|-----|
| `status: degraded`; per-db `error` contains "PVC NN% full — logical dump skipped" | DB pod's data volume was **>= 90% full** or had **< 200 MiB free** at capture; the free-space guard refused to write the dump to protect the live DB | Grow the tenant volume (or delete stale data), then re-run the bundle. Recovery meanwhile works from the floor. |
| `status: degraded`; per-db `error` = "mysqldump / mongodump is not available in this container" | Bring-your-own DB image ships no dump client | Add the client to the image if you want portable dumps; otherwise this is expected and benign — restore uses `files-paths`. |
| `status: degraded`; per-db `status: degraded`, engine unsupported | Engine has no logical dumper wired up | Expected/benign. Use the raw-files floor (`files-paths`) for that engine. |
| `status: degraded`; per-db `status: failed`; `error` is an unexpected engine message (e.g. `mysqldump: Got error … during …`) | The dump command errored unexpectedly (engine mid-failure, permissions, transient I/O) | Check the DB pod health/logs; fix the underlying DB issue; re-run the bundle. The floor still covers the DB in the meantime. |
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

- **`status: ok`** — every discovered database has a fresh logical dump. Both
  layers are available for every DB.
- **`status: degraded`** — at least one database's logical dump is `degraded` or
  `failed`; read `remediation` and the per-db `error` strings, then §3. **The
  bundle is still fully restorable** via the floor — do not treat this as a failed
  backup.
- **`status: none`** — the tenant has no add-on databases.
- Per-database `status` (`dumped` / `degraded` / `failed`) plus `error` tells you
  which specific DB lost its portable dump and why.

> Reminder: `databaseDumps` is orthogonal to the bundle's own `status`. A
> `completed` bundle with `databaseDumps.status == "degraded"` is normal and
> restorable.

### Restore mechanics (reference)

- **`databases-by-id`** restore item re-imports the **logical** dumps back into the
  running DB pods: SQL via `importSqlFromPvcFile`, MongoDB `.archive.gz` via
  `mongorestore --archive --gzip --drop` (recreates namespaces, so the target db
  need not pre-exist). If a DB pod is not running or no dump exists, it **skips
  gracefully** — not a failure.
- **`files-paths`** restore item restores the **raw DB directory** (the floor) —
  works for every engine, including SQLite files. Use this when there is no
  logical dump, or for a full datadir re-hydrate.
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
