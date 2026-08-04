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
`BlobLink::Temporary { until }` stamped *at ingest* as `midnight + holdSamplesFor`
— **180 days** on an upstream-default install. Destroying the account does **not**
release them: Stalwart's `destroy_account_blobs` unlinks only `Email` / `FileNode`
/ `SieveScript` hard links. The bytes stay on the mail PVC, invisibly — the mailbox
is gone and the account quota reads 0 B.

Once the last reference goes, the rest is automatic:

1. **Blob purge** (`purgeBlob`, daily 04:00 by default) deletes the blob key — and,
   for an expired temporary link, the `SpamTrainingSample` row with it.
2. **Compaction** turns those deletes into reclaimed bytes. RocksDB blob GC is
   enabled on the blobs CF from Stalwart **v0.16.10**
   ([commit 69c2b052](https://github.com/stalwartlabs/stalwart/commit/69c2b052)),
   so partially-dead blob files are rewritten too. On a server with live mail
   traffic this happens on its own; an idle server waits for the CF's 30-day TTL.

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
  principal (`backend/src/modules/mail-admin/spam-sample-cleanup.ts`). Space
  returns within a compaction cycle instead of six months. Failures are non-fatal
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

3. **Let compaction run.** On a live server, ordinary mail traffic drives it.
   Confirm from the RocksDB log:

   ```bash
   kubectl -n mail exec deploy/stalwart-mail -- \
     grep -E '\[t\] \[JOB' /var/lib/stalwart/LOG | tail -3
   ```

   `Generated table #N: <k> keys` is the authority — `<k>` falling is the purge
   working. `Blob file count / total size / garbage size` in the same log shows the
   reclaim.

4. **Only if the node is critically full**, force compaction offline: suspend the
   Flux `platform` Kustomization, scale `stalwart-mail` to 0, run
   `ldb --db=/var/lib/stalwart --try_load_options compact` with a matching RocksDB
   major version, then scale up and resume Flux.

> **Diagnostic tip.** `garbage size: 0.0 GB` in the RocksDB log does **not** prove
> the purge failed — it is equally consistent with "deletes issued, not yet
> compacted". Read the per-shard purge counters instead: add a `Tracer` of
> `@type: Stdout` with `eventsPolicy: include`,
> `events: {"store.blob-store-purged": true}`, and each shard logs `expires`
> (purged) / `total` (still referenced).
