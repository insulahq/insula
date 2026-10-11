# Reclaiming disk space after bulk mail deletion

> Companion runbook to [ADR-046](../architecture/adr/ADR-046-stalwart-blob-store-stays-rocksdb.md).
> Applies to Stalwart's Default (RocksDB) blob store.

## The behavior

Deleting mail does **not** promptly free disk, and the reason is not the one this
runbook originally gave. Stalwart blob storage is **reference-counted**: a message
blob survives until *every* reference to it is gone. The reference types (per
upstream, [discussion #2956](https://github.com/stalwartlabs/stalwart/discussions/2956)):

| reference | released when |
|---|---|
| hard links (email / file / Sieve script) | the object is deleted |
| temporary queue links | delivery completes |
| temporary upload links | JMAP upload expiry (1 h default) |
| **spam-classifier training samples** | **`SpamClassifier.holdSamplesFor`** |
| undelete links | the undelete hold period |

**The dominant one is spam training samples.** They pin the blob through a
`BlobLink::Temporary { until }` stamped *at ingest* as `now + holdSamplesFor`
(counted from the preceding midnight before v0.16.26) — **180 days** on an
upstream-default install. Destroying the account does **not**
release them: Stalwart's `destroy_account_blobs` unlinks only `Email` / `FileNode`
/ `SieveScript` hard links. The bytes stay on the mail PVC, invisibly — the mailbox
is gone and the account quota reads 0 B.

Once the last reference goes, the rest is automatic:

1. **Blob purge** (`purgeBlob`, daily 04:00 by default) deletes the blob key — and,
   for an expired temporary link, the `SpamTrainingSample` row with it.
2. **Blob garbage collection** turns those deletes into reclaimed bytes — in
   batches. From Stalwart **v0.16.26** the store compares, at every scheduled
   data-store purge (`purgeData`), how much of its blob data is dead; once that is
   **at least 256 MiB and at least 25 %** of the blob data it rewrites the blob
   files without the dead part. Below either mark nothing is rewritten and the dead
   bytes stay on disk — up to the larger of 256 MiB and a quarter of the blob data
   (see [below](#the-cost-of-blob-gc-periodic-full-rewrites)). RocksDB only
   counts a deleted blob as dead once a compaction has processed the delete, which
   on a server with mail traffic happens about every 128 MiB of new mail; an idle
   server waits for the column family's 30-day TTL.

### Measured (v0.16.16, 2026-08-04)

2 GiB corpus (4000 × 512 KiB), deleted via IMAP EXPUNGE:

| step | blob files | blob KB |
|---|---|---|
| after ingest | 9 | 2,030,872 |
| EXPUNGE, then forced `purgeAccounts` / `purgeData` / `purgeBlob`×256 | 11 | 2,132,388 |
| **account destroyed outright** | 11 | 2,132,388 |
| purge at +1 h 40 m (past the upload TTL) | 12 | 2,142,844 |
| **training samples destroyed → purge → compaction** | **1** | **11,156** |

With samples present the purge reports `expires 0 / total 4221`; after destroying
them, `expires 4200 / total 21`.

## What the platform does automatically

- **On mailbox/domain/tenant deletion**, `destroyStalwartArtifactsForEmailDomain`
  purges each mailbox principal's training samples **before** destroying the
  principal (`backend/src/modules/mail-admin/spam-sample-cleanup.ts`). The space
  becomes reclaimable at once instead of after six months, and returns at the next
  garbage collection — once the dead share passes the thresholds above. Failures are non-fatal
  and logged — the `holdSamplesFor` timer remains the backstop.
- **`holdSamplesFor` is set to 30 d** by `bootstrap.sh configure_stalwart_full()`
  (upstream default 180 d), bounding drift for every path the hook does not cover:
  user-deleted mail in live accounts, failed hooks, orphaned principals.

**Existing clusters** are converged automatically by host-migration
`2026.8.3/0001-stalwart-spam-sample-retention` on the next daily
`platform-ops host-config apply` — `bootstrap.sh` reaches fresh installs only.
The migration reads the current value first and moves **only** the upstream
180 d default, so an install you tuned on purpose keeps its setting.

To apply it by hand instead (it is stamped at ingest, so it only affects mail
received afterwards):

```bash
kubectl -n mail exec deploy/stalwart-mail -- curl -s \
  -u "admin:$STALWART_ADMIN_PASSWORD" -H 'Content-Type: application/json' \
  -X POST http://127.0.0.1:8080/jmap -d '{
    "using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
    "methodCalls":[["x:SpamClassifier/set",
      {"accountId":"d333333","update":{"singleton":{"holdSamplesFor":2592000000}}},"s"]]}'
```

`holdSamplesFor` is in **milliseconds** (30 d = `2592000000`).

## The cost of blob GC: periodic full rewrites

Reclaiming deleted mail means rewriting blob files, and Stalwart rewrites **all** of
them when it does (`blob_gc_age_cutoff = 1.0`, hard-coded in
`crates/store/src/backend/rocksdb/main.rs`): a garbage collection pass costs a write
the size of the whole live store. What changed over time is **how often** that
happens.

| Stalwart | When the whole store is rewritten |
|---|---|
| up to v0.16.9 | never — blob GC was off, and deleted mail stayed on disk |
| v0.16.10 – v0.16.25 | on every compaction of the blobs column family: about every **128 MiB of new mail**, whether or not anything had been deleted |
| **v0.16.26** (pinned) | only at a store purge that finds dead blob data of **≥ 256 MiB and ≥ 25 %** of the blob data |

The old behaviour was ours to find: the rewrite volume grew with the store, not with
the garbage, and showed up as a store-sized transfer to the standby every few days
([support.stalw.art/t/1887](https://support.stalw.art/t/rocksdb-blob-gc-since-v0-16-10-rewrites-the-entire-message-store-on-every-l0-compaction-of-the-blobs-cf-blob-gc-age-cutoff-1-0/1887)).
Upstream fixed it in v0.16.26 by switching automatic blob GC off and running it from
the store purge instead, behind the two thresholds
([commit 92c99813](https://github.com/stalwartlabs/stalwart/commit/92c998138)).

Measured on v0.16.25 (local Docker, upstream defaults), the behaviour that is gone:
loading 2.75 GiB into an empty store rewrote 15.9 GiB; 2 GiB of new mail on a
10.8 GB store rewrote 59 GiB (29 times the new mail); the disk peaked at about
twice the store during a rewrite. The v0.16.26 row above is read from the source at
the tag.

What this means for an install, whatever its size:

- **A rewrite still happens, and it is still the size of the store** — but only
  after a quarter of the store has been deleted. A store that mostly grows may go
  months without one; a store with heavy churn (large mailboxes emptied, tenants
  offboarded, short retention) gets one each time the dead share passes 25 %.
- **Disk headroom:** old blob files are deleted only when the rewrite finishes, so a
  mail node needs **free space at least the size of its mail data** for the moment
  it happens. The mail health check reports this as **Disk headroom** and alerts
  when a node falls short. Between rewrites, plan for deleted mail that is still on
  disk: up to the larger of 256 MiB and a quarter of the blob data.
- **Standby replication and backups** copy whole files. After a rewrite the standby
  sync re-transfers the entire store across the network. The standby keeps its
  previous complete copy until that sync finishes, so the copy ages but never
  disappears; the **Standby copies** health check alerts when it is older than the
  target (see [MAIL_HA_FAILOVER.md](MAIL_HA_FAILOVER.md)). On a metered link, budget
  a store-sized transfer per rewrite; the sync's bandwidth can be capped
  (`mail-standby-settings` ConfigMap, same page).
- **Imports and migrations** should no longer pay for it: with automatic blob GC
  off, new mail is written once. (Up to v0.16.25 an import cost roughly quadratic
  writes, each ~128 MiB step rewriting everything imported so far.)

Neither threshold nor the cutoff is configurable. RocksDB itself is working on
garbage-ratio-driven blob GC
([facebook/rocksdb#15301](https://github.com/facebook/rocksdb/issues/15301)), which
would rewrite only the files that hold garbage.

## Do not set `holdSamplesFor` too low

It is a disk knob with an anti-spam cost:

- **Routine `train` (12-hourly): unaffected.** It resumes from the persisted
  trainer blob (`trainer.last_id`) and only reads samples newer than the last run.
- **`retrain`: degraded.** It rebuilds from a *fresh* trainer over whatever samples
  still exist — a shorter window means a smaller corpus.
- **`retrain` can silently abort.** The gate is
  `reservoir.ham.total_seen < minHamSamples (100) || reservoir.spam.total_seen < minSpamSamples (100)`,
  logged as `Not enough samples for training`. Combined with a `reset`, a
  too-short window leaves the server with **no classifier at all**.

The floor is "how long does this server take to see 100 ham **and** 100 spam".
30 d clears it comfortably for anything with real traffic; 1–7 d is risky on a
low-volume install.

## Manual reclaim (rare)

Trigger: offboarding a very large mailbox while the mail node is under disk
pressure, or an install that predates the automatic purge. Otherwise do nothing —
monitoring and node headroom absorb normal churn.

1. **Drop the references first.** Forcing compaction before the references are gone
   reclaims *nothing* — this is the mistake that made the old version of this
   runbook ineffective.

   ```text
   # per principal, repeat until "destroyed" comes back empty
   x:SpamTrainingSample/query  {"filter":{"accountId":"<principalId>"},"limit":200}
   x:SpamTrainingSample/set    {"#destroy": <back-reference to /ids>}
   ```

2. **Purge blobs across all shards.** Enqueue a `Task`/`StoreMaintenance` with
   `maintenanceType: purgeBlob` and **no** `shardIndex` — it fans out to all 256.
   Passing `shardIndex: 0` covers 1/256 of the keyspace and looks like a no-op.

3. **Let the store count the garbage, then run the store purge.** From v0.16.26
   blob files are rewritten only by the data-store purge, and only when dead blob
   data is at least 256 MiB and at least 25 % of the blob data. RocksDB counts a
   deleted blob as dead once a compaction has processed the delete — on a live
   server about every 128 MiB of new mail — so a purge run straight after step 2
   may still see none. Follow it in the RocksDB log:

   ```bash
   kubectl -n mail exec deploy/stalwart-mail -c stalwart -- \
     grep -E 'Blob file count' /var/lib/stalwart/data/LOG | tail -3
   ```

   `Blob file count / total size / garbage size` is what the purge compares. When
   the garbage is over both marks, enqueue a `Task`/`StoreMaintenance` with
   `maintenanceType: purgeData` (or wait for the scheduled one): the blob files are
   rewritten and the total drops by the garbage.

4. **Below the thresholds nothing is rewritten**, however long you wait. The offline
   `ldb … compact` this runbook used to give for a critically full node no longer
   reclaims message data on its own: the stored options have blob GC off, so it
   compacts the index and leaves the blob files as they are. Running it with blob GC
   switched on from the command line has not been tested against v0.16.26 — on a
   node that is out of space, free room another way first (move the standby copy or
   another tenant's data off the node), then follow steps 1–3.

> **Diagnostic tip.** `garbage size: 0.0 GB` in the RocksDB log does **not** prove
> the purge failed — it is equally consistent with "deletes issued, not yet
> compacted". Read the per-shard purge counters instead: add a `Tracer` of
> `@type: Stdout` with `eventsPolicy: include`,
> `events: {"store.blob-store-purged": true}`, and each shard logs `expires`
> (purged) / `total` (still referenced).
